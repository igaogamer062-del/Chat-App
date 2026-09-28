-- Smart Chat | preparação do aplicativo móvel e roteamento com espera
-- Execute depois de 020_operator_dashboard.sql.

begin;

create extension if not exists pg_cron;
create sequence if not exists public.smart_chat_protocol_seq;

alter table public.checklist_chat_sessions
  add column if not exists driver_auth_user_id uuid references auth.users(id),
  add column if not exists protocol_number text unique,
  add column if not exists routing_status text not null default 'routed',
  add column if not exists wait_until timestamptz,
  add column if not exists next_routing_attempt_at timestamptz,
  add column if not exists closure_reason text;

update public.checklist_chat_sessions
set routing_status='finished'
where active=false and routing_status='routed';

alter table public.checklist_chat_sessions
  drop constraint if exists checklist_chat_sessions_routing_status_check;
alter table public.checklist_chat_sessions
  add constraint checklist_chat_sessions_routing_status_check
  check(routing_status in(
    'routed','awaiting_driver_choice','waiting_operator','closed_not_found',
    'closed_by_driver','closed_timeout','finished'
  ));

create table if not exists public.mobile_driver_profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.smart_chat_evaluations(
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.checklist_chat_sessions(id) on delete cascade,
  driver_auth_user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check(rating between 1 and 5),
  comment text check(comment is null or length(comment)<=1000),
  created_at timestamptz not null default now()
);

alter table public.mobile_driver_profiles enable row level security;
alter table public.smart_chat_evaluations enable row level security;

create index if not exists checklist_chat_sessions_driver_auth_idx
  on public.checklist_chat_sessions(driver_auth_user_id,created_at desc);
create index if not exists checklist_chat_sessions_waiting_idx
  on public.checklist_chat_sessions(routing_status,next_routing_attempt_at)
  where active=true;

drop policy if exists mobile_driver_profile_own_read on public.mobile_driver_profiles;
create policy mobile_driver_profile_own_read on public.mobile_driver_profiles
for select to authenticated using(id=auth.uid());

drop policy if exists mobile_driver_profile_own_update on public.mobile_driver_profiles;
create policy mobile_driver_profile_own_update on public.mobile_driver_profiles
for update to authenticated using(id=auth.uid()) with check(id=auth.uid());

drop policy if exists smart_chat_evaluation_own_read on public.smart_chat_evaluations;
create policy smart_chat_evaluation_own_read on public.smart_chat_evaluations
for select to authenticated using(driver_auth_user_id=auth.uid());

drop policy if exists checklist_sessions_mobile_own_read on public.checklist_chat_sessions;
create policy checklist_sessions_mobile_own_read on public.checklist_chat_sessions
for select to authenticated using(driver_auth_user_id=auth.uid());

drop policy if exists checklist_messages_mobile_own_read on public.checklist_chat_messages_v2;
create policy checklist_messages_mobile_own_read on public.checklist_chat_messages_v2
for select to authenticated using(
  exists(
    select 1 from public.checklist_chat_sessions s
    where s.id=checklist_chat_messages_v2.session_id and s.driver_auth_user_id=auth.uid()
  )
);

-- O aplicativo chama esta função depois do login Google ou telefone.
create or replace function public.sync_mobile_driver_profile()
returns public.mobile_driver_profiles
language plpgsql security definer set search_path=public,auth as $$
declare
  auth_row auth.users;
  result public.mobile_driver_profiles;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  select * into auth_row from auth.users where id=auth.uid();
  insert into public.mobile_driver_profiles(id,full_name,phone,email,updated_at)
  values(
    auth.uid(),
    coalesce(nullif(trim(auth_row.raw_user_meta_data->>'full_name'),''),nullif(trim(auth_row.raw_user_meta_data->>'name'),'')),
    nullif(regexp_replace(coalesce(auth_row.phone,''),'\D','','g'),''),
    auth_row.email,
    now()
  )
  on conflict(id) do update set
    full_name=coalesce(excluded.full_name,public.mobile_driver_profiles.full_name),
    phone=coalesce(excluded.phone,public.mobile_driver_profiles.phone),
    email=coalesce(excluded.email,public.mobile_driver_profiles.email),
    updated_at=now()
  returning * into result;
  return result;
end;
$$;

-- Cria a solicitação do aplicativo e nunca deixa uma conversa sem operador visível no painel.
create or replace function public.start_mobile_smart_chat(
  service_kind text,
  reported_name text,
  vehicle_plate text,
  tracker_technology text
)
returns table(
  session_id uuid,
  protocol text,
  routing_state text,
  notice text,
  waiting_deadline timestamptz,
  assigned_operator uuid
)
language plpgsql security definer set search_path=public,auth as $$
declare
  profile_row public.mobile_driver_profiles;
  fleet public.mock_fleet_drivers;
  target_base uuid;
  chosen uuid;
  created public.checklist_chat_sessions;
  generated_protocol text;
  user_phone text;
  invalid_data boolean := false;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if service_kind not in('checklist','monitoring') then raise exception 'Tipo de atendimento inválido'; end if;
  if length(trim(reported_name))<3 or length(trim(vehicle_plate))<5 or length(trim(tracker_technology))<2 then
    raise exception 'Preencha nome, placa e tecnologia';
  end if;

  perform public.sync_mobile_driver_profile();
  select * into profile_row from public.mobile_driver_profiles where id=auth.uid() and active;
  if profile_row.id is null then raise exception 'Cadastro do condutor inativo'; end if;
  user_phone := coalesce(profile_row.phone,profile_row.email,'Conta autenticada');

  select * into created from public.checklist_chat_sessions s
  where s.driver_auth_user_id=auth.uid() and s.active
  order by s.created_at desc limit 1;
  if created.id is not null then
    return query select created.id,created.protocol_number,created.routing_status,
      created.routing_note,created.wait_until,created.operator_id;
    return;
  end if;

  generated_protocol := 'CHAT-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.smart_chat_protocol_seq')::text,6,'0');

  select * into fleet from public.mock_fleet_drivers f
  where upper(regexp_replace(f.plate,'[- ]','','g'))=upper(regexp_replace(vehicle_plate,'[- ]','','g'))
  limit 1;
  if fleet.id is null then invalid_data := true; end if;

  if not invalid_data and service_kind='checklist' then
    select id into target_base from public.operation_bases
    where lower(name)=lower('Checklist') and active limit 1;
    if target_base is null then invalid_data := true; end if;
  elsif not invalid_data then
    select bc.base_id into target_base
    from public.base_carriers bc
    join public.operation_bases b on b.id=bc.base_id and b.active
    join public.carriers c on c.id=bc.carrier_id and c.active
    where bc.carrier_id=fleet.carrier_id limit 1;
    if target_base is null then invalid_data := true; end if;
  end if;

  if invalid_data then
    insert into public.checklist_chat_sessions(
      driver_name,driver_phone,vehicle_plate,driver_auth_user_id,technology,
      service_type,active,status,finished_at,protocol_number,routing_status,
      routing_note,closure_reason
    ) values(
      trim(reported_name),user_phone,upper(trim(vehicle_plate)),auth.uid(),trim(tracker_technology),
      service_kind,false,'Não localizado',now(),generated_protocol,'closed_not_found',
      'Não encontrado registros as informações apresentadas','Dados não localizados'
    ) returning * into created;
    insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
    values(created.id,'bot','Não encontrado registros as informações apresentadas');
    return query select created.id,created.protocol_number,created.routing_status,
      created.routing_note,null::timestamptz,null::uuid;
    return;
  end if;

  select p.id into chosen
  from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
  where public.operator_enabled(p.id,case when service_kind='monitoring' then 'monitoring_chat' else 'checklist_chat' end)
    and p.last_seen_at>now()-interval '2 minutes'
  order by(
    select count(*) from public.checklist_chat_sessions open_session
    where open_session.operator_id=p.id and open_session.active
  ),random() limit 1;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,driver_auth_user_id,
    technology,service_type,base_id,carrier_id,accepted_at,protocol_number,
    routing_status,routing_note,status
  ) values(
    trim(reported_name),user_phone,upper(trim(vehicle_plate)),chosen,auth.uid(),
    trim(tracker_technology),service_kind,target_base,fleet.carrier_id,
    case when chosen is not null then now() else null end,generated_protocol,
    case when chosen is not null then 'routed' else 'awaiting_driver_choice' end,
    case when chosen is not null then 'Atendimento encaminhado' else 'Aguardando decisão do condutor' end,
    case when chosen is not null then 'Em atendimento' else 'Aguardando decisão' end
  ) returning * into created;

  if chosen is not null then
    insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
    values(created.id,'bot','Atendimento encaminhado para a central. Aguarde o operador.');
    return query select created.id,created.protocol_number,created.routing_status,
      'Atendimento encaminhado para a central.'::text,null::timestamptz,chosen;
  else
    insert into public.checklist_chat_messages_v2(session_id,sender_type,body) values
      (created.id,'bot','Infelizmente nossos todos nossos operadores estão ocupados no momento'),
      (created.id,'bot','Quer encerrar o atendimento ou aguardar 5 min até ser atendido?');
    return query select created.id,created.protocol_number,created.routing_status,
      'Infelizmente nossos todos nossos operadores estão ocupados no momento'||chr(10)||
      'Quer encerrar o atendimento ou aguardar 5 min até ser atendido?',null::timestamptz,null::uuid;
  end if;
end;
$$;

create or replace function public.mobile_choose_wait(
  chat_session uuid,
  wait_for_operator boolean
)
returns table(routing_state text,waiting_deadline timestamptz,notice text)
language plpgsql security definer set search_path=public as $$
declare s public.checklist_chat_sessions;
begin
  select * into s from public.checklist_chat_sessions
  where id=chat_session and driver_auth_user_id=auth.uid() and active
    and routing_status='awaiting_driver_choice' for update;
  if s.id is null then raise exception 'Atendimento não encontrado ou decisão já registrada'; end if;

  if not wait_for_operator then
    update public.checklist_chat_sessions set
      active=false,status='Encerrado pelo condutor',routing_status='closed_by_driver',
      closure_reason='Condutor optou por encerrar',finished_at=now(),updated_at=now()
    where id=s.id;
    insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
    values(s.id,'bot','Atendimento encerrado conforme solicitado.');
    return query select 'closed_by_driver'::text,null::timestamptz,'Atendimento encerrado conforme solicitado.'::text;
  else
    update public.checklist_chat_sessions set
      status='Aguardando operador',routing_status='waiting_operator',
      wait_until=now()+interval '5 minutes',next_routing_attempt_at=now(),updated_at=now()
    where id=s.id returning * into s;
    insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
    values(s.id,'bot','Vamos procurar um operador por até 5 minutos. Você será avisado assim que houver disponibilidade.');
    return query select s.routing_status,s.wait_until,
      'Vamos procurar um operador por até 5 minutos.'::text;
  end if;
end;
$$;

-- Executada pelo pg_cron: tenta novamente e encerra após cinco minutos.
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
    for update skip locked
  loop
    if s.wait_until is null or s.wait_until<=now() then
      update public.checklist_chat_sessions set
        active=false,status='Encerrado sem operador',routing_status='closed_timeout',
        closure_reason='Tempo de espera de 5 minutos encerrado',finished_at=now(),updated_at=now()
      where id=s.id;
      insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
      values(s.id,'bot','Não encontramos um operador disponível dentro de 5 minutos. O atendimento foi encerrado.');
      continue;
    end if;

    chosen := null;
    select p.id into chosen
    from public.profiles p
    join public.base_operators bo on bo.user_id=p.id and bo.base_id=s.base_id
    where public.operator_enabled(p.id,case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end)
      and p.last_seen_at>now()-interval '2 minutes'
    order by(
      select count(*) from public.checklist_chat_sessions open_session
      where open_session.operator_id=p.id and open_session.active
    ),random() limit 1;

    if chosen is not null then
      update public.checklist_chat_sessions set
        operator_id=chosen,accepted_at=now(),routing_status='routed',
        routing_note='Operador encontrado durante a espera',status='Em atendimento',
        next_routing_attempt_at=null,updated_at=now()
      where id=s.id;
      insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
      values(s.id,'bot','Um operador ficou disponível. Seu atendimento foi encaminhado.');
    else
      update public.checklist_chat_sessions
      set next_routing_attempt_at=now()+interval '10 seconds',updated_at=now()
      where id=s.id;
    end if;
  end loop;
end;
$$;

create or replace function public.mobile_send_chat_message(chat_session uuid,message_body text)
returns uuid language plpgsql security definer set search_path=public as $$
declare created_id uuid;
begin
  if length(trim(message_body)) not between 1 and 4000 then raise exception 'Mensagem inválida'; end if;
  if not exists(select 1 from public.checklist_chat_sessions s
    where s.id=chat_session and s.driver_auth_user_id=auth.uid() and s.active and s.routing_status='routed')
  then raise exception 'Atendimento indisponível para mensagens'; end if;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(chat_session,'driver',trim(message_body)) returning id into created_id;
  update public.checklist_chat_sessions set updated_at=now() where id=chat_session;
  return created_id;
end;
$$;

create or replace function public.mobile_list_chat_messages(chat_session uuid)
returns table(id uuid,sender_type text,body text,attachment jsonb,created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select m.id,m.sender_type,m.body,m.attachment,m.created_at
  from public.checklist_chat_messages_v2 m
  join public.checklist_chat_sessions s on s.id=m.session_id
  where s.id=chat_session and s.driver_auth_user_id=auth.uid()
  order by m.created_at;
$$;

create or replace function public.mobile_list_service_records()
returns table(
  session_id uuid,protocol text,service_type text,status text,reason text,
  vehicle_plate text,failed_items text[],rescheduled_at timestamptz,
  created_at timestamptz,finished_at timestamptz,routing_status text
)
language sql stable security definer set search_path=public as $$
  select s.id,s.protocol_number,s.service_type,s.status,
    coalesce(s.outcome_reason,s.closure_reason),s.vehicle_plate,s.failed_items,
    s.rescheduled_at,s.created_at,s.finished_at,s.routing_status
  from public.checklist_chat_sessions s
  where s.driver_auth_user_id=auth.uid()
  order by s.created_at desc;
$$;

create or replace function public.mobile_rate_service(chat_session uuid,score smallint,feedback text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if score not between 1 and 5 then raise exception 'Avaliação deve estar entre 1 e 5'; end if;
  if not exists(select 1 from public.checklist_chat_sessions s
    where s.id=chat_session and s.driver_auth_user_id=auth.uid() and not s.active)
  then raise exception 'Atendimento ainda não pode ser avaliado'; end if;
  insert into public.smart_chat_evaluations(session_id,driver_auth_user_id,rating,comment)
  values(chat_session,auth.uid(),score,nullif(trim(feedback),''))
  on conflict(session_id) do update set rating=excluded.rating,comment=excluded.comment,created_at=now();
end;
$$;

-- Gestores podem responder e finalizar qualquer atendimento ativo; Operadores, apenas os próprios.
drop policy if exists checklist_messages_manager_insert on public.checklist_chat_messages_v2;
create policy checklist_messages_manager_insert on public.checklist_chat_messages_v2
for insert to authenticated with check(
  sender_type='operator' and sender_id=auth.uid() and public.is_manager()
);

create or replace function public.can_finish_smart_chat(chat_session uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.checklist_chat_sessions s
    join public.profiles p on p.id=auth.uid() and p.active
    where s.id=chat_session and s.active
      and(s.operator_id=auth.uid() or p.access_role='Gestor')
  );
$$;

create or replace function public.finish_checklist_chat_complete(
  chat_session uuid,
  checklist_status text,
  outcome_reason text default null,
  failed_items text[] default null,
  scheduled_for timestamptz default null
)
returns table(checklist_number text)
language plpgsql security definer set search_path=public as $$
declare
  generated text;
  session_row public.checklist_chat_sessions;
  reason text:=nullif(trim(outcome_reason),'');
  clean_items text[];
begin
  select * into session_row from public.checklist_chat_sessions s
  where s.id=chat_session for update;
  if session_row.id is null or not public.can_finish_smart_chat(chat_session) then
    raise exception 'Atendimento não autorizado';
  end if;
  if not session_row.active then return query select session_row.checklist_number; return; end if;
  if checklist_status not in('Aprovado','Reprovado','Cancelado','Reagendado') then raise exception 'Resultado inválido'; end if;
  if checklist_status<>'Aprovado' and coalesce(length(reason),0)<3 then raise exception 'Informe o motivo'; end if;
  select array_agg(trim(item)) into clean_items
  from unnest(coalesce(failed_items,array[]::text[])) item where length(trim(item))>0;
  if checklist_status='Reprovado' and coalesce(array_length(clean_items,1),0)=0 then
    raise exception 'Informe ao menos um acessório ou item reprovado';
  end if;
  if checklist_status='Reagendado' and(scheduled_for is null or scheduled_for<=now()) then
    raise exception 'Informe uma data futura para o reagendamento';
  end if;
  generated:='CHK-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.checklist_number_seq')::text,4,'0');
  update public.checklist_chat_sessions set
    active=false,status=checklist_status,
    outcome_reason=case when checklist_status='Aprovado' then null else reason end,
    failed_items=case when checklist_status='Reprovado' then clean_items else null end,
    rescheduled_at=case when checklist_status='Reagendado' then scheduled_for else null end,
    checklist_number=generated,finished_at=now(),updated_at=now(),routing_status='finished'
  where id=chat_session;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(chat_session,'bot','Checklist '||generated||' finalizado como '||checklist_status||'.');
  return query select generated;
end;
$$;

create or replace function public.finish_monitoring_chat(
  chat_session uuid,
  outcome text default 'Concluído',
  note text default null
)
returns table(monitoring_number text)
language plpgsql security definer set search_path=public as $$
declare generated text; session_row public.checklist_chat_sessions;
begin
  select * into session_row from public.checklist_chat_sessions s
  where s.id=chat_session and s.service_type='monitoring' for update;
  if session_row.id is null or not public.can_finish_smart_chat(chat_session) then
    raise exception 'Atendimento não autorizado';
  end if;
  if not session_row.active then return query select session_row.checklist_number; return; end if;
  if outcome not in('Concluído','Cancelado') then raise exception 'Resultado inválido'; end if;
  generated:='MON-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.monitoring_number_seq')::text,4,'0');
  update public.checklist_chat_sessions set
    active=false,status=outcome,outcome_reason=nullif(trim(note),''),
    checklist_number=generated,finished_at=now(),updated_at=now(),routing_status='finished'
  where id=chat_session;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(chat_session,'bot','Atendimento '||generated||' encerrado como '||outcome||'.');
  return query select generated;
end;
$$;

grant execute on function public.sync_mobile_driver_profile() to authenticated;
grant execute on function public.start_mobile_smart_chat(text,text,text,text) to authenticated;
grant execute on function public.mobile_choose_wait(uuid,boolean) to authenticated;
grant execute on function public.mobile_send_chat_message(uuid,text) to authenticated;
grant execute on function public.mobile_list_chat_messages(uuid) to authenticated;
grant execute on function public.mobile_list_service_records() to authenticated;
grant execute on function public.mobile_rate_service(uuid,smallint,text) to authenticated;
grant execute on function public.can_finish_smart_chat(uuid) to authenticated;
grant execute on function public.finish_checklist_chat_complete(uuid,text,text,text[],timestamptz) to authenticated;
grant execute on function public.finish_monitoring_chat(uuid,text,text) to authenticated;
revoke all on function public.process_waiting_smart_chats() from public,anon,authenticated;

-- Evita duplicar o job se a migração for executada novamente.
do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='smart-chat-waiting-router' limit 1;
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'smart-chat-waiting-router',
    '10 seconds',
    'select public.process_waiting_smart_chats();'
  );
end;
$$;

commit;
