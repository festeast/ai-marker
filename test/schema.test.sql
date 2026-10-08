-- Тесты схемы: запускаются от лица anon (студент) и authenticated (учитель),
-- как это делает Supabase. Любая ошибка останавливает прогон.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'ожидалась ошибка %, но её не было: %', p_message, p_sql;
exception when others then
  if sqlerrm <> p_message then raise exception 'ожидалась ошибка %, получено: %', p_message, sqlerrm; end if;
end $$;

create or replace function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'проверка не прошла: %', p_what; end if;
end $$;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@school.kz'),
  ('22222222-2222-2222-2222-222222222222', 'b@school.kz');

-- ---------- учитель A создаёт быстрый тест ----------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select pg_temp.expect_error($$ select create_exam('', 'quiz') $$, 'title_required');
select pg_temp.expect_error($$ select create_exam('X', 'essay') $$, 'invalid_type');
select (create_exam('Алгебра', 'quiz')->>'id')::bigint as exam_id \gset

select pg_temp.expect_error(format('select publish_exam(%s)', :exam_id), 'no_questions');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Алгебра', '[{"text":"2+2","options":["3","4"]}]') $$, :exam_id), 'quiz_needs_correct');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Алгебра', '[{"text":"2+2","options":["3",""],"correctIndex":0}]') $$, :exam_id), 'quiz_needs_options');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Алгебра', '[{"text":"2+2","options":["3","4"],"correctIndex":2}]') $$, :exam_id), 'quiz_needs_correct');

select pg_temp.check(jsonb_array_length(save_exam(:exam_id, 'Алгебра 7 класс',
  '[{"text":"2+2","options":["3","4"],"correctIndex":1},{"text":"3*3","options":["9","6"],"correctIndex":0}]')->'questions') = 2,
  'сохранено 2 вопроса');

select publish_exam(:exam_id)->>'code' as code \gset
select pg_temp.check(:'code' ~ '^[A-HJ-NP-Z2-9]{6}$', 'код из 6 символов');
select pg_temp.expect_error(format($$ select save_exam(%s, 'X', '[]') $$, :exam_id), 'exam_locked');

-- прямой доступ к таблицам закрыт
select pg_temp.check((select count(*) from exams) = 0, 'учитель не читает таблицы напрямую');

-- ---------- учитель B не видит чужой экзамен ----------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format('select exam_monitor(%s, 0)', :exam_id), 'not_found');
select pg_temp.check(list_exams() = '[]'::jsonb, 'у B нет экзаменов');

-- ---------- студент (anon) ----------
reset request.jwt.claim.sub;
set role anon;
select pg_temp.expect_error($$ select list_exams() $$, 'unauthorized');
select pg_temp.expect_error($$ select exam_by_code('NOPE00') $$, 'exam_not_found');
select pg_temp.check(exam_by_code(lower(:'code'))->>'title' = 'Алгебра 7 класс', 'код без учёта регистра');
select pg_temp.check((select count(*) from questions) = 0, 'студент не читает вопросы с ответами');

select join_exam(:'code', '  Ерлан  ') as token \gset
select pg_temp.check(not (get_attempt(:'token')->'questions'->0 ? 'correctIndex'), 'верные ответы скрыты от студента');
select (get_attempt(:'token')->'questions'->0->>'id') as q1, (get_attempt(:'token')->'questions'->1->>'id') as q2 \gset

select log_event(:'token', 'return', '{"awayMs":5}');            -- возвращение без ухода не пишется
select log_event(:'token', 'leave', '{"reason":"hidden"}');
select log_event(:'token', 'leave', '{"reason":"close"}');        -- повторный уход не пишется
select log_event(:'token', 'return', '{"awayMs":12000}');
select log_event(:'token', 'paste', jsonb_build_object('text', repeat('x', 500), 'questionId', :q2::bigint));
select log_event(:'token', 'paste', '{"text":"short"}');
select pg_temp.expect_error(format($$ select log_event(%L, 'hack', '{}') $$, :'token'), 'invalid_event');
select save_answers(:'token', jsonb_build_object(:'q1', '1'));
select submit_attempt(:'token', jsonb_build_object(:'q2', '1'));
select pg_temp.expect_error(format($$ select save_answers(%L, '{}') $$, :'token'), 'already_submitted');
select pg_temp.expect_error($$ select get_attempt('00000000-0000-0000-0000-000000000000') $$, 'unauthorized');

-- ---------- учитель A смотрит мониторинг ----------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select exam_monitor(:exam_id, 0) as mon \gset
select pg_temp.check((:'mon'::jsonb)->'participants'->0->>'name' = 'Ерлан', 'имя обрезано');
select pg_temp.check((:'mon'::jsonb)->'participants'->0->>'status' = 'submitted', 'статус сдал');
select pg_temp.check(((:'mon'::jsonb)->'participants'->0->>'leaveCount')::int = 1, 'один уход');
select pg_temp.check(((:'mon'::jsonb)->'participants'->0->>'awayMs')::int = 12000, 'время вне вкладки');
select pg_temp.check(((:'mon'::jsonb)->'participants'->0->>'largePasteCount')::int = 1, 'одна большая вставка');
select pg_temp.check(((:'mon'::jsonb)->'participants'->0->>'answeredCount')::int = 2, 'два ответа');
select pg_temp.check((:'mon'::jsonb)->'participants'->0->'score' = '{"correct":1,"total":2}', 'баллы 1 из 2');
select pg_temp.check((select jsonb_agg(e->>'type') from jsonb_array_elements((:'mon'::jsonb)->'events') e)
  = '["join","leave","return","paste","paste","submit"]', 'лента событий');
select pg_temp.check(length((:'mon'::jsonb)->'events'->3->'detail'->>'snippet') = 500, 'текст вставки сохранён');
select pg_temp.check(jsonb_array_length(exam_monitor(:exam_id, ((:'mon'::jsonb)->'events'->5->>'id')::bigint)->'events') = 0,
  'опрос возвращает только новые события');

-- ---------- закрытый экзамен ----------
select close_exam(:exam_id);
set role anon;
select pg_temp.expect_error(format($$ select join_exam(%L, 'S') $$, :'code'), 'exam_not_open');

-- ---------- текстовый экзамен и удаление ----------
set role authenticated;
select (create_exam('Эссе', 'text')->>'id')::bigint as essay_id \gset
select pg_temp.check(save_exam(:essay_id, 'Эссе', '[{"text":"Опишите…"}]')->'questions'->0->'options' is null, 'у текстового вопроса нет вариантов');
select delete_exam(:essay_id);
select pg_temp.check(jsonb_array_length(list_exams()) = 1, 'экзамен удалён');


