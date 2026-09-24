-- Smart Chat — Bases, Transportadoras, fluxo de Monitoramento e Dashboard de chamadas.
-- Execute DEPOIS de 000_core_setup.sql, 012, 013 e 014.
begin;
create extension if not exists pgcrypto;

-- ============================================================
-- PERMISSÕES NOVAS
-- ============================================================
insert into public.permissions(permission_key, module_key, label) values
  ('monitoring_chat','monitoring_chat','Atender condutores pelo Chat de Monitoramento'),
  ('bases_admin','bases','Criar/editar Bases, Transportadoras e a planilha de teste'),
  ('base_operators_manage','bases','Vincular operadores às Bases (vínculo de operação)'),
  ('dashboard_view','dashboard','Ver o Dashboard de chamadas')
on conflict (permission_key) do update set module_key=excluded.module_key, label=excluded.label;

insert into public.role_permissions(access_role, permission_key, allowed)
select role_name, permission_key, allowed from (values
  ('Administrador','monitoring_chat',false),('Gerente','monitoring_chat',false),('Coordenador','monitoring_chat',false),
  ('Supervisor','monitoring_chat',true),('Lider','monitoring_chat',true),('Operador','monitoring_chat',true),
  ('Administrador','bases_admin',true),('Gerente','bases_admin',true),('Coordenador','bases_admin',false),
  ('Supervisor','bases_admin',false),('Lider','bases_admin',false),('Operador','bases_admin',false),
  ('Administrador','base_operators_manage',true),('Gerente','base_operators_manage',true),('Coordenador','base_operators_manage',true),
  ('Supervisor','base_operators_manage',false),('Lider','base_operators_manage',false),('Operador','base_operators_manage',false),
  ('Administrador','dashboard_view',true),('Gerente','dashboard_view',true),('Coordenador','dashboard_view',true),
  ('Supervisor','dashboard_view',true),('Lider','dashboard_view',false),('Operador','dashboard_view',false)
) v(role_name,permission_key,allowed)
on conflict (access_role, permission_key) do update set allowed=excluded.allowed;
-- Observação: qualquer papel pode receber checklist_chat/monitoring_chat também via
-- user_permission_overrides individualmente, sem depender só da função (role).

-- ============================================================
-- TABELAS: Bases, Transportadoras e vínculos
-- ============================================================
create table if not exists public.operation_bases (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.carriers ( -- transportadoras
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cada transportadora pertence a UMA base (a base pode ter várias transportadoras)
create table if not exists public.base_carriers (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.operation_bases(id) on delete cascade,
  carrier_id uuid not null unique references public.carriers(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Quais operadores atendem monitoramento de qual base (vínculo de operação)
create table if not exists public.base_operators (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.operation_bases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(base_id, user_id)
);

-- Quais Coordenadores (gestores) administram cada base
create table if not exists public.base_coordinators (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.operation_bases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(base_id, user_id)
);

-- "Planilha" de teste = banco simulado do sistema externo de frota/condutores.
-- Em produção, isso deve ser substituído por uma Edge Function que consulta a API real
-- (ver comentário no fim do arquivo); a função de roteamento abaixo já foi escrita
-- para ser fácil de trocar por essa chamada depois.
create table if not exists public.mock_fleet_drivers (
  id uuid primary key default gen_random_uuid(),
  plate text not null unique,
  driver_name text,
  technology text,
  carrier_id uuid references public.carriers(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.operation_bases enable row level security;
alter table public.carriers enable row level security;
alter table public.base_carriers enable row level security;
alter table public.base_operators enable row level security;
alter table public.base_coordinators enable row level security;
alter table public.mock_fleet_drivers enable row level security;

create or replace function public.is_admin_or_manager()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and access_role in ('Administrador','Gerente') and active=true);
$$;

create or replace function public.coordinates_base(check_base uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_admin_or_manager() or exists(
    select 1 from public.base_coordinators c where c.base_id=check_base and c.user_id=auth.uid()
  );
$$;

-- Bases e Transportadoras: leitura liberada (para combos), escrita só Admin/Gerente.
drop policy if exists bases_select on public.operation_bases;
create policy bases_select on public.operation_bases for select to authenticated using (true);
drop policy if exists bases_write on public.operation_bases;
create policy bases_write on public.operation_bases for all to authenticated
using (public.user_has_permission('bases_admin')) with check (public.user_has_permission('bases_admin'));

drop policy if exists carriers_select on public.carriers;
create policy carriers_select on public.carriers for select to authenticated using (true);
drop policy if exists carriers_write on public.carriers;
create policy carriers_write on public.carriers for all to authenticated
using (public.user_has_permission('bases_admin')) with check (public.user_has_permission('bases_admin'));

drop policy if exists base_carriers_select on public.base_carriers;
create policy base_carriers_select on public.base_carriers for select to authenticated using (true);
drop policy if exists base_carriers_write on public.base_carriers;
create policy base_carriers_write on public.base_carriers for all to authenticated
using (public.user_has_permission('bases_admin')) with check (public.user_has_permission('bases_admin'));

-- Vínculo operador↔base: Admin/Gerente (todas) ou Coordenador (só as bases dele)
drop policy if exists base_operators_select on public.base_operators;
create policy base_operators_select on public.base_operators for select to authenticated using (true);
drop policy if exists base_operators_write on public.base_operators;
create policy base_operators_write on public.base_operators for all to authenticated
using (public.user_has_permission('base_operators_manage') and public.coordinates_base(base_id))
with check (public.user_has_permission('base_operators_manage') and public.coordinates_base(base_id));

drop policy if exists base_coordinators_select on public.base_coordinators;
create policy base_coordinators_select on public.base_coordinators for select to authenticated using (true);
drop policy if exists base_coordinators_write on public.base_coordinators;
create policy base_coordinators_write on public.base_coordinators for all to authenticated
using (public.is_admin_or_manager()) with check (public.is_admin_or_manager());
-- (só Admin/Gerente define QUEM é coordenador de qual base — evita autopromoção de escopo)

drop policy if exists mock_fleet_select on public.mock_fleet_drivers;
create policy mock_fleet_select on public.mock_fleet_drivers for select to authenticated
using (public.user_has_permission('bases_admin'));
drop policy if exists mock_fleet_write on public.mock_fleet_drivers;
create policy mock_fleet_write on public.mock_fleet_drivers for all to authenticated
using (public.user_has_permission('bases_admin')) with check (public.user_has_permission('bases_admin'));

-- ============================================================
-- ATENDIMENTOS (reaproveita checklist_chat_sessions/messages para os 2 tipos)
-- ============================================================
alter table public.checklist_chat_sessions add column if not exists service_type text not null default 'checklist'
  check (service_type in ('checklist','monitoring'));
alter table public.checklist_chat_sessions add column if not exists base_id uuid references public.operation_bases(id);
alter table public.checklist_chat_sessions add column if not exists carrier_id uuid references public.carriers(id);
alter table public.checklist_chat_sessions add column if not exists accepted_at timestamptz;
alter table public.checklist_chat_sessions add column if not exists routing_note text;
alter table public.checklist_chat_sessions alter column operator_id drop not null;
create sequence if not exists public.monitoring_number_seq;

-- Sessões sem operador (não roteadas) ficam visíveis para quem administra bases,
-- para que um Coordenador possa atribuir manualmente.
drop policy if exists checklist_sessions_unrouted_read on public.checklist_chat_sessions;
create policy checklist_sessions_unrouted_read on public.checklist_chat_sessions
for select to authenticated using (operator_id is null and public.user_has_permission('bases_admin'));

create or replace function public.operator_enabled(check_user uuid, check_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles p where p.id=check_user and p.active=true
    and coalesce(
      (select o.allowed from public.user_permission_overrides o where o.user_id=p.id and o.permission_key=check_permission),
      (select r.allowed from public.role_permissions r where r.access_role=p.access_role and r.permission_key=check_permission),
      false
    )=true
  );
$$;

-- Reescreve o roteamento do Checklist para desempate ALEATÓRIO entre os operadores
-- com menos atendimentos em aberto (mantém o restante do comportamento de 014).
create or replace function public.start_driver_checklist_chat(driver_account uuid,account_token uuid,vehicle_plate text,tracker_technology text,reported_name text)
returns table(session_id uuid,driver_token uuid,operator_id uuid,operator_name text)
language plpgsql security definer set search_path=public as $$
declare account public.checklist_driver_accounts; chosen uuid; created public.checklist_chat_sessions;
begin
 select * into account from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active for update;
 if account.id is null then raise exception 'Sessão inválida'; end if;
 if length(trim(reported_name))<3 or upper(vehicle_plate)!~'^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' or length(trim(tracker_technology))<2 then raise exception 'Informe nome, placa e tecnologia'; end if;
 select * into created from public.checklist_chat_sessions s where s.driver_account_id=account.id and s.active and s.service_type='checklist' order by s.created_at desc limit 1;
 if created.id is null then
  select p.id into chosen from public.profiles p where p.active and public.operator_enabled(p.id,'checklist_chat')
  order by (select count(*) from public.checklist_chat_sessions s where s.operator_id=p.id and s.active), random() limit 1;
  if chosen is null then raise exception 'Nenhum operador disponível'; end if;
  insert into public.checklist_chat_sessions(driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,technology,service_type,accepted_at)
  values(trim(reported_name),account.phone,upper(vehicle_plate),chosen,account.id,trim(tracker_technology),'checklist',now()) returning * into created;
 end if;
 return query select created.id,created.driver_token,created.operator_id,(select p.full_name from public.profiles p where p.id=created.operator_id);
end;$$;

-- Roteamento do MONITORAMENTO: consulta a "planilha" (mock_fleet_drivers) pela placa,
-- descobre a transportadora, descobre a base vinculada a essa transportadora e só então
-- escolhe um operador vinculado àquela base. Se qualquer etapa falhar, a sessão é criada
-- sem operador (routed=false) e fica visível para um Coordenador atribuir manualmente.
create or replace function public.start_driver_monitoring_chat(driver_account uuid,account_token uuid,vehicle_plate text,tracker_technology text,reported_name text)
returns table(session_id uuid,driver_token uuid,operator_id uuid,operator_name text,routed boolean,notice text)
language plpgsql security definer set search_path=public as $$
declare
  account public.checklist_driver_accounts; created public.checklist_chat_sessions;
  plate_clean text := upper(trim(vehicle_plate));
  found_carrier uuid; found_base uuid; chosen uuid; note text;
begin
 select * into account from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active for update;
 if account.id is null then raise exception 'Sessão inválida'; end if;
 if length(trim(reported_name))<3 or plate_clean!~'^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' or length(trim(tracker_technology))<2 then raise exception 'Informe nome, placa e tecnologia'; end if;

 select * into created from public.checklist_chat_sessions s where s.driver_account_id=account.id and s.active and s.service_type='monitoring' order by s.created_at desc limit 1;
 if created.id is not null then
   return query select created.id,created.driver_token,created.operator_id,
     (select p.full_name from public.profiles p where p.id=created.operator_id),
     created.operator_id is not null, created.routing_note;
   return;
 end if;

 -- 1) Busca o veículo na "planilha"/base simulada (troque por chamada de API real depois)
 select carrier_id into found_carrier from public.mock_fleet_drivers where plate=plate_clean;
 if found_carrier is null then
   note := 'Veículo não localizado na base de dados. Um coordenador vai encaminhar manualmente.';
 else
   -- 2) Descobre a base vinculada àquela transportadora
   select base_id into found_base from public.base_carriers where carrier_id=found_carrier;
   if found_base is null then
     note := 'Transportadora localizada, mas sem base vinculada. Um coordenador vai encaminhar manualmente.';
   else
     -- 3) Escolhe operador vinculado a essa base (menor carga, desempate aleatório)
     select p.id into chosen from public.profiles p
     join public.base_operators bo on bo.user_id=p.id and bo.base_id=found_base
     where public.operator_enabled(p.id,'monitoring_chat')
     order by (select count(*) from public.checklist_chat_sessions s where s.operator_id=p.id and s.active), random() limit 1;
     if chosen is null then note := 'Base localizada, mas sem operador de monitoramento disponível no momento.'; end if;
   end if;
 end if;

 insert into public.checklist_chat_sessions
   (driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,technology,service_type,base_id,carrier_id,routing_note,accepted_at)
 values(trim(reported_name),account.phone,plate_clean,chosen,account.id,trim(tracker_technology),'monitoring',found_base,found_carrier,note,case when chosen is not null then now() end)
 returning * into created;

 return query select created.id,created.driver_token,created.operator_id,
   (select p.full_name from public.profiles p where p.id=chosen), chosen is not null, note;
end;$$;

-- Um Coordenador/Admin atribui manualmente um atendimento que não foi roteado
create or replace function public.claim_unrouted_session(chat_session uuid, target_operator uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare s public.checklist_chat_sessions; pick uuid := coalesce(target_operator, auth.uid());
begin
  if not public.user_has_permission('bases_admin') then raise exception 'Sem permissão para atribuir atendimentos'; end if;
  select * into s from public.checklist_chat_sessions where id=chat_session and operator_id is null and active for update;
  if s.id is null then raise exception 'Atendimento não encontrado ou já atribuído'; end if;
  if s.base_id is not null and not public.coordinates_base(s.base_id) then raise exception 'Esta base não está sob sua coordenação'; end if;
  if not public.operator_enabled(pick, case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end) then
    raise exception 'Operador selecionado não tem permissão para este tipo de atendimento';
  end if;
  update public.checklist_chat_sessions set operator_id=pick, accepted_at=now(), routing_note=null where id=chat_session;
end;$$;

create or replace function public.finish_monitoring_chat(chat_session uuid, outcome text default 'Concluído', note text default null)
returns table(monitoring_number text)
language plpgsql security definer set search_path=public as $$
declare generated text; session_row public.checklist_chat_sessions;
begin
  select * into session_row from public.checklist_chat_sessions s where s.id=chat_session and s.operator_id=auth.uid() and s.service_type='monitoring' for update;
  if session_row.id is null or not public.user_has_permission('monitoring_chat') then raise exception 'Atendimento não autorizado'; end if;
  if not session_row.active then return query select session_row.checklist_number; return; end if;
  if outcome not in ('Concluído','Cancelado') then raise exception 'Resultado inválido'; end if;
  generated := 'MON-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.monitoring_number_seq')::text,4,'0');
  update public.checklist_chat_sessions set active=false,status=outcome,outcome_reason=nullif(trim(note),''),checklist_number=generated,finished_at=now(),updated_at=now() where id=chat_session;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body) values(chat_session,'bot','Atendimento '||generated||' encerrado como '||outcome||'.');
  return query select generated;
end;$$;

-- Reconexão do app do condutor, agora cobrindo os dois tipos de atendimento
create or replace function public.resume_driver_chat(driver_account uuid,account_token uuid)
returns table(session_id uuid,driver_token uuid,operator_id uuid,driver_name text,vehicle_plate text,technology text,service_type text)
language sql security definer set search_path=public as $$
 select s.id,s.driver_token,s.operator_id,s.driver_name,s.vehicle_plate,s.technology,s.service_type from public.checklist_chat_sessions s
 join public.checklist_driver_accounts a on a.id=s.driver_account_id where a.id=driver_account and a.session_token=account_token and a.active and s.active
 order by s.created_at desc limit 1;
$$;

-- Histórico do condutor, cobrindo checklist e monitoramento
create or replace function public.list_driver_service_records(driver_account uuid,account_token uuid)
returns table(checklist_number text,service_type text,status text,reason text,vehicle_plate text,finished_at timestamptz)
language sql security definer set search_path=public as $$
  select s.checklist_number,s.service_type,s.status,s.outcome_reason,s.vehicle_plate,s.finished_at
  from public.checklist_chat_sessions s join public.checklist_driver_accounts a on a.id=s.driver_account_id
  where a.id=driver_account and a.session_token=account_token and s.active=false and s.checklist_number is not null order by s.finished_at desc;
$$;

grant execute on function public.start_driver_monitoring_chat(uuid,uuid,text,text,text) to anon,authenticated;
grant execute on function public.resume_driver_chat(uuid,uuid) to anon,authenticated;
grant execute on function public.list_driver_service_records(uuid,uuid) to anon,authenticated;
grant execute on function public.claim_unrouted_session(uuid,uuid) to authenticated;
grant execute on function public.finish_monitoring_chat(uuid,text,text) to authenticated;
grant execute on function public.operator_enabled(uuid,text) to authenticated;

-- As políticas de 012/014 só checavam a permissão 'checklist_chat'. Agora a sessão pode
-- ser de monitoramento, então o operador precisa também poder ler/enviar com 'monitoring_chat'.
create or replace function public.can_operate_session(check_session uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.checklist_chat_sessions s where s.id=check_session and s.operator_id=auth.uid()
    and public.user_has_permission(case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end)
  );
$$;

drop policy if exists checklist_sessions_operator_read on public.checklist_chat_sessions;
create policy checklist_sessions_operator_read on public.checklist_chat_sessions
for select to authenticated using (operator_id=auth.uid() and public.can_operate_session(id));

drop policy if exists checklist_messages_operator_read on public.checklist_chat_messages_v2;
create policy checklist_messages_operator_read on public.checklist_chat_messages_v2
for select to authenticated using (public.can_operate_session(session_id));

drop policy if exists checklist_messages_operator_insert on public.checklist_chat_messages_v2;
create policy checklist_messages_operator_insert on public.checklist_chat_messages_v2
for insert to authenticated with check (sender_type='operator' and sender_id=auth.uid() and public.can_operate_session(session_id));

grant execute on function public.can_operate_session(uuid) to authenticated;

do $$ begin alter publication supabase_realtime add table public.operation_bases; exception when duplicate_object then null; end $$;

-- ============================================================
-- DASHBOARD (tempo de atendimento, operadores ativos, volume por base/tipo)
-- ============================================================
create or replace function public.dashboard_metrics(date_from date default null, date_to date default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  scoped_bases uuid[]; is_scoped boolean; result jsonb; d_from timestamptz; d_to timestamptz;
begin
  if not public.user_has_permission('dashboard_view') then raise exception 'Sem permissão para ver o dashboard'; end if;
  d_from := coalesce(date_from, current_date - 6)::timestamptz;
  d_to := coalesce(date_to, current_date)::timestamptz + interval '1 day';
  is_scoped := exists(select 1 from public.profiles where id=auth.uid() and access_role='Coordenador');
  if is_scoped then
    select array_agg(base_id) into scoped_bases from public.base_coordinators where user_id=auth.uid();
  end if;

  select jsonb_build_object(
    'total_atendimentos', count(*),
    'em_andamento', count(*) filter (where active),
    'nao_roteados', count(*) filter (where active and operator_id is null),
    'tempo_medio_segundos', coalesce(round(avg(extract(epoch from (finished_at - created_at))) filter (where finished_at is not null)),0),
    'por_tipo', jsonb_build_object(
      'checklist', count(*) filter (where service_type='checklist'),
      'monitoramento', count(*) filter (where service_type='monitoring')
    )
  ) into result
  from public.checklist_chat_sessions s
  where s.created_at >= d_from and s.created_at < d_to
    and (not is_scoped or s.base_id = any(scoped_bases));

  result := result || jsonb_build_object('operadores_ativos', (
    select count(*) from public.profiles where active and last_seen_at > now() - interval '5 minutes'
    and (not is_scoped or id in (select user_id from public.base_operators where base_id = any(scoped_bases)))
  ));

  result := result || jsonb_build_object('por_base', coalesce((
    select jsonb_agg(jsonb_build_object('base', coalesce(b.name,'Sem base'), 'total', t.total, 'tempo_medio_segundos', t.tempo_medio))
    from (
      select s.base_id, count(*) total, round(avg(extract(epoch from (s.finished_at - s.created_at))) filter (where s.finished_at is not null)) tempo_medio
      from public.checklist_chat_sessions s
      where s.created_at >= d_from and s.created_at < d_to and (not is_scoped or s.base_id = any(scoped_bases))
      group by s.base_id
    ) t left join public.operation_bases b on b.id=t.base_id
  ), '[]'::jsonb));

  result := result || jsonb_build_object('por_operador', coalesce((
    select jsonb_agg(jsonb_build_object('operador', coalesce(p.full_name,p.username,'—'), 'total', t.total, 'tempo_medio_segundos', t.tempo_medio))
    from (
      select s.operator_id, count(*) total, round(avg(extract(epoch from (s.finished_at - s.created_at))) filter (where s.finished_at is not null)) tempo_medio
      from public.checklist_chat_sessions s
      where s.created_at >= d_from and s.created_at < d_to and s.operator_id is not null and (not is_scoped or s.base_id = any(scoped_bases))
      group by s.operator_id
    ) t join public.profiles p on p.id=t.operator_id
  ), '[]'::jsonb));

  return result;
end;$$;
grant execute on function public.dashboard_metrics(date,date) to authenticated;

commit;

-- ============================================================
-- SUBSTITUINDO A "PLANILHA" PELA API REAL NO FUTURO
-- ============================================================
-- Quando a API da transportadora existir, troque só o miolo de start_driver_monitoring_chat:
-- em vez de "select carrier_id into found_carrier from public.mock_fleet_drivers where plate=...",
-- chame uma Edge Function (Deno) que faz o fetch HTTP à API externa e devolva o carrier_id
-- correspondente (ou crie/atualize esse resultado dentro de mock_fleet_drivers como cache).
-- O restante do roteamento (base ↔ transportadora ↔ operador) não muda.
