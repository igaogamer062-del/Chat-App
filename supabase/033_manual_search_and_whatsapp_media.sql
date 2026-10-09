-- Smart Chat | busca flexível nos manuais e persistência das mídias do WhatsApp
begin;

update storage.buckets
set allowed_mime_types=array[
  'image/jpeg','image/png','image/webp','image/gif',
  'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/aac','audio/opus',
  'video/mp4','video/webm','video/quicktime','application/pdf'
]
where id='checklist-chat-files';

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
    select m.id,m.title,m.technology,
      ts_headline(
        'portuguese',m.content,q.loose_query,
        'MaxFragments=4,MaxWords=80,MinWords=12'
      ) excerpt,
      (
        ts_rank_cd(
          to_tsvector('portuguese',coalesce(m.title,'')||' '||coalesce(m.technology,'')||' '||m.content),
          q.strict_query
        ) * 2
        + ts_rank_cd(
          to_tsvector('portuguese',coalesce(m.title,'')||' '||coalesce(m.technology,'')||' '||m.content),
          q.loose_query
        )
      )::real rank
    from public.bot_manuals m cross join query q
    where m.active
      and q.loose_query @@ to_tsvector(
        'portuguese',coalesce(m.title,'')||' '||coalesce(m.technology,'')||' '||m.content
      )
      and (
        driver_technology is null
        or m.technology is null
        or lower(trim(m.technology))=lower(trim(driver_technology))
      )
  )
  select r.id,r.title,r.technology,r.excerpt,r.rank
  from ranked r
  where r.rank>0
  order by r.rank desc
  limit greatest(1,least(coalesce(result_limit,3),5));
$$;

revoke execute on function public.search_bot_manuals(text,text,integer) from public,anon;
grant execute on function public.search_bot_manuals(text,text,integer) to authenticated,service_role;

commit;
