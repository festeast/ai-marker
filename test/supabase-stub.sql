-- Минимальная замена того, что Supabase уже создаёт сам: схема auth, роли и auth.uid().
-- Нужна только для тестов на обычном Postgres.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
alter table auth.users add column if not exists created_at timestamptz default now(),
  add column if not exists last_sign_in_at timestamptz,
  add column if not exists raw_user_meta_data jsonb default '{}'::jsonb;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
