-- Smart Chat | trilha imutável das mudanças de estado do desbloqueio
begin;

create table if not exists public.vehicle_unlock_events(
  id bigint generated always as identity primary key,
  unlock_request_id uuid not null references public.vehicle_unlock_requests(id) on delete cascade,
  state text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists vehicle_unlock_events_request_idx
  on public.vehicle_unlock_events(unlock_request_id,created_at);

alter table public.vehicle_unlock_events enable row level security;

drop policy if exists unlock_events_staff_read on public.vehicle_unlock_events;
create policy unlock_events_staff_read on public.vehicle_unlock_events for select to authenticated
using(exists(
  select 1 from public.vehicle_unlock_requests r
  where r.id=unlock_request_id
    and (public.is_manager() or r.operator_id=auth.uid())
));

create or replace function public.log_vehicle_unlock_transition()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' then
    insert into public.vehicle_unlock_events(unlock_request_id,state,details)
    values(new.id,new.status,jsonb_build_object('source',new.source));
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.vehicle_unlock_events(unlock_request_id,state,details)
    values(new.id,new.status,jsonb_build_object(
      'has_active_alert',new.has_active_alert,
      'alert_types',new.alert_types,
      'request_id',new.request_id
    ));
  end if;

  if new.transferred_at is not null and old.transferred_at is null then
    insert into public.vehicle_unlock_events(unlock_request_id,state,details)
    values(new.id,'TRANSFERRED_TO_OPERATOR',jsonb_build_object(
      'operator_id',new.operator_id,
      'session_id',new.session_id,
      'reason',new.handoff_reason
    ));
  end if;
  return new;
end;
$$;

drop trigger if exists vehicle_unlock_transition_log on public.vehicle_unlock_requests;
create trigger vehicle_unlock_transition_log
after insert or update on public.vehicle_unlock_requests
for each row execute function public.log_vehicle_unlock_transition();

revoke all on public.vehicle_unlock_events from anon,authenticated;
grant select on public.vehicle_unlock_events to authenticated;

commit;
