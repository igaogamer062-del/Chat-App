-- Smart Chat | reparo das funções de autenticação do painel e do condutor
-- Pode ser executado mais de uma vez.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Estruturas usadas pelo painel administrativo.
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

-- Recupera perfis de contas que foram criadas antes da instalação do gatilho.
insert into public.profiles(id, username, full_name)
select
  u.id,
  split_part(u.email, '@', 1),
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u
on conflict do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.profiles(id, username, full_name)
  values (
    new.id,
    split_part(new.email, '@', 1),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.user_has_permission(check_permission text)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    (
      select o.allowed
      from public.user_permission_overrides o
      where o.user_id=auth.uid()
        and o.permission_key=check_permission
    ),
    (
      select r.allowed
      from public.role_permissions r
      join public.profiles p on p.access_role=r.access_role
      where p.id=auth.uid()
        and p.active=true
        and r.permission_key=check_permission
    ),
    false
  );
$$;

-- Permissões atualmente usadas pelo painel do Smart Chat.
insert into public.permissions(permission_key, module_key, label) values
  ('users_manage','usuarios','Criar usuários e alterar função/acesso'),
  ('chatChecklist','checklist_chat','Acessar os atendimentos do Smart Chat'),
  ('checklist_chat','checklist_chat','Atender checklists pelo Smart Chat'),
  ('monitoring_chat','monitoring_chat','Atender condutores pelo Chat de Monitoramento'),
  ('bases_admin','bases','Criar e editar Bases e Transportadoras'),
  ('base_operators_manage','bases','Vincular operadores às Bases'),
  ('dashboard_view','dashboard','Ver o Dashboard de chamadas')
on conflict (permission_key) do update
set module_key=excluded.module_key,
    label=excluded.label;

insert into public.role_permissions(access_role, permission_key, allowed)
select role_name, permission_key, allowed
from (values
  ('Administrador','users_manage',true),
  ('Gerente','users_manage',true),
  ('Coordenador','users_manage',false),
  ('Supervisor','users_manage',false),
  ('Lider','users_manage',false),
  ('Operador','users_manage',false),

  ('Administrador','chatChecklist',true),
  ('Gerente','chatChecklist',true),
  ('Coordenador','chatChecklist',true),
  ('Supervisor','chatChecklist',true),
  ('Lider','chatChecklist',true),
  ('Operador','chatChecklist',true),

  ('Administrador','checklist_chat',true),
  ('Gerente','checklist_chat',true),
  ('Coordenador','checklist_chat',true),
  ('Supervisor','checklist_chat',true),
  ('Lider','checklist_chat',true),
  ('Operador','checklist_chat',true),

  ('Administrador','monitoring_chat',false),
  ('Gerente','monitoring_chat',false),
  ('Coordenador','monitoring_chat',false),
  ('Supervisor','monitoring_chat',true),
  ('Lider','monitoring_chat',true),
  ('Operador','monitoring_chat',true),

  ('Administrador','bases_admin',true),
  ('Gerente','bases_admin',true),
  ('Coordenador','bases_admin',false),
  ('Supervisor','bases_admin',false),
  ('Lider','bases_admin',false),
  ('Operador','bases_admin',false),

  ('Administrador','base_operators_manage',true),
  ('Gerente','base_operators_manage',true),
  ('Coordenador','base_operators_manage',true),
  ('Supervisor','base_operators_manage',false),
  ('Lider','base_operators_manage',false),
  ('Operador','base_operators_manage',false),

  ('Administrador','dashboard_view',true),
  ('Gerente','dashboard_view',true),
  ('Coordenador','dashboard_view',true),
  ('Supervisor','dashboard_view',true),
  ('Lider','dashboard_view',false),
  ('Operador','dashboard_view',false)
) value_list(role_name, permission_key, allowed)
on conflict (access_role, permission_key) do update
set allowed=excluded.allowed;

create or replace function public.my_permissions()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    jsonb_object_agg(
      p.permission_key,
      coalesce(o.allowed, r.allowed, false)
    ),
    '{}'::jsonb
  )
  from public.permissions p
  left join public.profiles pr on pr.id=auth.uid()
  left join public.role_permissions r
    on r.access_role=pr.access_role
   and r.permission_key=p.permission_key
  left join public.user_permission_overrides o
    on o.user_id=auth.uid()
   and o.permission_key=p.permission_key;
$$;

revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- Estrutura e funções de cadastro/login do condutor.
create sequence if not exists public.checklist_number_seq;

create table if not exists public.checklist_driver_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  login text not null unique,
  password_hash text not null,
  session_token uuid not null default gen_random_uuid(),
  notifications boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.checklist_driver_accounts enable row level security;
revoke all on public.checklist_driver_accounts from anon, authenticated;

create or replace function public.register_checklist_driver(
  driver_name text,
  driver_phone text,
  driver_login text,
  driver_password text
)
returns table(
  driver_id uuid,
  session_token uuid,
  full_name text,
  phone text
)
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  created public.checklist_driver_accounts;
  clean_phone text := regexp_replace(driver_phone, '\D', '', 'g');
  clean_login text := lower(trim(driver_login));
begin
  if length(trim(driver_name)) < 3
     or length(clean_phone) < 10
     or length(clean_phone) > 13
     or length(clean_login) < 3
     or length(driver_password) < 6 then
    raise exception 'Dados de cadastro inválidos';
  end if;

  if exists (
    select 1
    from public.checklist_driver_accounts a
    where a.phone=clean_phone
  ) then
    raise exception 'Este número já possui cadastro';
  end if;

  if exists (
    select 1
    from public.checklist_driver_accounts a
    where a.login=clean_login
  ) then
    raise exception 'Este login já está sendo utilizado';
  end if;

  insert into public.checklist_driver_accounts(
    full_name,
    phone,
    login,
    password_hash
  )
  values (
    trim(driver_name),
    clean_phone,
    clean_login,
    crypt(driver_password, gen_salt('bf'))
  )
  returning * into created;

  return query
  select
    created.id,
    created.session_token,
    created.full_name,
    created.phone;
end;
$$;

create or replace function public.login_checklist_driver(
  driver_login text,
  driver_password text
)
returns table(
  driver_id uuid,
  session_token uuid,
  full_name text,
  phone text,
  notifications boolean
)
language sql
security definer
set search_path=public,extensions
as $$
  select
    a.id,
    a.session_token,
    a.full_name,
    a.phone,
    a.notifications
  from public.checklist_driver_accounts a
  where a.login=lower(trim(driver_login))
    and a.password_hash=crypt(driver_password, a.password_hash)
    and a.active=true
  limit 1;
$$;

revoke all on function public.register_checklist_driver(text,text,text,text)
from public;
revoke all on function public.login_checklist_driver(text,text)
from public;

grant execute on function public.register_checklist_driver(text,text,text,text)
to anon, authenticated;
grant execute on function public.login_checklist_driver(text,text)
to anon, authenticated;

-- Mantém o acesso administrativo da conta principal informada no teste.
update public.profiles
set access_role='Administrador', active=true
where id=(
  select id
  from auth.users
  where lower(email)=lower('ygor939@gmail.com')
  limit 1
);

commit;

-- Atualiza imediatamente o cache de funções da API do Supabase.
notify pgrst, 'reload schema';
