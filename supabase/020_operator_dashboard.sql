-- Smart Chat | dashboard e histórico próprios do Operador
-- Execute depois de 019_smart_chat_roles_routing_admin.sql.

begin;

insert into public.role_permissions(access_role,permission_key,allowed)
values ('Operador','dashboard_view',true)
on conflict(access_role,permission_key) do update set allowed=excluded.allowed;

create or replace function public.operator_dashboard_metrics(
  date_from date default null,
  date_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  result jsonb;
  d_from timestamptz;
  d_to timestamptz;
begin
  if not exists(
    select 1 from public.profiles
    where id=auth.uid() and active=true and access_role='Operador'
  ) then
    raise exception 'Dashboard disponível somente para operadores ativos';
  end if;

  d_from := coalesce(date_from,current_date-6)::timestamptz;
  d_to := coalesce(date_to,current_date)::timestamptz + interval '1 day';

  select jsonb_build_object(
    'total_atendimentos',count(*),
    'em_andamento',count(*) filter(where active),
    'nao_roteados',0,
    'operadores_ativos',case when exists(
      select 1 from public.profiles
      where id=auth.uid() and active and last_seen_at>now()-interval '5 minutes'
    ) then 1 else 0 end,
    'tempo_medio_segundos',coalesce(round(avg(extract(epoch from(finished_at-created_at))) filter(where finished_at is not null)),0),
    'por_tipo',jsonb_build_object(
      'checklist',count(*) filter(where service_type='checklist'),
      'monitoramento',count(*) filter(where service_type='monitoring')
    )
  ) into result
  from public.checklist_chat_sessions s
  where s.operator_id=auth.uid()
    and s.created_at>=d_from and s.created_at<d_to;

  result := result || jsonb_build_object('por_base',coalesce((
    select jsonb_agg(jsonb_build_object(
      'base',coalesce(b.name,'Sem base'),
      'total',grouped.total,
      'tempo_medio_segundos',grouped.tempo_medio
    ) order by grouped.total desc)
    from (
      select s.base_id,count(*) total,
        round(avg(extract(epoch from(s.finished_at-s.created_at))) filter(where s.finished_at is not null)) tempo_medio
      from public.checklist_chat_sessions s
      where s.operator_id=auth.uid()
        and s.created_at>=d_from and s.created_at<d_to
      group by s.base_id
    ) grouped
    left join public.operation_bases b on b.id=grouped.base_id
  ),'[]'::jsonb));

  result := result || jsonb_build_object('por_operador',jsonb_build_array());
  return result;
end;
$$;

revoke all on function public.operator_dashboard_metrics(date,date) from public,anon;
grant execute on function public.operator_dashboard_metrics(date,date) to authenticated;

commit;

