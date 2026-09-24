-- Login do condutor, distribuição automática e conclusão do Chat Checklist.
-- Execute após 012_chat_checklist_pwa.sql.
create extension if not exists pgcrypto with schema extensions;
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

alter table public.checklist_chat_sessions add column if not exists driver_account_id uuid references public.checklist_driver_accounts(id);
alter table public.checklist_chat_sessions add column if not exists technology text;
alter table public.checklist_chat_sessions add column if not exists status text not null default 'Em atendimento';
alter table public.checklist_chat_sessions add column if not exists outcome_reason text;
alter table public.checklist_chat_sessions add column if not exists checklist_number text unique;
alter table public.checklist_chat_sessions add column if not exists finished_at timestamptz;

alter table public.checklist_chat_messages_v2 drop constraint if exists checklist_chat_messages_v2_sender_type_check;
alter table public.checklist_chat_messages_v2 add constraint checklist_chat_messages_v2_sender_type_check check(sender_type in ('driver','operator','bot'));
alter table public.checklist_driver_accounts enable row level security;

create or replace function public.register_checklist_driver(driver_name text,driver_phone text,driver_login text,driver_password text)
returns table(driver_id uuid,session_token uuid,full_name text,phone text)
language plpgsql security definer set search_path='public' as $$
declare created public.checklist_driver_accounts; clean_phone text:=regexp_replace(driver_phone,'\D','','g');
begin
  if length(trim(driver_name))<3 or length(clean_phone)<8 or length(trim(driver_login))<3 or length(driver_password)<6 then raise exception 'Dados de cadastro inválidos'; end if;
  if exists(select 1 from public.checklist_driver_accounts a where a.phone=clean_phone) then raise exception 'Este número já possui cadastro'; end if;
  insert into public.checklist_driver_accounts(full_name,phone,login,password_hash)
  values(trim(driver_name),clean_phone,lower(trim(driver_login)),extensions.crypt(driver_password,extensions.gen_salt('bf'))) returning * into created;
  return query select created.id,created.session_token,created.full_name,created.phone;
end;$$;

create or replace function public.login_checklist_driver(driver_login text,driver_password text)
returns table(driver_id uuid,session_token uuid,full_name text,phone text,notifications boolean)
language sql security definer set search_path='public' as $$
  select a.id,a.session_token,a.full_name,a.phone,a.notifications from public.checklist_driver_accounts a
  where a.login=lower(trim(driver_login)) and a.password_hash=extensions.crypt(driver_password,a.password_hash) and a.active=true limit 1;
$$;

create or replace function public.start_driver_checklist_chat(driver_account uuid,account_token uuid,vehicle_plate text,tracker_technology text)
returns table(session_id uuid,driver_token uuid,operator_id uuid,operator_name text)
language plpgsql security definer set search_path='public' as $$
declare account public.checklist_driver_accounts; chosen uuid; created public.checklist_chat_sessions;
begin
  select * into account from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active=true;
  if account.id is null then raise exception 'Sessão do condutor inválida'; end if;
  select p.id into chosen from public.profiles p where p.active=true and public.checklist_operator_enabled(p.id)
  order by (select count(*) from public.checklist_chat_sessions s where s.operator_id=p.id and s.active=true),p.full_name limit 1;
  if chosen is null then raise exception 'Nenhum operador disponível'; end if;
  insert into public.checklist_chat_sessions(driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,technology)
  values(account.full_name,account.phone,upper(trim(vehicle_plate)),chosen,account.id,trim(tracker_technology)) returning * into created;
  return query select created.id,created.driver_token,created.operator_id,(select coalesce(p.full_name,p.username) from public.profiles p where p.id=chosen);
end;$$;

create or replace function public.finish_checklist_chat(chat_session uuid,checklist_status text,outcome_reason text default null)
returns table(checklist_number text)
language plpgsql security definer set search_path='public' as $$
declare generated text; session_row public.checklist_chat_sessions; message_text text;
begin
  select * into session_row from public.checklist_chat_sessions s where s.id=chat_session and s.operator_id=auth.uid() and s.active=true;
  if session_row.id is null or not public.user_has_permission('checklist_chat') then raise exception 'Atendimento não autorizado'; end if;
  if checklist_status not in ('Aprovado','Reprovado','Cancelado') then raise exception 'Resultado inválido'; end if;
  if checklist_status<>'Aprovado' and length(trim(coalesce(outcome_reason,'')))<3 then raise exception 'Informe o motivo'; end if;
  generated:='CHK-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.checklist_number_seq')::text,4,'0');
  update public.checklist_chat_sessions set active=false,status=checklist_status,outcome_reason=nullif(trim(outcome_reason),''),checklist_number=generated,finished_at=now(),updated_at=now() where id=chat_session;
  message_text:='Checklist '||generated||' finalizado como '||checklist_status||'.';
  if checklist_status<>'Aprovado' then message_text:=message_text||' Consulte o motivo na aba Registros.'; end if;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body) values(chat_session,'bot',message_text);
  return query select generated;
end;$$;

create or replace function public.list_driver_checklist_records(driver_account uuid,account_token uuid)
returns table(checklist_number text,status text,reason text,vehicle_plate text,finished_at timestamptz)
language sql security definer set search_path='public' as $$
  select s.checklist_number,s.status,s.outcome_reason,s.vehicle_plate,s.finished_at
  from public.checklist_chat_sessions s join public.checklist_driver_accounts a on a.id=s.driver_account_id
  where a.id=driver_account and a.session_token=account_token and s.active=false and s.checklist_number is not null order by s.finished_at desc;
$$;

grant execute on function public.register_checklist_driver(text,text,text,text) to anon,authenticated;
grant execute on function public.login_checklist_driver(text,text) to anon,authenticated;
grant execute on function public.start_driver_checklist_chat(uuid,uuid,text,text) to anon,authenticated;
grant execute on function public.finish_checklist_chat(uuid,text,text) to authenticated;
grant execute on function public.list_driver_checklist_records(uuid,uuid) to anon,authenticated;
revoke all on public.checklist_driver_accounts from anon,authenticated;
