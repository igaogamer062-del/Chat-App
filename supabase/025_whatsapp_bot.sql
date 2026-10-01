-- Smart Chat | substitui o aplicativo do condutor pelo bot oficial do WhatsApp
-- Execute depois de 024_lovable_driver_integration.sql.

begin;

create extension if not exists pg_trgm;

alter table public.external_driver_directory
  add column if not exists phone_e164 text,
  add column if not exists vehicle_plate text,
  add column if not exists technology text;

create index if not exists external_driver_directory_phone_idx
  on public.external_driver_directory(phone_e164) where active;

create table if not exists public.whatsapp_bot_settings(
  id boolean primary key default true check(id=true),
  enabled boolean not null default true,
  greeting text not null default 'Olá! Sou o assistente da Central Smart Risk.',
  unknown_driver_message text not null default 'Não encontramos seu telefone no cadastro de condutores. Procure sua transportadora para atualizar seus dados.',
  fallback_message text not null default 'Não encontrei essa informação nos manuais. Digite ATENDIMENTO para falar com um operador.',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

insert into public.whatsapp_bot_settings(id) values(true) on conflict(id) do nothing;

create table if not exists public.whatsapp_contacts(
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,
  phone_e164 text not null,
  external_driver_id uuid references public.external_driver_directory(id) on delete set null,
  state text not null default 'menu',
  context jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.bot_manuals(
  id uuid primary key default gen_random_uuid(),
  title text not null,
  technology text,
  file_name text,
  content text not null check(length(content) between 20 and 1000000),
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_manuals_search_idx on public.bot_manuals using gin(
  to_tsvector('portuguese',coalesce(title,'')||' '||coalesce(technology,'')||' '||content)
);

create table if not exists public.whatsapp_message_events(
  message_id text primary key,
  wa_id text,
  direction text not null check(direction in('inbound','outbound','status')),
  event_status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.checklist_chat_sessions
  add column if not exists channel text not null default 'web',
  add column if not exists whatsapp_contact_id uuid references public.whatsapp_contacts(id) on delete set null;

alter table public.checklist_chat_sessions drop constraint if exists checklist_chat_sessions_channel_check;
alter table public.checklist_chat_sessions add constraint checklist_chat_sessions_channel_check
  check(channel in('web','whatsapp'));

alter table public.whatsapp_bot_settings enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.bot_manuals enable row level security;
alter table public.whatsapp_message_events enable row level security;

drop policy if exists whatsapp_settings_manager on public.whatsapp_bot_settings;
create policy whatsapp_settings_manager on public.whatsapp_bot_settings for all to authenticated
using(public.is_manager()) with check(public.is_manager());

drop policy if exists whatsapp_contacts_manager_read on public.whatsapp_contacts;
create policy whatsapp_contacts_manager_read on public.whatsapp_contacts for select to authenticated
using(public.is_manager());

drop policy if exists bot_manuals_manager on public.bot_manuals;
create policy bot_manuals_manager on public.bot_manuals for all to authenticated
using(public.is_manager()) with check(public.is_manager());

drop policy if exists whatsapp_events_manager_read on public.whatsapp_message_events;
create policy whatsapp_events_manager_read on public.whatsapp_message_events for select to authenticated
using(public.is_manager());

create or replace function public.search_bot_manuals(
  question text,
  driver_technology text default null,
  result_limit integer default 3
)
returns table(id uuid,title text,technology text,excerpt text,rank real)
language sql stable security definer set search_path=public as $$
  with query as (
    select websearch_to_tsquery('portuguese',trim(question)) value
  )
  select m.id,m.title,m.technology,
    ts_headline('portuguese',m.content,q.value,
      'MaxFragments=3,MaxWords=55,MinWords=15,StartSel=,StopSel=') excerpt,
    ts_rank_cd(
      to_tsvector('portuguese',coalesce(m.title,'')||' '||coalesce(m.technology,'')||' '||m.content),
      q.value
    ) rank
  from public.bot_manuals m cross join query q
  where m.active
    and q.value @@ to_tsvector('portuguese',coalesce(m.title,'')||' '||coalesce(m.technology,'')||' '||m.content)
    and (driver_technology is null or m.technology is null or lower(m.technology)=lower(driver_technology))
  order by rank desc
  limit greatest(1,least(coalesce(result_limit,3),5));
$$;

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
  where s.whatsapp_contact_id=contact.id and s.active order by s.created_at desc limit 1;
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

  select p.id into chosen
  from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=target_base
  where public.operator_enabled(p.id,case when service_kind='monitoring' then 'monitoring_chat' else 'checklist_chat' end)
    and p.last_seen_at>now()-interval '2 minutes'
  order by(
    select count(*) from public.checklist_chat_sessions open_session
    where open_session.operator_id=p.id and open_session.active
  ),random() limit 1;

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

  update public.whatsapp_contacts set state='in_service',last_seen_at=now() where id=contact.id;
  return query select created.id,'routed'::text,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=chosen),
    'Atendimento encaminhado. Aguarde a resposta do operador.'::text;
end;
$$;

grant execute on function public.search_bot_manuals(text,text,integer) to authenticated;

-- Encerra os componentes exclusivos do aplicativo móvel. O histórico dos
-- atendimentos e as mensagens são preservados.
drop policy if exists mobile_driver_profile_own_read on public.mobile_driver_profiles;
drop policy if exists mobile_driver_profile_own_update on public.mobile_driver_profiles;
drop policy if exists checklist_sessions_mobile_own_read on public.checklist_chat_sessions;
drop policy if exists checklist_messages_mobile_own_read on public.checklist_chat_messages_v2;
drop policy if exists smart_chat_evaluation_own_read on public.smart_chat_evaluations;

drop function if exists public.sync_mobile_driver_profile();
drop function if exists public.start_mobile_smart_chat(text,text,text,text);
drop function if exists public.mobile_choose_wait(uuid,boolean);
drop function if exists public.mobile_send_chat_message(uuid,text);
drop function if exists public.mobile_list_chat_messages(uuid);
drop function if exists public.mobile_list_service_records();
drop function if exists public.mobile_rate_service(uuid,smallint,text);

drop table if exists public.smart_chat_evaluations cascade;
drop table if exists public.mobile_driver_profiles cascade;
drop table if exists public.driver_push_subscriptions cascade;

drop function if exists public.save_driver_push_subscription(uuid,uuid,jsonb);
drop function if exists public.disable_driver_push_subscription(uuid,uuid,text);
drop function if exists public.register_checklist_driver(text,text,text,text);
drop function if exists public.login_checklist_driver(text,text);
drop function if exists public.start_driver_checklist_chat(uuid,uuid,text,text);
drop function if exists public.start_driver_checklist_chat(uuid,uuid,text,text,text);
drop function if exists public.start_driver_monitoring_chat(uuid,uuid,text,text,text);
drop function if exists public.resume_driver_checklist_chat(uuid,uuid);
drop function if exists public.resume_driver_chat(uuid,uuid);
drop function if exists public.list_driver_checklist_records(uuid,uuid);
drop function if exists public.list_driver_service_records(uuid,uuid);
drop function if exists public.list_driver_service_records_v2(uuid,uuid);
drop function if exists public.send_checklist_driver_message(uuid,uuid,text);
drop function if exists public.read_checklist_driver_messages(uuid,uuid);
drop function if exists public.send_checklist_driver_attachment(uuid,uuid,jsonb);
drop function if exists public.set_checklist_driver_notifications(uuid,uuid,boolean);

alter table public.checklist_chat_sessions
  drop column if exists driver_account_id,
  drop column if exists driver_auth_user_id;

drop table if exists public.checklist_driver_accounts cascade;

commit;
