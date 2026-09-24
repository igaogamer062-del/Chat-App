-- Chat Checklist PWA: execute após as migrações anteriores.
create extension if not exists pgcrypto;

insert into public.permissions(permission_key,module_key,label) values
  ('chatChecklist','checklist_chat','Acessar os atendimentos do Smart Chat'),
  ('checklist_chat','checklist_chat','Atender checklists pelo Smart Chat')
on conflict (permission_key) do update set module_key=excluded.module_key,label=excluded.label;

insert into public.role_permissions(access_role,permission_key,allowed)
select role_name,permission_key,true
from unnest(array['Administrador','Gerente','Coordenador','Supervisor','Lider','Operador']::text[]) role_name
cross join unnest(array['chatChecklist','checklist_chat']::text[]) permission_key
on conflict (access_role,permission_key) do update set allowed=excluded.allowed;

create table if not exists public.checklist_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  driver_name text not null,
  driver_phone text not null,
  vehicle_plate text not null,
  operator_id uuid not null references public.profiles(id),
  driver_token uuid not null default gen_random_uuid(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checklist_chat_messages_v2 (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.checklist_chat_sessions(id) on delete cascade,
  sender_type text not null check(sender_type in ('driver','operator')),
  sender_id uuid references public.profiles(id),
  body text not null check(length(trim(body)) between 1 and 4000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.checklist_operator_enabled(check_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.profiles p where p.id=check_user and p.active=true
    and coalesce(
      (select o.allowed from public.user_permission_overrides o where o.user_id=p.id and o.permission_key='checklist_chat'),
      (select r.allowed from public.role_permissions r where r.access_role=p.access_role and r.permission_key='checklist_chat'),
      false
    )=true
  );
$$;

alter table public.checklist_chat_sessions enable row level security;
alter table public.checklist_chat_messages_v2 enable row level security;

drop policy if exists checklist_sessions_operator_read on public.checklist_chat_sessions;
drop policy if exists checklist_sessions_operator_update on public.checklist_chat_sessions;
drop policy if exists checklist_messages_operator_read on public.checklist_chat_messages_v2;
drop policy if exists checklist_messages_operator_insert on public.checklist_chat_messages_v2;

create policy checklist_sessions_operator_read on public.checklist_chat_sessions
for select to authenticated using(operator_id=auth.uid() and public.user_has_permission('checklist_chat'));
create policy checklist_sessions_operator_update on public.checklist_chat_sessions
for update to authenticated using(operator_id=auth.uid() and public.user_has_permission('checklist_chat'))
with check(operator_id=auth.uid() and public.user_has_permission('checklist_chat'));
create policy checklist_messages_operator_read on public.checklist_chat_messages_v2
for select to authenticated using(exists(select 1 from public.checklist_chat_sessions s where s.id=session_id and s.operator_id=auth.uid()) and public.user_has_permission('checklist_chat'));
create policy checklist_messages_operator_insert on public.checklist_chat_messages_v2
for insert to authenticated with check(sender_type='operator' and sender_id=auth.uid() and exists(select 1 from public.checklist_chat_sessions s where s.id=session_id and s.operator_id=auth.uid()) and public.user_has_permission('checklist_chat'));

create or replace function public.start_checklist_chat(driver_name text,driver_phone text,vehicle_plate text,selected_operator uuid)
returns table(session_id uuid,driver_token uuid,operator_name text)
language plpgsql security definer set search_path='public' as $$
declare created public.checklist_chat_sessions;
begin
  if length(trim(driver_name))<2 or length(trim(driver_phone))<8 or length(trim(vehicle_plate))<5 then raise exception 'Dados do condutor incompletos'; end if;
  if not public.checklist_operator_enabled(selected_operator) then raise exception 'Operador indisponível'; end if;
  insert into public.checklist_chat_sessions(driver_name,driver_phone,vehicle_plate,operator_id) values(trim(driver_name),trim(driver_phone),upper(trim(vehicle_plate)),selected_operator) returning * into created;
  return query select created.id,created.driver_token,(select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id);
end;$$;

create or replace function public.list_checklist_operators()
returns table(id uuid,full_name text,access_role text)
language sql stable security definer set search_path='public' as $$
  select p.id,coalesce(p.full_name,p.username),p.access_role from public.profiles p
  where public.checklist_operator_enabled(p.id) order by coalesce(p.full_name,p.username);
$$;

create or replace function public.send_checklist_driver_message(chat_session uuid,chat_token uuid,message_body text)
returns uuid language plpgsql security definer set search_path='public' as $$
declare message_id uuid;
begin
  if not exists(select 1 from public.checklist_chat_sessions s where s.id=chat_session and s.driver_token=chat_token and s.active=true) then raise exception 'Atendimento inválido'; end if;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body) values(chat_session,'driver',trim(message_body)) returning id into message_id;
  update public.checklist_chat_sessions set updated_at=now() where id=chat_session;
  return message_id;
end;$$;

-- A versão 014 acrescenta a coluna attachment ao retorno. Ao reinstalar o
-- projeto, remova qualquer assinatura anterior antes de criar a versão-base.
drop function if exists public.read_checklist_driver_messages(uuid,uuid);
create function public.read_checklist_driver_messages(chat_session uuid,chat_token uuid)
returns table(id uuid,sender_type text,body text,created_at timestamptz)
language sql security definer set search_path='public' as $$
  select m.id,m.sender_type,m.body,m.created_at from public.checklist_chat_messages_v2 m
  join public.checklist_chat_sessions s on s.id=m.session_id
  where s.id=chat_session and s.driver_token=chat_token order by m.created_at;
$$;

grant execute on function public.start_checklist_chat(text,text,text,uuid) to anon,authenticated;
grant execute on function public.list_checklist_operators() to anon,authenticated;
grant execute on function public.send_checklist_driver_message(uuid,uuid,text) to anon,authenticated;
grant execute on function public.read_checklist_driver_messages(uuid,uuid) to anon,authenticated;
grant execute on function public.checklist_operator_enabled(uuid) to anon,authenticated;

do $$ begin
  alter publication supabase_realtime add table public.checklist_chat_sessions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.checklist_chat_messages_v2;
exception when duplicate_object then null; end $$;
