-- Smart Chat | conclusão dos fluxos de atendimento
-- Execute depois do arquivo 015_bases_monitoramento_dashboard.sql.

begin;

alter table public.checklist_chat_sessions
  add column if not exists failed_items text[],
  add column if not exists rescheduled_at timestamptz;

drop policy if exists checklist_sessions_unrouted_read on public.checklist_chat_sessions;
create policy checklist_sessions_unrouted_read on public.checklist_chat_sessions
for select to authenticated
using (operator_id is null and public.user_has_permission('base_operators_manage'));

-- Encaminha uma sessão sem operador para o profissional disponível com menor fila.
-- Quando existe base, somente operadores vinculados a ela participam da escolha.
create or replace function public.claim_unrouted_session(chat_session uuid, target_operator uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare
  s public.checklist_chat_sessions;
  pick uuid := target_operator;
  needed_permission text;
begin
  if not public.user_has_permission('base_operators_manage') then
    raise exception 'Sem permissão para encaminhar atendimentos';
  end if;

  select * into s
  from public.checklist_chat_sessions
  where id=chat_session and operator_id is null and active
  for update;

  if s.id is null then raise exception 'Atendimento não encontrado ou já encaminhado'; end if;
  if s.base_id is not null and not public.coordinates_base(s.base_id) then
    raise exception 'Esta base não está sob sua coordenação';
  end if;
  if s.base_id is null and not public.is_admin_or_manager() then
    raise exception 'O atendimento ainda não possui base. Solicite o encaminhamento a um Administrador ou Gerente';
  end if;

  needed_permission := case when s.service_type='monitoring' then 'monitoring_chat' else 'checklist_chat' end;

  if pick is null then
    select p.id into pick
    from public.profiles p
    where p.active=true
      and public.operator_enabled(p.id,needed_permission)
      and (
        s.base_id is null
        or exists(select 1 from public.base_operators bo where bo.base_id=s.base_id and bo.user_id=p.id)
      )
    order by (
      select count(*) from public.checklist_chat_sessions open_session
      where open_session.operator_id=p.id and open_session.active=true
    ), random()
    limit 1;
  end if;

  if pick is null or not public.operator_enabled(pick,needed_permission) then
    raise exception 'Nenhum operador disponível com a permissão necessária';
  end if;
  if s.base_id is not null and not exists(
    select 1 from public.base_operators bo where bo.base_id=s.base_id and bo.user_id=pick
  ) then
    raise exception 'O operador selecionado não está vinculado à base';
  end if;

  update public.checklist_chat_sessions
  set operator_id=pick,accepted_at=now(),routing_note=null,updated_at=now()
  where id=chat_session;
end;$$;

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
  reason text := nullif(trim(outcome_reason),'');
  clean_items text[];
  message_text text;
begin
  select * into session_row
  from public.checklist_chat_sessions s
  where s.id=chat_session and s.operator_id=auth.uid()
  for update;

  if session_row.id is null or not public.user_has_permission('checklist_chat') then
    raise exception 'Atendimento não autorizado';
  end if;
  if not session_row.active then return query select session_row.checklist_number; return; end if;
  if checklist_status not in ('Aprovado','Reprovado','Cancelado','Reagendado') then
    raise exception 'Resultado inválido';
  end if;
  if checklist_status<>'Aprovado' and coalesce(length(reason),0)<3 then
    raise exception 'Informe o motivo';
  end if;

  select array_agg(trim(item)) into clean_items
  from unnest(coalesce(failed_items,array[]::text[])) item
  where length(trim(item))>0;

  if checklist_status='Reprovado' and coalesce(array_length(clean_items,1),0)=0 then
    raise exception 'Informe ao menos um acessório ou item reprovado';
  end if;
  if checklist_status='Reagendado' and (scheduled_for is null or scheduled_for<=now()) then
    raise exception 'Informe uma data futura para o reagendamento';
  end if;

  generated := 'CHK-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.checklist_number_seq')::text,4,'0');

  update public.checklist_chat_sessions
  set active=false,
      status=checklist_status,
      outcome_reason=case when checklist_status='Aprovado' then null else reason end,
      failed_items=case when checklist_status='Reprovado' then clean_items else null end,
      rescheduled_at=case when checklist_status='Reagendado' then scheduled_for else null end,
      checklist_number=generated,
      finished_at=now(),
      updated_at=now()
  where id=chat_session;

  message_text := 'Checklist '||generated||' finalizado como '||checklist_status||'.';
  if checklist_status<>'Aprovado' then message_text := message_text||' Consulte os detalhes na aba Registros.'; end if;
  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(chat_session,'bot',message_text);

  return query select generated;
end;$$;

create or replace function public.list_driver_service_records_v2(driver_account uuid,account_token uuid)
returns table(
  checklist_number text,
  service_type text,
  status text,
  reason text,
  vehicle_plate text,
  failed_items text[],
  rescheduled_at timestamptz,
  finished_at timestamptz
)
language sql security definer set search_path=public as $$
  select s.checklist_number,s.service_type,s.status,s.outcome_reason,s.vehicle_plate,
         s.failed_items,s.rescheduled_at,s.finished_at
  from public.checklist_chat_sessions s
  join public.checklist_driver_accounts a on a.id=s.driver_account_id
  where a.id=driver_account and a.session_token=account_token
    and s.active=false and s.checklist_number is not null
  order by s.finished_at desc;
$$;

revoke execute on function public.finish_checklist_chat_complete(uuid,text,text,text[],timestamptz) from public,anon;
grant execute on function public.finish_checklist_chat_complete(uuid,text,text,text[],timestamptz) to authenticated;
revoke execute on function public.list_driver_service_records_v2(uuid,uuid) from public;
grant execute on function public.list_driver_service_records_v2(uuid,uuid) to anon,authenticated;

commit;
