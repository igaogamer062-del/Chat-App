-- Smart Chat | perfis simplificados, roteamento por base e gestão
-- Execute depois de 018_force_create_missing_rpcs.sql.

begin;

-- ============================================================
-- PERFIS: somente Operador e Gestor
-- ============================================================
alter table public.profiles
  drop constraint if exists profiles_access_role_check;

alter table public.profiles
  add column if not exists chat_enabled boolean not null default true;

update public.profiles
set access_role = case when access_role='Operador' then 'Operador' else 'Gestor' end,
    chat_enabled = case when access_role='Operador' then chat_enabled else false end;

alter table public.profiles
  add constraint profiles_access_role_check
  check (access_role in ('Operador','Gestor'));

delete from public.role_permissions
where access_role not in ('Operador','Gestor');

insert into public.role_permissions(access_role,permission_key,allowed)
select role_name,permission_key,allowed
from (values
  ('Gestor','users_manage',true),
  ('Gestor','chatChecklist',true),
  ('Gestor','checklist_chat',true),
  ('Gestor','monitoring_chat',true),
  ('Gestor','bases_admin',true),
  ('Gestor','base_operators_manage',true),
  ('Gestor','dashboard_view',true),
  ('Operador','users_manage',false),
  ('Operador','chatChecklist',true),
  ('Operador','checklist_chat',true),
  ('Operador','monitoring_chat',true),
  ('Operador','bases_admin',false),
  ('Operador','base_operators_manage',false),
  ('Operador','dashboard_view',false)
) value_list(role_name,permission_key,allowed)
on conflict(access_role,permission_key) do update set allowed=excluded.allowed;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles
    where id=auth.uid() and access_role='Gestor' and active=true
  );
$$;

create or replace function public.is_admin_or_manager()
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_manager();
$$;

create or replace function public.admin_set_user_role(target_user uuid,new_role text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then raise exception 'Sem permissão para alterar acessos'; end if;
  if new_role not in ('Operador','Gestor') then raise exception 'Perfil inválido'; end if;
  update public.profiles
  set access_role=new_role,
      chat_enabled=case when new_role='Gestor' then false else chat_enabled end
  where id=target_user;
end;
$$;

create or replace function public.admin_set_user_active(target_user uuid,is_active boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then raise exception 'Sem permissão para alterar acessos'; end if;
  if target_user=auth.uid() and not is_active then raise exception 'Você não pode desativar seu próprio acesso'; end if;
  update public.profiles set active=is_active where id=target_user;
end;
$$;

create or replace function public.admin_set_user_chat(target_user uuid,is_enabled boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then raise exception 'Sem permissão para alterar o atendimento'; end if;
  update public.profiles set chat_enabled=is_enabled where id=target_user;
end;
$$;

grant execute on function public.admin_set_user_role(uuid,text) to authenticated;
grant execute on function public.admin_set_user_active(uuid,boolean) to authenticated;
grant execute on function public.admin_set_user_chat(uuid,boolean) to authenticated;

-- Somente perfis ativos, habilitados e vinculados podem receber atendimento.
create or replace function public.operator_enabled(check_user uuid,check_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles p
    where p.id=check_user
      and p.active=true
      and p.chat_enabled=true
      and p.access_role in ('Operador','Gestor')
      and coalesce(
        (select o.allowed from public.user_permission_overrides o
         where o.user_id=p.id and o.permission_key=check_permission),
        (select r.allowed from public.role_permissions r
         where r.access_role=p.access_role and r.permission_key=check_permission),
        false
      )=true
  );
$$;

create or replace function public.checklist_operator_enabled(check_user uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.operator_enabled(check_user,'checklist_chat');
$$;

-- ============================================================
-- BASE CHECKLIST
-- ============================================================
insert into public.operation_bases(name,active)
select 'Checklist',true
where not exists(
  select 1 from public.operation_bases where lower(name)=lower('Checklist')
);

-- ============================================================
-- ROTEAMENTO: nunca criar fila sem atendente
-- ============================================================
drop function if exists public.start_driver_checklist_chat(uuid,uuid,text,text,text);
create function public.start_driver_checklist_chat(
  driver_account uuid,
  account_token uuid,
  vehicle_plate text,
  tracker_technology text,
  reported_name text
)
returns table(session_id uuid,driver_token uuid,operator_id uuid,operator_name text)
language plpgsql security definer set search_path=public as $$
declare
  account public.checklist_driver_accounts;
  chosen uuid;
  created public.checklist_chat_sessions;
  checklist_base uuid;
begin
  select * into account
  from public.checklist_driver_accounts a
  where a.id=driver_account and a.session_token=account_token and a.active
  for update;
  if account.id is null then raise exception 'Sessão inválida'; end if;

  select id into checklist_base
  from public.operation_bases
  where lower(name)=lower('Checklist') and active=true
  limit 1;
  if checklist_base is null then raise exception 'A base Checklist não está disponível'; end if;

  select * into created
  from public.checklist_chat_sessions s
  where s.driver_account_id=account.id and s.active and s.service_type='checklist'
  order by s.created_at desc limit 1;

  if created.id is null then
    select p.id into chosen
    from public.profiles p
    join public.base_operators bo on bo.user_id=p.id and bo.base_id=checklist_base
    where public.operator_enabled(p.id,'checklist_chat')
    order by (
      select count(*) from public.checklist_chat_sessions open_session
      where open_session.operator_id=p.id and open_session.active
    ),random()
    limit 1;

    if chosen is null then
      raise exception 'Não há atendentes disponíveis no momento. Tente novamente mais tarde.';
    end if;

    insert into public.checklist_chat_sessions(
      driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,
      technology,service_type,base_id,accepted_at
    ) values(
      trim(reported_name),account.phone,upper(trim(vehicle_plate)),chosen,account.id,
      trim(tracker_technology),'checklist',checklist_base,now()
    ) returning * into created;
  end if;

  return query select created.id,created.driver_token,created.operator_id,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id);
end;
$$;

drop function if exists public.start_driver_monitoring_chat(uuid,uuid,text,text,text);
create function public.start_driver_monitoring_chat(
  driver_account uuid,
  account_token uuid,
  vehicle_plate text,
  tracker_technology text,
  reported_name text
)
returns table(
  session_id uuid,driver_token uuid,operator_id uuid,operator_name text,
  routed boolean,notice text
)
language plpgsql security definer set search_path=public as $$
declare
  account public.checklist_driver_accounts;
  created public.checklist_chat_sessions;
  fleet public.mock_fleet_drivers;
  found_base uuid;
  chosen uuid;
begin
  select * into account
  from public.checklist_driver_accounts a
  where a.id=driver_account and a.session_token=account_token and a.active
  for update;
  if account.id is null then raise exception 'Sessão inválida'; end if;

  select * into created
  from public.checklist_chat_sessions s
  where s.driver_account_id=account.id and s.active and s.service_type='monitoring'
  order by s.created_at desc limit 1;
  if created.id is not null then
    return query select created.id,created.driver_token,created.operator_id,
      (select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id),
      true,null::text;
    return;
  end if;

  select * into fleet
  from public.mock_fleet_drivers f
  where upper(regexp_replace(f.plate,'[- ]','','g'))=upper(regexp_replace(vehicle_plate,'[- ]','','g'))
  limit 1;
  if fleet.id is null then
    raise exception 'Veículo não localizado. Confira a placa e tente novamente.';
  end if;

  select bc.base_id into found_base
  from public.base_carriers bc
  join public.operation_bases b on b.id=bc.base_id and b.active=true
  join public.carriers c on c.id=bc.carrier_id and c.active=true
  where bc.carrier_id=fleet.carrier_id
  limit 1;
  if found_base is null then
    raise exception 'A transportadora do veículo ainda não possui uma base de atendimento.';
  end if;

  select p.id into chosen
  from public.profiles p
  join public.base_operators bo on bo.user_id=p.id and bo.base_id=found_base
  where public.operator_enabled(p.id,'monitoring_chat')
  order by (
    select count(*) from public.checklist_chat_sessions open_session
    where open_session.operator_id=p.id and open_session.active
  ),random()
  limit 1;

  if chosen is null then
    raise exception 'Não há atendentes disponíveis no momento. Tente novamente mais tarde.';
  end if;

  insert into public.checklist_chat_sessions(
    driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,
    technology,service_type,base_id,carrier_id,accepted_at
  ) values(
    trim(reported_name),account.phone,upper(trim(vehicle_plate)),chosen,account.id,
    trim(tracker_technology),'monitoring',found_base,fleet.carrier_id,now()
  ) returning * into created;

  return query select created.id,created.driver_token,created.operator_id,
    (select coalesce(p.full_name,p.username) from public.profiles p where p.id=created.operator_id),
    true,null::text;
end;
$$;

grant execute on function public.start_driver_checklist_chat(uuid,uuid,text,text,text) to anon,authenticated;
grant execute on function public.start_driver_monitoring_chat(uuid,uuid,text,text,text) to anon,authenticated;

-- ============================================================
-- VISIBILIDADE E HISTÓRICO PARA GESTORES
-- ============================================================
drop policy if exists checklist_sessions_manager_read on public.checklist_chat_sessions;
create policy checklist_sessions_manager_read on public.checklist_chat_sessions
for select to authenticated using(public.is_manager());

drop policy if exists checklist_messages_manager_read on public.checklist_chat_messages_v2;
create policy checklist_messages_manager_read on public.checklist_chat_messages_v2
for select to authenticated using(public.is_manager());

-- Exclusão visual preserva o histórico operacional.
create or replace function public.admin_set_base_active(target_base uuid,is_active boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then raise exception 'Sem permissão para alterar bases'; end if;
  if not is_active and exists(
    select 1 from public.operation_bases where id=target_base and lower(name)=lower('Checklist')
  ) then raise exception 'A base Checklist não pode ser excluída'; end if;
  update public.operation_bases set active=is_active where id=target_base;
end;
$$;

create or replace function public.admin_set_carrier_active(target_carrier uuid,is_active boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then raise exception 'Sem permissão para alterar transportadoras'; end if;
  update public.carriers set active=is_active where id=target_carrier;
end;
$$;

grant execute on function public.admin_set_base_active(uuid,boolean) to authenticated;
grant execute on function public.admin_set_carrier_active(uuid,boolean) to authenticated;

-- ============================================================
-- ASSINATURAS DE NOTIFICAÇÃO DO PWA
-- ============================================================
create table if not exists public.driver_push_subscriptions(
  id uuid primary key default gen_random_uuid(),
  driver_account_id uuid not null references public.checklist_driver_accounts(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.driver_push_subscriptions enable row level security;
revoke all on public.driver_push_subscriptions from anon,authenticated;

create or replace function public.save_driver_push_subscription(
  driver_account uuid,account_token uuid,push_subscription jsonb
)
returns void language plpgsql security definer set search_path=public as $$
declare endpoint_value text:=push_subscription->>'endpoint';
begin
  if not exists(select 1 from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active) then
    raise exception 'Sessão inválida';
  end if;
  if coalesce(length(endpoint_value),0)<20 then raise exception 'Assinatura de notificação inválida'; end if;
  insert into public.driver_push_subscriptions(driver_account_id,endpoint,subscription,active,updated_at)
  values(driver_account,endpoint_value,push_subscription,true,now())
  on conflict(endpoint) do update set driver_account_id=excluded.driver_account_id,subscription=excluded.subscription,active=true,updated_at=now();
end;
$$;

create or replace function public.disable_driver_push_subscription(
  driver_account uuid,account_token uuid,subscription_endpoint text
)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active) then
    raise exception 'Sessão inválida';
  end if;
  update public.driver_push_subscriptions set active=false,updated_at=now()
  where driver_account_id=driver_account and endpoint=subscription_endpoint;
end;
$$;

grant execute on function public.save_driver_push_subscription(uuid,uuid,jsonb) to anon,authenticated;
grant execute on function public.disable_driver_push_subscription(uuid,uuid,text) to anon,authenticated;

notify pgrst,'reload schema';
commit;
