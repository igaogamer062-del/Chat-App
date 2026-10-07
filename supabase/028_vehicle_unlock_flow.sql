-- Smart Chat | fluxo seguro e auditável de desbloqueio de veículo
begin;

create extension if not exists pgcrypto;

alter table public.external_driver_directory
  add column if not exists external_vehicle_id text,
  add column if not exists cpf_last4_hash text;

create sequence if not exists public.unlock_request_number_seq;

create table if not exists public.vehicle_unlock_requests(
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique default (
    'UNLOCK-' || to_char(clock_timestamp() at time zone 'America/Sao_Paulo','YYYYMMDD') || '-' ||
    lpad(nextval('public.unlock_request_number_seq')::text,6,'0')
  ),
  whatsapp_contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  external_driver_id uuid not null references public.external_driver_directory(id),
  session_id uuid references public.checklist_chat_sessions(id) on delete set null,
  operator_id uuid references public.profiles(id) on delete set null,
  vehicle_id text,
  plate text,
  driver_name text not null,
  phone_e164 text,
  carrier_name text,
  intent text not null default 'DESBLOQUEIO',
  original_message text,
  status text not null default 'UNLOCK_REQUESTED' check(status in(
    'UNLOCK_REQUESTED','ALERT_CHECKING','BLOCKED_BY_ACTIVE_ALERT',
    'AUTHENTICATION_REQUIRED','AUTHENTICATED','AWAITING_CONFIRMATION',
    'COMMAND_SENDING','COMMAND_SENT_TO_VEHICLE','COMMAND_FAILED',
    'TRANSFERRED_TO_OPERATOR','COMPLETED'
  )),
  has_active_alert boolean,
  alert_types text[] not null default array[]::text[],
  auth_attempts smallint not null default 0 check(auth_attempts between 0 and 3),
  authenticated_at timestamptz,
  confirmed_at timestamptz,
  command_sent_at timestamptz,
  transferred_at timestamptz,
  completed_at timestamptz,
  handoff_reason text,
  command_result jsonb not null default '{}'::jsonb,
  source text not null default 'SMART_CHAT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vehicle_unlock_requests_contact_idx
  on public.vehicle_unlock_requests(whatsapp_contact_id,created_at desc);
create index if not exists vehicle_unlock_requests_session_idx
  on public.vehicle_unlock_requests(session_id) where session_id is not null;

alter table public.vehicle_unlock_requests enable row level security;

drop policy if exists unlock_requests_staff_read on public.vehicle_unlock_requests;
create policy unlock_requests_staff_read on public.vehicle_unlock_requests for select to authenticated
using(
  public.is_manager() or operator_id=auth.uid() or exists(
    select 1 from public.checklist_chat_sessions s
    where s.id=session_id and s.operator_id=auth.uid()
  )
);

create or replace function public.route_unlock_handoff(
  unlock_request uuid,
  handoff_reason text
)
returns table(session_id uuid,operator_id uuid,operator_name text)
language plpgsql security definer set search_path=public as $$
declare
  request_row public.vehicle_unlock_requests;
  driver public.external_driver_directory;
  target_base uuid;
  chosen uuid;
  created public.checklist_chat_sessions;
  context_message text;
begin
  select * into request_row from public.vehicle_unlock_requests
  where id=unlock_request for update;
  if request_row.id is null then raise exception 'Solicitação não encontrada'; end if;

  if request_row.session_id is not null then
    return query select request_row.session_id,request_row.operator_id,
      (select coalesce(p.full_name,p.username) from public.profiles p where p.id=request_row.operator_id);
    return;
  end if;

  select * into driver from public.external_driver_directory
  where id=request_row.external_driver_id;

  select bc.base_id into target_base from public.base_carriers bc
  join public.operation_bases b on b.id=bc.base_id and b.active
  where bc.carrier_id=driver.carrier_id limit 1;

  if target_base is null then
    select b.id into target_base from public.operation_bases b
    where lower(b.name)=lower('Diversos') and b.active limit 1;
  end if;

  select p.id into chosen from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
  where public.operator_enabled(p.id,'monitoring_chat')
    and p.last_seen_at>now()-interval '5 minutes'
  order by random() limit 1;

  -- Uma ocorrência de segurança não pode desaparecer se todos estiverem offline.
  -- Nesse caso ela fica atribuída a um operador habilitado e aparece quando ele entrar.
  if chosen is null then
    select p.id into chosen from public.profiles p
    join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
    where public.operator_enabled(p.id,'monitoring_chat')
    order by random() limit 1;
  end if;

  if target_base is null or chosen is null then
    update public.vehicle_unlock_requests set
      handoff_reason=route_unlock_handoff.handoff_reason,
      transferred_at=now(),updated_at=now()
    where id=request_row.id;
    return;
  end if;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,technology,service_type,
    base_id,carrier_id,carrier_name_snapshot,accepted_at,routing_note,status,
    channel,whatsapp_contact_id
  ) values(
    request_row.driver_name,request_row.phone_e164,coalesce(request_row.plate,'NÃO INFORMADA'),chosen,
    coalesce(driver.technology,'Não informada'),'monitoring',target_base,driver.carrier_id,
    request_row.carrier_name,now(),'Desbloqueio encaminhado para análise de segurança','Em atendimento',
    'whatsapp',request_row.whatsapp_contact_id
  ) returning * into created;

  context_message := 'ATENDIMENTO — DESBLOQUEIO'||E'\n\n'||
    'Condutor: '||request_row.driver_name||E'\n'||
    'Telefone: '||coalesce(request_row.phone_e164,'Não informado')||E'\n'||
    'Placa: '||coalesce(request_row.plate,'Não informada')||E'\n'||
    'Transportadora: '||coalesce(request_row.carrier_name,'Não informada')||E'\n'||
    'Intenção: DESBLOQUEIO'||E'\n'||
    'Alerta ativo: '||case when request_row.has_active_alert then 'SIM' else 'NÃO/INDETERMINADO' end||E'\n'||
    'Tipo do alerta: '||coalesce(nullif(array_to_string(request_row.alert_types,', '),''),'Não informado')||E'\n'||
    'Status: '||request_row.status||E'\n'||
    'Mensagem original: '||coalesce(request_row.original_message,'Não informada')||E'\n'||
    'Data/hora: '||to_char(request_row.created_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||E'\n'||
    'Request ID: '||request_row.request_id||E'\n'||
    'Motivo do encaminhamento: '||route_unlock_handoff.handoff_reason;

  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(created.id,'bot',context_message);

  update public.vehicle_unlock_requests set
    session_id=created.id,operator_id=chosen,
    handoff_reason=route_unlock_handoff.handoff_reason,
    transferred_at=now(),updated_at=now()
  where id=request_row.id;

  update public.whatsapp_contacts set state='in_service',last_seen_at=now()
  where id=request_row.whatsapp_contact_id;

  return query select created.id,chosen,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=chosen);
end;
$$;

revoke all on public.vehicle_unlock_requests from anon,authenticated;
grant select on public.vehicle_unlock_requests to authenticated;
revoke execute on function public.route_unlock_handoff(uuid,text) from public,anon,authenticated;
grant execute on function public.route_unlock_handoff(uuid,text) to service_role;

commit;
