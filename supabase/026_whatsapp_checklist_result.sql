-- Smart Chat | resultado completo do checklist no histórico e no WhatsApp
begin;

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
  if reason is not null then message_text := message_text||E'\nMotivo: '||reason||'.'; end if;
  if coalesce(array_length(clean_items,1),0)>0 then message_text := message_text||E'\nItens reprovados: '||array_to_string(clean_items,', ')||'.'; end if;
  if scheduled_for is not null then message_text := message_text||E'\nNovo agendamento: '||to_char(scheduled_for at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||'.'; end if;

  insert into public.checklist_chat_messages_v2(session_id,sender_type,body)
  values(chat_session,'bot',message_text);

  return query select generated;
end;
$$;

revoke execute on function public.finish_checklist_chat_complete(uuid,text,text,text[],timestamptz) from public,anon;
grant execute on function public.finish_checklist_chat_complete(uuid,text,text,text[],timestamptz) to authenticated;

commit;
