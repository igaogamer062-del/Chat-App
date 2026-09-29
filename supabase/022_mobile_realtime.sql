-- Smart Chat | Realtime para o aplicativo móvel
-- Execute depois de 021_mobile_app_routing.sql.

begin;

alter table public.checklist_chat_sessions replica identity full;
alter table public.checklist_chat_messages_v2 replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.checklist_chat_sessions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.checklist_chat_messages_v2;
exception when duplicate_object then null;
end $$;

commit;
