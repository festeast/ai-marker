#!/usr/bin/env bash
# Прогоняет supabase/schema.sql и тесты на пустой базе Postgres.
# Использование: DATABASE_URL=postgres://... test/run-sql-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGOPTIONS='-c client_min_messages=warning'
run() { psql "$DATABASE_URL" -q -X -v ON_ERROR_STOP=1 "$@" > /dev/null; }
run -c 'drop schema if exists public cascade; drop schema if exists auth cascade; create schema public;'
run -f test/supabase-stub.sql
run -f supabase/schema.sql
run -f supabase/schema.sql   # повторный запуск схемы тоже должен проходить
run -f test/schema.test.sql
echo 'Все тесты схемы прошли'
