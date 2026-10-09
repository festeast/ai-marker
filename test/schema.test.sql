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

-- ---------- результаты теста: баллы вопросов ----------
select exam_results(:exam_id) as res \gset
select pg_temp.check((:'res'::jsonb)->>'maxScore' = '2', 'максимум 2 балла');
select pg_temp.check((:'res'::jsonb)->'participants'->0->>'total' = '1', 'итог теста 1');
select pg_temp.check((:'res'::jsonb)->'participants'->0->'answers'->:'q2'->>'score' = '0', 'неверный ответ 0 баллов');

-- ---------- текстовый экзамен: эталон, баллы, ручная оценка ----------
select (create_exam('Химия', 'text')->>'id')::bigint as chem_id \gset
select pg_temp.expect_error(format($$ select save_exam(%s, 'Химия', '[{"text":"Что такое моль?","points":0}]') $$, :chem_id), 'invalid_points');
select save_exam(:chem_id, 'Химия', '[{"text":"Что такое моль?","points":5,"reference":"Количество вещества, 6,02·10^23 частиц"},{"text":"Формула воды?"}]') as chem \gset
select pg_temp.check((:'chem'::jsonb)->'questions'->0->>'reference' like 'Количество%', 'эталон сохранён');
select pg_temp.check((:'chem'::jsonb)->'questions'->1->>'points' = '1', 'баллы по умолчанию 1');
select (:'chem'::jsonb)->'questions'->0->>'id' as cq1, (:'chem'::jsonb)->'questions'->1->>'id' as cq2 \gset
select publish_exam(:chem_id)->>'code' as chem_code \gset

reset request.jwt.claim.sub;
set role anon;
select join_exam(:'chem_code', 'Дана') as ctoken \gset
select pg_temp.check(not (get_attempt(:'ctoken')->'questions'->0 ? 'reference'), 'эталон скрыт от студента');
select submit_attempt(:'ctoken', jsonb_build_object(:'cq1', 'Это единица количества вещества', :'cq2', 'H2O'));
select pg_temp.expect_error(format('select set_grade(1, %s, 1)', :cq1), 'unauthorized');

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (exam_results(:chem_id)->'participants'->0->>'id')::bigint as cp \gset
select pg_temp.check(exam_results(:chem_id)->'participants'->0->'total' = 'null', 'без оценок итога нет');
select pg_temp.expect_error(format('select set_grade(%s, %s, 6)', :cp, :cq1), 'invalid_score');
select pg_temp.expect_error(format('select set_grade(%s, %s, 1)', (exam_results(:exam_id)->'participants'->0->>'id'), :q1), 'not_gradable');
select set_grade(:cp, :cq1, 4, 'Нет числа Авогадро');
select set_grade(:cp, :cq2, 1);
select exam_results(:chem_id) as cres \gset
select pg_temp.check((:'cres'::jsonb)->'participants'->0->>'total' = '5', 'итог 5');
select pg_temp.check((:'cres'::jsonb)->'participants'->0->>'gradedCount' = '2', 'оценены оба ответа');
select pg_temp.check((:'cres'::jsonb)->'participants'->0->'answers'->:'cq1'->>'comment' = 'Нет числа Авогадро', 'комментарий');
select pg_temp.check((:'cres'::jsonb)->'participants'->0->'answers'->:'cq1'->>'source' = 'teacher', 'источник оценки');

-- оценки ИИ: не трогают оценки учителя, округляются до 0,5 и не выходят за максимум
select set_grade(:cp, :cq2, 0);
select pg_temp.check(save_ai_grades(:chem_id, jsonb_build_array(
  jsonb_build_object('participantId', :cp, 'questionId', :cq1::bigint, 'score', 9, 'comment', 'ИИ'),
  jsonb_build_object('participantId', :cp, 'questionId', :cq2::bigint, 'score', 1, 'comment', 'ИИ'))) = 0,
  'ИИ не перезаписывает учителя');
delete from grades;  -- от имени authenticated таблица недоступна
reset role;
delete from grades;
set role authenticated;
select pg_temp.check(save_ai_grades(:chem_id, jsonb_build_array(
  jsonb_build_object('participantId', :cp, 'questionId', :cq1::bigint, 'score', 9, 'comment', 'Хорошо'),
  jsonb_build_object('participantId', :cp, 'questionId', :cq2::bigint, 'score', 0.3))) = 2, 'ИИ поставил 2 оценки');
select exam_results(:chem_id) as ai \gset
select pg_temp.check((:'ai'::jsonb)->'participants'->0->'answers'->:'cq1'->>'score' = '5', 'балл ограничен максимумом');
select pg_temp.check((:'ai'::jsonb)->'participants'->0->'answers'->:'cq2'->>'score' = '0.5', 'балл округлён до 0,5');
select pg_temp.check((:'ai'::jsonb)->'participants'->0->'answers'->:'cq1'->>'source' = 'ai', 'источник ИИ');
select set_grade(:cp, :cq1, 3, 'Учитель исправил');
select pg_temp.check(exam_results(:chem_id)->'participants'->0->'answers'->:'cq1'->>'source' = 'teacher', 'учитель исправил оценку ИИ');
select pg_temp.expect_error(format($$ select save_ai_grades(%s, '[]') $$, :exam_id), 'not_gradable');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format($$ select save_ai_grades(%s, '[]') $$, :chem_id), 'not_found');
select pg_temp.expect_error(format('select set_grade(%s, %s, 1)', :cp, :cq1), 'not_found');
select pg_temp.expect_error(format('select exam_results(%s)', :chem_id), 'not_found');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- ---------- текстовый экзамен и удаление ----------
set role authenticated;
select (create_exam('Эссе', 'text')->>'id')::bigint as essay_id \gset
select pg_temp.check(save_exam(:essay_id, 'Эссе', '[{"text":"Опишите…"}]')->'questions'->0->'options' is null, 'у текстового вопроса нет вариантов');
select delete_exam(:essay_id);
select pg_temp.check(jsonb_array_length(list_exams()) = 2, 'экзамен удалён');



-- ---------- класс, библиотека, профиль ----------
select pg_temp.check(update_exam_meta(:exam_id, ' 7А ', null)->>'className' = '7А', 'класс сохранён без пробелов');
select pg_temp.expect_error($$ select save_material(null, ' ', 'Химия', 'текст') $$, 'title_required');
select pg_temp.expect_error($$ select save_material(null, 'Моль', 'Химия', ' ') $$, 'material_empty');
select pg_temp.expect_error($$ select save_material(null, 'Моль', 'Химия', null, '22222222-2222-2222-2222-222222222222/a.pdf', 'a.pdf') $$, 'invalid_file');
select (save_material(null, 'Моль', 'Химия', 'Моль — 6,02·10^23 частиц.')->>'id')::bigint as mid \gset
select pg_temp.check(save_material(:mid, 'Моль (конспект)', 'Химия', 'Моль — 6,02·10^23 частиц.',
  '11111111-1111-1111-1111-111111111111/1-mol.pdf', 'моль.pdf')->>'fileName' = 'моль.pdf', 'файл привязан');
select pg_temp.check(update_exam_meta(:chem_id, '7А', array[:mid]::bigint[])->'materialIds' = jsonb_build_array(:mid), 'материал привязан к экзамену');
select pg_temp.check(exam_results(:chem_id)->'materials'->0->>'content' like 'Моль%', 'материал попадает в проверку ИИ');
select pg_temp.check(list_materials()->0->>'examCount' = '1', 'материал используется в одном экзамене');

select teacher_stats() as st \gset
select pg_temp.check(jsonb_array_length((:'st'::jsonb)->'exams') = 2, 'в профиле 2 экзамена');
select pg_temp.check((:'st'::jsonb)->>'students' = '2', 'двое учеников');
select pg_temp.check((:'st'::jsonb)->>'materials' = '1', 'один материал');
select pg_temp.check((:'st'::jsonb)->'classes'->0->>'className' = '7А', 'класс 7А');
select pg_temp.check((:'st'::jsonb)->'classes'->0->>'avgPercent' = '54.2', 'средний процент класса (50 и 58,3)');
select pg_temp.check(jsonb_array_length((:'st'::jsonb)->'classes'->0->'studentList') = 2, 'ученики класса');
select pg_temp.check((select e->>'avgPercent' from jsonb_array_elements((:'st'::jsonb)->'exams') e where (e->>'id')::bigint = :chem_id) = '58.3',
  'средний процент экзамена');
select pg_temp.check(list_classes() = '["7А"]'::jsonb, 'список классов');

-- чужой учитель не видит и не привязывает материалы A
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.check(list_materials() = '[]'::jsonb, 'у B нет материалов');
select (create_exam('Физика', 'text')->>'id')::bigint as phys_id \gset
select pg_temp.check(update_exam_meta(:phys_id, null, array[:mid]::bigint[])->'materialIds' = '[]'::jsonb, 'чужой материал не привязывается');
select pg_temp.expect_error(format('select delete_material(%s)', :mid), 'not_found');
select pg_temp.expect_error(format($$ select update_exam_meta(%s, '7А', null) $$, :chem_id), 'not_found');
select pg_temp.check(teacher_stats()->'classes'->0->>'className' = '', 'экзамен без класса');

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(delete_material(:mid)->>'filePath' like '11111111-%', 'удаление возвращает путь файла');
select pg_temp.check(get_exam(:chem_id)->'materialIds' = '[]'::jsonb, 'связь удалена вместе с материалом');

reset request.jwt.claim.sub;
set role anon;
select pg_temp.expect_error($$ select teacher_stats() $$, 'unauthorized');
select pg_temp.expect_error($$ select list_materials() $$, 'unauthorized');
