-- Smart Chat | criação forçada das RPCs ausentes
-- Projeto esperado: lslwhvxrxzuobtmjqpfs
-- Este arquivo não usa uma transação única para facilitar o diagnóstico.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

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
revoke all on table public.checklist_driver_accounts from anon, authenticated;

create or replace function public.my_permissions()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    jsonb_object_agg(
      permission_row.permission_key,
      coalesce(user_override.allowed, role_rule.allowed, false)
    ),
    '{}'::jsonb
  )
  from public.permissions permission_row
  left join public.profiles current_profile
    on current_profile.id=auth.uid()
  left join public.role_permissions role_rule
    on role_rule.access_role=current_profile.access_role
   and role_rule.permission_key=permission_row.permission_key
  left join public.user_permission_overrides user_override
    on user_override.user_id=auth.uid()
   and user_override.permission_key=permission_row.permission_key;
$$;

revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

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
    from public.checklist_driver_accounts account_row
    where account_row.phone=clean_phone
  ) then
    raise exception 'Este número já possui cadastro';
  end if;

  if exists (
    select 1
    from public.checklist_driver_accounts account_row
    where account_row.login=clean_login
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
    extensions.crypt(driver_password, extensions.gen_salt('bf'))
  )
  returning * into created;

  return query
  select created.id, created.session_token, created.full_name, created.phone;
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
    account_row.id,
    account_row.session_token,
    account_row.full_name,
    account_row.phone,
    account_row.notifications
  from public.checklist_driver_accounts account_row
  where account_row.login=lower(trim(driver_login))
    and account_row.password_hash=extensions.crypt(
      driver_password,
      account_row.password_hash
    )
    and account_row.active=true
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

notify pgrst, 'reload schema';

-- O resultado final precisa mostrar TRUE nas três colunas.
select
  to_regprocedure('public.my_permissions()') is not null
    as my_permissions_criada,
  to_regprocedure(
    'public.register_checklist_driver(text,text,text,text)'
  ) is not null as cadastro_condutor_criado,
  to_regprocedure(
    'public.login_checklist_driver(text,text)'
  ) is not null as login_condutor_criado;
