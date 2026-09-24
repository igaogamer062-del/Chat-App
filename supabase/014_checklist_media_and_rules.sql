-- Execute depois de 013. Não contém chaves secretas.
begin;
alter table public.checklist_chat_messages_v2 add column if not exists attachment jsonb;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('checklist-chat-files','checklist-chat-files',false,26214400,
array['image/jpeg','image/png','image/webp','image/gif','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','video/mp4','video/webm','video/quicktime','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=26214400,allowed_mime_types=excluded.allowed_mime_types;

-- A abertura antiga sem conta deixa de estar disponível.
revoke execute on function public.start_checklist_chat(text,text,text,uuid) from public,anon,authenticated;
drop function if exists public.start_driver_checklist_chat(uuid,uuid,text,text);
create or replace function public.start_driver_checklist_chat(driver_account uuid,account_token uuid,vehicle_plate text,tracker_technology text,reported_name text)
returns table(session_id uuid,driver_token uuid,operator_id uuid,operator_name text)
language plpgsql security definer set search_path=public as $$
declare account public.checklist_driver_accounts; chosen uuid; created public.checklist_chat_sessions;
begin
 select * into account from public.checklist_driver_accounts a where a.id=driver_account and a.session_token=account_token and a.active for update;
 if account.id is null then raise exception 'Sessão inválida'; end if;
 if length(trim(reported_name))<3 or upper(vehicle_plate)!~'^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' or length(trim(tracker_technology))<2 then raise exception 'Informe nome, placa e tecnologia'; end if;
 select * into created from public.checklist_chat_sessions s where s.driver_account_id=account.id and s.active order by s.created_at desc limit 1;
 if created.id is null then
  select p.id into chosen from public.profiles p where p.active and public.checklist_operator_enabled(p.id)
  order by (select count(*) from public.checklist_chat_sessions s where s.operator_id=p.id and s.active),p.full_name limit 1;
  if chosen is null then raise exception 'Nenhum operador disponível'; end if;
  insert into public.checklist_chat_sessions(driver_name,driver_phone,vehicle_plate,operator_id,driver_account_id,technology)
  values(trim(reported_name),account.phone,upper(vehicle_plate),chosen,account.id,trim(tracker_technology)) returning * into created;
 end if;
 return query select created.id,created.driver_token,created.operator_id,(select p.full_name from public.profiles p where p.id=created.operator_id);
end;$$;

create or replace function public.resume_driver_checklist_chat(driver_account uuid,account_token uuid)
returns table(session_id uuid,driver_token uuid,operator_id uuid,driver_name text,vehicle_plate text,technology text)
language sql security definer set search_path=public as $$
 select s.id,s.driver_token,s.operator_id,s.driver_name,s.vehicle_plate,s.technology from public.checklist_chat_sessions s
 join public.checklist_driver_accounts a on a.id=s.driver_account_id where a.id=driver_account and a.session_token=account_token and a.active and s.active order by s.created_at desc limit 1;
$$;

drop function if exists public.read_checklist_driver_messages(uuid,uuid);
create function public.read_checklist_driver_messages(chat_session uuid,chat_token uuid)
returns table(id uuid,sender_type text,body text,created_at timestamptz,attachment jsonb)
language sql security definer set search_path=public as $$
 select m.id,m.sender_type,m.body,m.created_at,m.attachment from public.checklist_chat_messages_v2 m
 join public.checklist_chat_sessions s on s.id=m.session_id
 where s.id=chat_session and s.driver_token=chat_token and (s.active or m.sender_type='bot') order by m.created_at;
$$;

create or replace function public.send_checklist_driver_attachment(chat_session uuid,chat_token uuid,file_attachment jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare message_id uuid;
begin
 if not exists(select 1 from public.checklist_chat_sessions s where s.id=chat_session and s.driver_token=chat_token and s.active) then raise exception 'Atendimento encerrado ou inválido'; end if;
 if split_part(file_attachment->>'path','/',1)<>chat_session::text or not exists(select 1 from storage.objects o where o.bucket_id='checklist-chat-files' and o.name=file_attachment->>'path') then raise exception 'Arquivo inválido'; end if;
 if coalesce((file_attachment->>'size')::bigint,0) not between 1 and 26214400 then raise exception 'Tamanho inválido'; end if;
 insert into public.checklist_chat_messages_v2(session_id,sender_type,body,attachment) values(chat_session,'driver','Anexo',file_attachment-'localId') returning id into message_id;
 return message_id;
end;$$;

create or replace function public.set_checklist_driver_notifications(driver_account uuid,account_token uuid,enabled boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
 update public.checklist_driver_accounts a set notifications=enabled where a.id=driver_account and a.session_token=account_token and a.active;
 if not found then raise exception 'Sessão inválida'; end if;
end;$$;

create or replace function public.finish_checklist_chat(chat_session uuid,checklist_status text,outcome_reason text default null)
returns table(checklist_number text) language plpgsql security definer set search_path=public as $$
declare generated text; session_row public.checklist_chat_sessions; message_text text; reason text:=nullif(trim(outcome_reason),'');
begin
 select * into session_row from public.checklist_chat_sessions s where s.id=chat_session and s.operator_id=auth.uid() for update;
 if session_row.id is null or not public.user_has_permission('checklist_chat') then raise exception 'Atendimento não autorizado'; end if;
 if not session_row.active then return query select session_row.checklist_number; return; end if;
 if checklist_status not in ('Aprovado','Reprovado','Cancelado') then raise exception 'Resultado inválido'; end if;
 if checklist_status<>'Aprovado' and coalesce(length(reason),0)<3 then raise exception 'Informe o motivo'; end if;
 generated:='CHK-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.checklist_number_seq')::text,4,'0');
 update public.checklist_chat_sessions set active=false,status=checklist_status,outcome_reason=case when checklist_status='Aprovado' then null else reason end,checklist_number=generated,finished_at=now(),updated_at=now() where id=chat_session;
 message_text:='Checklist '||generated||' finalizado como '||checklist_status||'.';
 if checklist_status<>'Aprovado' then message_text:=message_text||' Consulte o motivo na aba Registros.'; end if;
 insert into public.checklist_chat_messages_v2(session_id,sender_type,body) values(chat_session,'bot',message_text);
 return query select generated;
end;$$;

drop policy if exists checklist_messages_operator_insert on public.checklist_chat_messages_v2;
create policy checklist_messages_operator_insert on public.checklist_chat_messages_v2 for insert to authenticated
with check(sender_type='operator' and sender_id=auth.uid() and exists(select 1 from public.checklist_chat_sessions s where s.id=session_id and s.operator_id=auth.uid() and s.active) and public.user_has_permission('checklist_chat'));
-- Encerramento somente pela função, que valida resultado, motivo e permissão.
drop policy if exists checklist_sessions_operator_update on public.checklist_chat_sessions;

alter function public.register_checklist_driver(text,text,text,text) set search_path=public,extensions;
alter function public.login_checklist_driver(text,text) set search_path=public,extensions;
revoke execute on function public.finish_checklist_chat(uuid,text,text) from public,anon;
grant execute on function public.finish_checklist_chat(uuid,text,text) to authenticated;
revoke execute on function public.start_driver_checklist_chat(uuid,uuid,text,text,text),public.resume_driver_checklist_chat(uuid,uuid),public.read_checklist_driver_messages(uuid,uuid),public.send_checklist_driver_attachment(uuid,uuid,jsonb),public.set_checklist_driver_notifications(uuid,uuid,boolean) from public;
grant execute on function public.start_driver_checklist_chat(uuid,uuid,text,text,text),public.resume_driver_checklist_chat(uuid,uuid),public.read_checklist_driver_messages(uuid,uuid),public.send_checklist_driver_attachment(uuid,uuid,jsonb),public.set_checklist_driver_notifications(uuid,uuid,boolean) to anon,authenticated;
commit;
