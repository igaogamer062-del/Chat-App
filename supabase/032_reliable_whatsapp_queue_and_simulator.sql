-- Smart Chat | fila persistente de WhatsApp e simulador seguro de comandos
begin;

create table if not exists public.tracking_simulator_alerts(
  id uuid primary key default gen_random_uuid(),
  vehicle_id text not null,
  alert_type text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tracking_simulator_active_alert_idx
  on public.tracking_simulator_alerts(vehicle_id,active);

create table if not exists public.tracking_simulator_commands(
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  vehicle_id text not null,
  plate text,
  driver_id text,
  command text not null,
  source text,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tracking_simulator_alerts enable row level security;
alter table public.tracking_simulator_commands enable row level security;
revoke all on public.tracking_simulator_alerts from public,anon,authenticated;
revoke all on public.tracking_simulator_commands from public,anon,authenticated;

-- A fila de WhatsApp não expira enquanto aguarda a base. Somente operadores
-- presentes no painel nos últimos 75 segundos podem receber o atendimento.
create or replace function public.process_waiting_smart_chats()
returns void language plpgsql security definer set search_path=public as $$
declare
  s public.checklist_chat_sessions;
  chosen uuid;
begin
  for s in
    select * from public.checklist_chat_sessions
    where active and routing_status='waiting_operator'
      and coalesce(next_routing_attempt_at,now())<=now()
    order by created_at
    for update skip locked
  loop
    -- Mantém a regra antiga de expiração apenas para canais legados.
    if s.channel<>'whatsapp' and (s.wait_until is null or s.wait_until<=now()) then
      update public.checklist_chat_sessions set
        active=false,status='Encerrado sem operador',routing_status='closed_timeout',
        closure_reason='Tempo de espera encerrado',finished_at=now(),updated_at=now()
      where id=s.id;
      insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
      values(s.id,'bot','Não encontramos um operador disponível dentro do prazo. O atendimento foi encerrado.');
      continue;
    end if;

    chosen := null;
    select p.id into chosen
    from public.profiles p
    join public.base_operators bo on bo.user_id=p.id and bo.base_id=s.base_id
    where public.operator_enabled(
        p.id,
        case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end
      )
      and p.chat_available
      and p.chat_presence_at>now()-interval '75 seconds'
    order by random()
    limit 1;

    if chosen is not null then
      update public.checklist_chat_sessions set
        operator_id=chosen,accepted_at=now(),routing_status='routed',
        routing_note='Operador disponível encontrado na base',status='Em atendimento',
        wait_until=null,next_routing_attempt_at=null,updated_at=now()
      where id=s.id;

      update public.vehicle_unlock_requests set
        operator_id=chosen,updated_at=now()
      where session_id=s.id;

      insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
      values(s.id,'bot','Um operador ficou disponível. Seu atendimento foi encaminhado.');
    else
      update public.checklist_chat_sessions set
        next_routing_attempt_at=now()+interval '10 seconds',updated_at=now()
      where id=s.id;
    end if;
  end loop;
end;
$$;

commit;
