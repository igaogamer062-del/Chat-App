-- Smart Chat — Núcleo do sistema (autenticação, perfis e permissões)
-- Execute PRIMEIRO, uma única vez, no SQL Editor do Supabase (projeto novo e vazio).
begin;
create extension if not exists pgcrypto;

-- ============================================================
-- PERFIS (um perfil por usuário de auth.users = operador/gestor)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  full_name text,
  access_role text not null default 'Operador'
    check (access_role in ('Administrador','Gerente','Coordenador','Supervisor','Lider','Operador')),
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- Cria o perfil automaticamente quando alguém se cadastra (Supabase Auth)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id, username, full_name)
  values (new.id, split_part(new.email,'@',1), coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end;$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ============================================================
-- PERMISSÕES POR PAPEL (role) + exceções individuais
-- ============================================================
create table if not exists public.permissions (
  permission_key text primary key,
  module_key text,
  label text
);

create table if not exists public.role_permissions (
  access_role text not null,
  permission_key text not null references public.permissions(permission_key) on delete cascade,
  allowed boolean not null default false,
  primary key (access_role, permission_key)
);

create table if not exists public.user_permission_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.permissions(permission_key) on delete cascade,
  allowed boolean not null,
  primary key (user_id, permission_key)
);

create or replace function public.user_has_permission(check_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(
    (select o.allowed from public.user_permission_overrides o where o.user_id=auth.uid() and o.permission_key=check_permission),
    (select r.allowed from public.role_permissions r
       join public.profiles p on p.access_role=r.access_role
       where p.id=auth.uid() and p.active=true and r.permission_key=check_permission),
    false
  );
$$;

create or replace function public.my_permissions()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_object_agg(p.permission_key, coalesce(o.allowed, r.allowed, false)), '{}'::jsonb)
  from public.permissions p
  left join public.profiles pr on pr.id=auth.uid()
  left join public.role_permissions r on r.access_role=pr.access_role and r.permission_key=p.permission_key
  left join public.user_permission_overrides o on o.user_id=auth.uid() and o.permission_key=p.permission_key;
$$;
grant execute on function public.my_permissions() to authenticated;

-- ============================================================
-- RLS básico de profiles
-- ============================================================
alter table public.profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_permission_overrides enable row level security;

drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_all on public.profiles for select to authenticated using (true);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid() and access_role = (select access_role from public.profiles where id = auth.uid()));
-- (o campo access_role só muda por função administrativa abaixo, nunca direto pelo próprio usuário)

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated using (true);
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);

-- ============================================================
-- Presença online (para o dashboard de "operadores ativos")
-- ============================================================
create or replace function public.touch_presence()
returns void language sql security definer set search_path=public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
grant execute on function public.touch_presence() to authenticated;

-- ============================================================
-- Gestão de usuários e acessos (Administrador / Gerente)
-- ============================================================
insert into public.permissions(permission_key, module_key, label) values
  ('users_manage','usuarios','Criar usuários e alterar função/acesso')
on conflict (permission_key) do update set module_key=excluded.module_key, label=excluded.label;

insert into public.role_permissions(access_role, permission_key, allowed)
select role_name, 'users_manage', role_name in ('Administrador','Gerente')
from unnest(array['Administrador','Gerente','Coordenador','Supervisor','Lider','Operador']::text[]) role_name
on conflict (access_role, permission_key) do update set allowed=excluded.allowed;

create or replace function public.admin_set_user_role(target_user uuid, new_role text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.user_has_permission('users_manage') then raise exception 'Sem permissão para alterar acessos'; end if;
  if new_role not in ('Administrador','Gerente','Coordenador','Supervisor','Lider','Operador') then raise exception 'Função inválida'; end if;
  update public.profiles set access_role=new_role where id=target_user;
end;$$;
grant execute on function public.admin_set_user_role(uuid,text) to authenticated;

create or replace function public.admin_set_user_active(target_user uuid, is_active boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.user_has_permission('users_manage') then raise exception 'Sem permissão para alterar acessos'; end if;
  update public.profiles set active=is_active where id=target_user;
end;$$;
grant execute on function public.admin_set_user_active(uuid,boolean) to authenticated;

commit;

-- ============================================================
-- DEPOIS DE EXECUTAR ESTE ARQUIVO:
-- 1) Vá em Authentication > Users no painel do Supabase e crie o primeiro usuário
--    (e-mail e senha) — isso cria automaticamente uma linha em public.profiles.
-- 2) No SQL Editor, rode (trocando o e-mail):
--      update public.profiles set access_role='Administrador'
--      where id = (select id from auth.users where email = 'seu-email@empresa.com');
--    Esse é o seu primeiro Administrador, que poderá promover os demais pelo painel.
-- ============================================================
