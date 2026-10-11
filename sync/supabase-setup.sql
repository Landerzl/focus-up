-- Focus Up cloud sync: run this ONCE in your own Supabase project.
-- Supabase dashboard -> SQL Editor -> New query -> paste everything -> Run.
-- Safe to run again: it only creates what is missing and refreshes the policies and functions.

create table if not exists public.focus_records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('session', 'project')),
  id         text        not null check (char_length(id) between 1 and 64),
  data       jsonb       not null default '{}'::jsonb check (pg_column_size(data) < 20000),
  updated_at bigint      not null,                   -- when it was last edited (ms); the newest edit wins
  deleted    boolean     not null default false,     -- deletions are kept as "tombstones" so every device hears about them
  server_ts  timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, id)
);

create index if not exists focus_records_pull on public.focus_records (user_id, server_ts);

-- Row Level Security: every person can only ever read or change their OWN rows.
alter table public.focus_records enable row level security;

drop policy if exists "own rows: read"   on public.focus_records;
drop policy if exists "own rows: insert" on public.focus_records;
drop policy if exists "own rows: update" on public.focus_records;
create policy "own rows: read"   on public.focus_records for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.focus_records for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.focus_records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- There is deliberately no delete policy: nothing can be hard-deleted through the API.

-- Only logged-in users get any access to the table at all; the anonymous key gets none.
revoke all on public.focus_records from anon;
grant select, insert, update on public.focus_records to authenticated;

-- The server stamps every change, so devices can ask "what changed since I last looked?".
create or replace function public.focus_touch() returns trigger
language plpgsql as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end $$;

drop trigger if exists focus_touch on public.focus_records;
create trigger focus_touch before insert or update on public.focus_records
  for each row execute function public.focus_touch();

-- Atomic "newest edit wins" upsert, used by the extension. It runs with the caller's rights,
-- so Row Level Security applies and user_id always comes from the login, never from the client.
create or replace function public.focus_upsert(records jsonb) returns void
language sql security invoker as $$
  insert into public.focus_records (user_id, kind, id, data, updated_at, deleted)
  select auth.uid(),
         r ->> 'kind',
         r ->> 'id',
         coalesce(r -> 'data', '{}'::jsonb),
         (r ->> 'updated_at')::bigint,
         coalesce((r ->> 'deleted')::boolean, false)
  from jsonb_array_elements(records) as r
  on conflict (user_id, kind, id) do update
    set data       = excluded.data,
        updated_at = excluded.updated_at,
        deleted    = excluded.deleted
    where public.focus_records.updated_at < excluded.updated_at;
$$;

revoke all on function public.focus_upsert(jsonb) from public, anon;
grant execute on function public.focus_upsert(jsonb) to authenticated;
