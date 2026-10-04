-- Smart Chat | sorteio entre operadores disponíveis da base
begin;

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
    return query select created.id,'routed'::text,
      (select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id),
      'Você já possui um atendimento em andamento.'::text;
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

  -- Operadores inativos, sem permissão, com chat desligado ou offline são
  -- ignorados. Se houver mais de um disponível na base, o sorteio é aleatório.
  select p.id into chosen
  from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
  where public.operator_enabled(
      p.id,
      case when service_kind='monitoring' then 'monitoring_chat' else 'checklist_chat' end
    )
    and p.last_seen_at>now()-interval '5 minutes'
  order by random()
  limit 1;

  if chosen is null then
    return query select null::uuid,'busy'::text,null::text,
      'Todos os operadores desta operação estão ocupados no momento. Tente novamente em alguns minutos.'::text;
    return;
  end if;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,technology,service_type,
    base_id,carrier_id,carrier_name_snapshot,accepted_at,routing_note,status,
    channel,whatsapp_contact_id
  ) values(
    driver.full_name,contact.phone_e164,coalesce(driver.vehicle_plate,'NÃO INFORMADA'),chosen,
    coalesce(driver.technology,'Não informada'),service_kind,target_base,driver.carrier_id,
    driver.carrier_name,now(),'Atendimento recebido pelo WhatsApp','Em atendimento',
    'whatsapp',contact.id
  ) returning * into created;

  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(created.id,'bot','Atendimento solicitado pelo WhatsApp e encaminhado ao operador.');

  update public.whatsapp_contacts set state='in_service',last_seen_at=now()
  where id=contact.id;

  return query select created.id,'routed'::text,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=chosen),
    'Atendimento encaminhado. Aguarde a resposta do operador.'::text;
end;
$$;

revoke execute on function public.route_whatsapp_chat(uuid,text) from public,anon,authenticated;
grant execute on function public.route_whatsapp_chat(uuid,text) to service_role;

commit;
