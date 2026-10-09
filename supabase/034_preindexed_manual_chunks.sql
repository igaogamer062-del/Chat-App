-- Smart Chat | pré-indexação dos manuais para respostas rápidas e objetivas
begin;

create table if not exists public.bot_manual_chunks(
  id uuid primary key default gen_random_uuid(),
  manual_id uuid not null references public.bot_manuals(id) on delete cascade,
  chunk_index integer not null,
  content text not null check(length(content) between 20 and 5000),
  search_vector tsvector generated always as (
    to_tsvector('portuguese'::regconfig,content)
  ) stored,
  created_at timestamptz not null default now(),
  unique(manual_id,chunk_index)
);

create index if not exists bot_manual_chunks_search_idx
  on public.bot_manual_chunks using gin(search_vector);
create index if not exists bot_manual_chunks_manual_idx
  on public.bot_manual_chunks(manual_id,chunk_index);

alter table public.bot_manual_chunks enable row level security;
revoke all on public.bot_manual_chunks from public,anon,authenticated;

create or replace function public.rebuild_bot_manual_chunks(target_manual uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  source_text text;
  words text[];
  word_count integer;
  start_at integer := 1;
  current_index integer := 0;
  chunk_text text;
begin
  select regexp_replace(trim(content),'\s+',' ','g')
    into source_text
  from public.bot_manuals
  where id=target_manual;

  delete from public.bot_manual_chunks where manual_id=target_manual;
  if source_text is null or length(source_text)<20 then return; end if;

  words := regexp_split_to_array(source_text,'\s+');
  word_count := coalesce(array_length(words,1),0);

  -- 160 palavras por trecho, com sobreposição de 40 palavras. A sobreposição
  -- evita perder instruções que estejam na divisão entre dois trechos.
  while start_at<=word_count loop
    chunk_text := array_to_string(words[start_at:least(start_at+159,word_count)],' ');
    if length(chunk_text)>=20 then
      insert into public.bot_manual_chunks(manual_id,chunk_index,content)
      values(target_manual,current_index,chunk_text);
      current_index := current_index+1;
    end if;
    start_at := start_at+120;
  end loop;
end;
$$;

create or replace function public.index_bot_manual_on_write()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.rebuild_bot_manual_chunks(new.id);
  return new;
end;
$$;

drop trigger if exists bot_manual_index_after_write on public.bot_manuals;
create trigger bot_manual_index_after_write
after insert or update of content on public.bot_manuals
for each row execute function public.index_bot_manual_on_write();

do $$
declare manual_row record;
begin
  for manual_row in select id from public.bot_manuals loop
    perform public.rebuild_bot_manual_chunks(manual_row.id);
  end loop;
end;
$$;

create or replace function public.search_bot_manuals(
  question text,
  driver_technology text default null,
  result_limit integer default 3
)
returns table(id uuid,title text,technology text,excerpt text,rank real)
language sql stable security definer set search_path=public as $$
  with query as (
    select
      websearch_to_tsquery('portuguese',trim(question)) strict_query,
      to_tsquery(
        'portuguese',
        replace(plainto_tsquery('portuguese',trim(question))::text,' & ',' | ')
      ) loose_query
  ), ranked as (
    select
      m.id,m.title,m.technology,c.chunk_index,
      ts_headline(
        'portuguese',c.content,q.loose_query,
        'MaxFragments=1,MaxWords=34,MinWords=8'
      ) excerpt,
      (
        ts_rank_cd(c.search_vector,q.strict_query)*4
        + ts_rank_cd(c.search_vector,q.loose_query)
      )::real rank
    from public.bot_manual_chunks c
    join public.bot_manuals m on m.id=c.manual_id and m.active
    cross join query q
    where q.loose_query @@ c.search_vector
      and (
        driver_technology is null
        or m.technology is null
        or lower(trim(m.technology))=lower(trim(driver_technology))
      )
  )
  select r.id,r.title,r.technology,r.excerpt,r.rank
  from ranked r
  where r.rank>0
  order by r.rank desc,r.chunk_index
  limit greatest(1,least(coalesce(result_limit,3),5));
$$;

revoke execute on function public.rebuild_bot_manual_chunks(uuid) from public,anon,authenticated;
revoke execute on function public.search_bot_manuals(text,text,integer) from public,anon;
grant execute on function public.search_bot_manuals(text,text,integer) to authenticated,service_role;

commit;
