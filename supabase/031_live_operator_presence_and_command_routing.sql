-- Smart Chat | presença real do operador e fila segura de WhatsApp
begin;

alter table public.profiles
  add column if not exists chat_available boolean not null default false,
  add column if not exists chat_presence_at timestamptz;

create index if not exists profiles_live_chat_presence_idx
  on public.profiles(chat_available,chat_presence_at)
  where active and chat_enabled;

create or replace function public.set_chat_presence(is_available boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then return; end if;
  update public.profiles set
    chat_available=is_available,
    chat_presence_at=now(),
    last_seen_at=now()
  where id=auth.uid();
end;
$$;

create or replace function public.touch_presence()
returns void language plpgsql security definer set search_path=public as $$
declare
  current_user_id uuid := auth.uid();
  pending_session uuid;
begin
  if current_user_id is null then return; end if;

  update public.profiles set
    chat_available=true,
    chat_presence_at=now(),
    last_seen_at=now()
  where id=current_user_id;

  -- Recupera uma conversa sem operador ou presa em alguém que saiu do painel.
  select s.id into pending_session
  from public.checklist_chat_sessions s
  join public.base_operators bo
    on bo.base_id=s.base_id and bo.user_id=current_user_id
  left join public.profiles assigned on assigned.id=s.operator_id
  where s.active
    and s.channel='whatsapp'
    and (
      s.operator_id is null
      or assigned.id is null
      or assigned.active=false
      or assigned.chat_enabled=false
      or assigned.chat_available=false
      or assigned.chat_presence_at is null
      or assigned.chat_presence_at<=now()-interval '75 seconds'
    )
    and public.operator_enabled(
      current_user_id,
      case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end
    )
  order by s.created_at
  for update of s skip locked
  limit 1;

  if pending_session is not null then
    update public.checklist_chat_sessions set
      operator_id=current_user_id,
      accepted_at=now(),
      routing_status='routed',
      routing_note=null,
      status='Em atendimento',
      updated_at=now()
    where id=pending_session;

    update public.vehicle_unlock_requests set
      operator_id=current_user_id,
      updated_at=now()
    where session_id=pending_session;

    insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
    values(pending_session,'bot','Atendimento direcionado para um operador disponível da base.');
  end if;
end;
$$;

grant execute on function public.set_chat_presence(boolean) to authenticated;
grant execute on function public.touch_presence() to authenticated;

create or replace function public.route_whatsapp_chat(
  contact_id uuid,
  service_kind text
)
returns table(session_id uuid,routing_state text,operator_name text,notice text)
language plpgsql security definer set search_path=public as $$
declare
  contact public.whatsapp_contacts;
  driver public.external_driver_directory;
  target_base uuid;
  chosen uuid;
  created public.checklist_chat_sessions;
begin
  if service_kind not in('checklist','monitoring') then
    raise exception 'Tipo de atendimento inválido';
  end if;

  select * into contact from public.whatsapp_contacts where id=contact_id for update;
  if contact.id is null then raise exception 'Contato não encontrado'; end if;

  select * into driver from public.external_driver_directory
  where id=contact.external_driver_id and active;
  if driver.id is null then
    return query select null::uuid,'not_found'::text,null::text,
      'Não encontramos seus dados no cadastro de condutores.'::text;
    return;
  end if;

  select * into created from public.checklist_chat_sessions s
  where s.whatsapp_contact_id=contact.id and s.active
  order by s.created_at desc limit 1;
  if created.id is not null then
    return query select created.id,
      case when created.operator_id is null then 'queued' else 'routed' end,
      (select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id),
      case when created.operator_id is null
        then 'Seu atendimento está aguardando um operador disponível da base.'
        else 'Você já possui um atendimento em andamento.' end;
    return;
  end if;

  if service_kind='checklist' then
    select b.id into target_base from public.operation_bases b
    where lower(b.name)=lower('Checklist') and b.active limit 1;
  else
    select bc.base_id into target_base from public.base_carriers bc
    join public.operation_bases b on b.id=bc.base_id and b.active
    where bc.carrier_id=driver.carrier_id limit 1;
  end if;

  if target_base is null then
    return query select null::uuid,'not_found'::text,null::text,
      'Não foi possível identificar a base responsável por sua operação.'::text;
    return;
  end if;

  select p.id into chosen
  from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
  where public.operator_enabled(
      p.id,
      case when service_kind='monitoring' then 'monitoring_chat' else 'checklist_chat' end
    )
    and p.chat_available
    and p.chat_presence_at>now()-interval '75 seconds'
  order by random()
  limit 1;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,technology,service_type,
    base_id,carrier_id,carrier_name_snapshot,accepted_at,routing_note,status,
    routing_status,channel,whatsapp_contact_id
  ) values(
    driver.full_name,contact.phone_e164,coalesce(driver.vehicle_plate,'NÃO INFORMADA'),chosen,
    coalesce(driver.technology,'Não informada'),service_kind,target_base,driver.carrier_id,
    driver.carrier_name,case when chosen is null then null else now() end,
    case when chosen is null then 'Aguardando operador disponível da base' else 'Atendimento recebido pelo WhatsApp' end,
    case when chosen is null then 'Aguardando operador' else 'Em atendimento' end,
    case when chosen is null then 'waiting_operator' else 'routed' end,
    'whatsapp',contact.id
  ) returning * into created;

  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(created.id,'bot',case when chosen is null
    then 'Atendimento solicitado pelo WhatsApp e colocado na fila da base.'
    else 'Atendimento solicitado pelo WhatsApp e encaminhado ao operador.' end);

  update public.whatsapp_contacts set state='in_service',last_seen_at=now()
  where id=contact.id;

  return query select created.id,
    case when chosen is null then 'queued' else 'routed' end,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=chosen),
    case when chosen is null
      then 'Atendimento registrado. Aguarde um operador disponível da sua base.'
      else 'Atendimento encaminhado. Aguarde a resposta do operador.' end;
end;
$$;

revoke execute on function public.route_whatsapp_chat(uuid,text) from public,anon,authenticated;
grant execute on function public.route_whatsapp_chat(uuid,text) to service_role;

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
    and p.chat_available
    and p.chat_presence_at>now()-interval '75 seconds'
  order by random() limit 1;

  if target_base is null then
    update public.vehicle_unlock_requests set
      handoff_reason=route_unlock_handoff.handoff_reason,
      transferred_at=now(),updated_at=now()
    where id=request_row.id;
    return;
  end if;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,technology,service_type,
    base_id,carrier_id,carrier_name_snapshot,accepted_at,routing_note,status,
    routing_status,channel,whatsapp_contact_id
  ) values(
    request_row.driver_name,request_row.phone_e164,coalesce(request_row.plate,'NÃO INFORMADA'),chosen,
    coalesce(driver.technology,'Não informada'),'monitoring',target_base,driver.carrier_id,
    request_row.carrier_name,case when chosen is null then null else now() end,
    case when chosen is null then 'Aguardando operador de monitoramento disponível' else 'Desbloqueio encaminhado para análise de segurança' end,
    case when chosen is null then 'Aguardando operador' else 'Em atendimento' end,
    case when chosen is null then 'waiting_operator' else 'routed' end,
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

revoke execute on function public.route_unlock_handoff(uuid,text) from public,anon,authenticated;
grant execute on function public.route_unlock_handoff(uuid,text) to service_role;

commit;
