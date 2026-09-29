-- Smart Chat | diretório de condutores vindo da API externa do Lovable
-- Execute depois de 023_carriers_management.sql.

begin;

create table if not exists public.external_driver_directory(
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  full_name text not null,
  carrier_name text,
  carrier_id uuid references public.carriers(id) on delete set null,
  active boolean not null default true,
  raw_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(provider,external_id)
);

create index if not exists external_driver_directory_name_idx
  on public.external_driver_directory(lower(full_name));
create index if not exists external_driver_directory_carrier_idx
  on public.external_driver_directory(carrier_id) where active;

alter table public.external_driver_directory enable row level security;
drop policy if exists external_driver_directory_manager_read on public.external_driver_directory;
create policy external_driver_directory_manager_read on public.external_driver_directory
for select to authenticated using(public.is_manager());

-- O aplicativo valida pelo nome vindo da API. Placa e tecnologia permanecem
-- dados informativos digitados pelo condutor.
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
  external_driver public.external_driver_directory;
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

  select * into external_driver
  from public.external_driver_directory d
  where d.active
    and lower(regexp_replace(trim(d.full_name),'\s+',' ','g'))=
        lower(regexp_replace(trim(reported_name),'\s+',' ','g'))
  order by d.synced_at desc
  limit 1;
  if external_driver.id is null then invalid_data := true; end if;

  if not invalid_data and service_kind='checklist' then
    select id into target_base from public.operation_bases
    where lower(name)=lower('Checklist') and active limit 1;
    if target_base is null then invalid_data := true; end if;
  elsif not invalid_data then
    select bc.base_id into target_base
    from public.base_carriers bc
    join public.operation_bases b on b.id=bc.base_id and b.active
    join public.carriers c on c.id=bc.carrier_id and c.active
    where bc.carrier_id=external_driver.carrier_id limit 1;
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
    technology,service_type,base_id,carrier_id,carrier_name_snapshot,accepted_at,protocol_number,
    routing_status,routing_note,status
  ) values(
    trim(reported_name),user_phone,upper(trim(vehicle_plate)),chosen,auth.uid(),
    trim(tracker_technology),service_kind,target_base,external_driver.carrier_id,external_driver.carrier_name,
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

grant execute on function public.start_mobile_smart_chat(text,text,text,text) to authenticated;

commit;
