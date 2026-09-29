-- Smart Chat | exclusão real, vínculo de bases e importação de transportadoras
-- Execute depois de 022_mobile_realtime.sql.

begin;

-- Preserva o nome usado no atendimento mesmo se o cadastro for removido depois.
alter table public.checklist_chat_sessions
  add column if not exists carrier_name_snapshot text;

update public.checklist_chat_sessions s
set carrier_name_snapshot=c.name
from public.carriers c
where s.carrier_id=c.id and s.carrier_name_snapshot is null;

-- Permite remover o cadastro sem apagar atendimentos históricos.
alter table public.checklist_chat_sessions
  drop constraint if exists checklist_chat_sessions_carrier_id_fkey;
alter table public.checklist_chat_sessions
  add constraint checklist_chat_sessions_carrier_id_fkey
  foreign key(carrier_id) references public.carriers(id) on delete set null;

create or replace function public.admin_set_carrier_base(
  target_carrier uuid,
  target_base uuid default null
)
returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_manager() then
    raise exception 'Sem permissão para vincular transportadoras';
  end if;
  if not exists(select 1 from public.carriers where id=target_carrier and active) then
    raise exception 'Transportadora não encontrada';
  end if;
  if target_base is not null and not exists(
    select 1 from public.operation_bases where id=target_base and active
  ) then
    raise exception 'Base não encontrada ou inativa';
  end if;

  if target_base is null then
    delete from public.base_carriers where carrier_id=target_carrier;
  else
    insert into public.base_carriers(base_id,carrier_id)
    values(target_base,target_carrier)
    on conflict(carrier_id) do update set base_id=excluded.base_id;
  end if;
end;
$$;

create or replace function public.admin_delete_carrier(target_carrier uuid)
returns void
language plpgsql security definer set search_path=public as $$
declare carrier_name text;
begin
  if not public.is_manager() then
    raise exception 'Sem permissão para excluir transportadoras';
  end if;

  select name into carrier_name
  from public.carriers
  where id=target_carrier
  for update;

  if carrier_name is null then
    raise exception 'Transportadora não encontrada';
  end if;

  update public.checklist_chat_sessions
  set carrier_name_snapshot=coalesce(carrier_name_snapshot,carrier_name)
  where carrier_id=target_carrier;

  delete from public.carriers where id=target_carrier;
end;
$$;

create or replace function public.admin_bulk_upsert_carriers(
  carrier_names text[],
  target_base uuid default null
)
returns table(imported integer,ignored integer)
language plpgsql security definer set search_path=public as $$
declare
  raw_name text;
  clean_name text;
  carrier_id uuid;
  imported_count integer:=0;
  ignored_count integer:=0;
begin
  if not public.is_manager() then
    raise exception 'Sem permissão para importar transportadoras';
  end if;
  if target_base is not null and not exists(
    select 1 from public.operation_bases where id=target_base and active
  ) then
    raise exception 'Base não encontrada ou inativa';
  end if;

  foreach raw_name in array coalesce(carrier_names,array[]::text[]) loop
    clean_name:=regexp_replace(trim(raw_name),'\s+',' ','g');
    if length(clean_name)<2 or length(clean_name)>160 then
      ignored_count:=ignored_count+1;
      continue;
    end if;

    select id into carrier_id
    from public.carriers
    where lower(name)=lower(clean_name)
    limit 1;

    if carrier_id is null then
      insert into public.carriers(name,active)
      values(clean_name,true)
      returning id into carrier_id;
    else
      update public.carriers set active=true where id=carrier_id;
    end if;

    if target_base is not null then
      insert into public.base_carriers(base_id,carrier_id)
      values(target_base,carrier_id)
      on conflict(carrier_id) do update set base_id=excluded.base_id;
    end if;
    imported_count:=imported_count+1;
  end loop;

  return query select imported_count,ignored_count;
end;
$$;

grant execute on function public.admin_set_carrier_base(uuid,uuid) to authenticated;
grant execute on function public.admin_delete_carrier(uuid) to authenticated;
grant execute on function public.admin_bulk_upsert_carriers(text[],uuid) to authenticated;

commit;
