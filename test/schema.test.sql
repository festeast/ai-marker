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

-- ---------- смешанный экзамен: «верно/неверно», «по порядку», открытый вопрос, перемешивание ----------
reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (create_exam('Смешанный', 'mixed', true)->>'id')::bigint as mix_id \gset
select pg_temp.check((get_exam(:mix_id)->>'shuffle')::boolean, 'перемешивание включено');
select pg_temp.expect_error(format($$ select save_exam(%s, 'С', '[{"kind":"essay","text":"x"}]') $$, :mix_id), 'invalid_kind');
select pg_temp.expect_error(format($$ select save_exam(%s, 'С', '[{"kind":"truefalse","text":"x","options":["a","b","c"],"correctIndex":0}]') $$, :mix_id), 'quiz_needs_options');
select pg_temp.expect_error(format($$ select save_exam(%s, 'С', '[{"kind":"order","text":"x","options":["a"]}]') $$, :mix_id), 'quiz_needs_options');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Т', '[{"kind":"text","text":"x"}]') $$, :exam_id), 'exam_locked');
select save_exam(:mix_id, 'Смешанный', '[
  {"kind":"choice","text":"Столица Казахстана","options":["Астана","Алматы","Шымкент"],"correctIndex":0,"points":1},
  {"kind":"truefalse","text":"Вода кипит при 100°C","options":["Верно","Неверно"],"correctIndex":0,"points":1},
  {"kind":"order","text":"По возрастанию","options":["1","5","10","50"],"points":2},
  {"kind":"text","text":"Что такое фотосинтез?","reference":"свет, хлорофилл","points":3}]'::jsonb) as mix \gset
select pg_temp.check((select string_agg(q->>'kind', ',') from jsonb_array_elements((:'mix'::jsonb)->'questions') q) = 'choice,truefalse,order,text', 'виды вопросов сохранены');
select pg_temp.check((:'mix'::jsonb)->'questions'->2->'options' = '["1","5","10","50"]', 'порядок вариантов сохранён');
select pg_temp.check(get_exam(:mix_id)->'tools' = '[]'::jsonb, 'инструментов по умолчанию нет');
select pg_temp.expect_error(format($$ select set_exam_tools(%s, array['calculator', 'phone']) $$, :mix_id), 'invalid_tool');
select pg_temp.check(set_exam_tools(:mix_id, array['periodic', 'calculator', 'sheet', 'calculator'], 'pV = nRT')->'tools'
  = '["calculator", "periodic", "sheet"]'::jsonb, 'инструменты сохранены без повторов');
select publish_exam(:mix_id)->>'code' as mix_code \gset
select (q->>'id')::bigint as q_choice from jsonb_array_elements((:'mix'::jsonb)->'questions') q where q->>'kind' = 'choice' \gset
select (q->>'id')::bigint as q_tf from jsonb_array_elements((:'mix'::jsonb)->'questions') q where q->>'kind' = 'truefalse' \gset
select (q->>'id')::bigint as q_order from jsonb_array_elements((:'mix'::jsonb)->'questions') q where q->>'kind' = 'order' \gset
select (q->>'id')::bigint as q_text from jsonb_array_elements((:'mix'::jsonb)->'questions') q where q->>'kind' = 'text' \gset

reset request.jwt.claim.sub;
set role anon;
select join_exam(:'mix_code', 'Айдана') as t1 \gset
select join_exam(:'mix_code', 'Бауыржан') as t2 \gset
select get_attempt(:'t1') as a1 \gset
select pg_temp.check(jsonb_array_length((:'a1'::jsonb)->'questions') = 4, 'ученик видит 4 вопроса');
select pg_temp.check((:'a1'::jsonb)->'exam'->'tools' = '["calculator", "periodic", "sheet"]'::jsonb
  and (:'a1'::jsonb)->'exam'->>'toolsSheet' = 'pV = nRT', 'ученик получает разрешённые инструменты и справочный лист');
select pg_temp.check(not exists (select 1 from jsonb_array_elements((:'a1'::jsonb)->'questions') q where q ? 'correctIndex' or q ? 'reference'), 'ответы скрыты');
select pg_temp.check((select (select string_agg(o->>'i', ',') from jsonb_array_elements(q->'options') o) <> '0,1,2,3'
  from jsonb_array_elements((:'a1'::jsonb)->'questions') q where q->>'kind' = 'order'), 'порядок перемешан');
select pg_temp.check((select string_agg(o->>'text', ',' order by (o->>'i')::int) from jsonb_array_elements((:'a1'::jsonb)->'questions') q,
  jsonb_array_elements(q->'options') o where q->>'kind' = 'order') = '1,5,10,50', 'варианты помечены номерами учителя');
select pg_temp.check(get_attempt(:'t1')->'questions' = (:'a1'::jsonb)->'questions', 'перемешивание не меняется при перезагрузке');
-- запросы инструментов
select pg_temp.expect_error(format($$ select request_tool(%L, 'phone') $$, :'t1'), 'invalid_tool');
select pg_temp.check(request_tool(:'t1', 'calculator')->'requests' = '[]'::jsonb, 'уже доступный инструмент не запрашивается');
select pg_temp.check(request_tool(:'t1', 'code')->'requests' = '[{"tool": "code", "status": "pending"}]'::jsonb, 'запрос отправлен');
select request_tool(:'t2', 'code');
reset role;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set role authenticated;
select pg_temp.expect_error(format('select list_tool_requests(%s)', :mix_id), 'not_found');
reset role;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select list_tool_requests(:mix_id) as tr \gset
select pg_temp.check(jsonb_array_length((:'tr'::jsonb)->'requests') = 2, 'учитель видит два запроса');
select (r->>'participantId')::bigint as tr_p1 from jsonb_array_elements((:'tr'::jsonb)->'requests') r where r->>'name' = 'Айдана' \gset
select decide_tool_requests(:mix_id, 'code', true, 'one', :tr_p1);
select pg_temp.check((select r->>'status' from jsonb_array_elements(decide_tool_requests(:mix_id, 'code', false, 'requested')->'requests') r
  where r->>'name' = 'Бауыржан') = 'denied', 'отказ всем, кто ждёт');
reset role;
reset request.jwt.claim.sub;
set role anon;
select pg_temp.check(attempt_tools(:'t1')->'tools' ? 'code', 'инструмент выдан одному ученику');
select pg_temp.check(get_attempt(:'t1')->'exam'->'tools' ? 'code', 'выданный инструмент виден при загрузке');
select pg_temp.check(not (attempt_tools(:'t2')->'tools' ? 'code'), 'другому ученику не выдан');
select pg_temp.check(request_tool(:'t2', 'code')->'requests'->0->>'status' = 'pending', 'после отказа можно попросить снова');
reset role;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select pg_temp.check(decide_tool_requests(:mix_id, 'code', true, 'everyone')->'tools' ? 'code', 'инструмент включён для всего экзамена');
select set_exam_tools(:mix_id, array['calculator', 'periodic', 'sheet'], 'pV = nRT');
reset role;
reset request.jwt.claim.sub;
set role anon;
select pg_temp.check(attempt_tools(:'t2')->'requests'->0->>'status' = 'granted', 'ожидающий запрос выполнен');
select submit_attempt(:'t1', jsonb_build_object(:'q_choice', '0', :'q_tf', '0', :'q_order', '0,1,2,3', :'q_text', 'Свет и хлорофилл'));
select submit_attempt(:'t2', jsonb_build_object(:'q_choice', '1', :'q_tf', '1', :'q_order', '3,2,1,0'));

reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select exam_results(:mix_id) as mr \gset
select pg_temp.check((select p->>'total' from jsonb_array_elements((:'mr'::jsonb)->'participants') p where p->>'name' = 'Айдана') = '4', 'автопроверка: 1 + 1 + 2');
select pg_temp.check((select p->>'gradedCount' from jsonb_array_elements((:'mr'::jsonb)->'participants') p where p->>'name' = 'Айдана') = '3', 'открытый вопрос ещё не оценён');
select pg_temp.check((select p->>'total' from jsonb_array_elements((:'mr'::jsonb)->'participants') p where p->>'name' = 'Бауыржан') = '0', 'неверные ответы — 0');
select pg_temp.check((select (m->'score'->>'correct') || '/' || (m->'score'->>'total') from jsonb_array_elements(exam_monitor(:mix_id, 0)->'participants') m where m->>'name' = 'Айдана') = '3/3', 'мониторинг считает тестовые вопросы');
select (p->>'id')::bigint as pid1 from jsonb_array_elements((:'mr'::jsonb)->'participants') p where p->>'name' = 'Айдана' \gset
select pg_temp.expect_error(format('select set_grade(%s, %s, 1)', :pid1, :q_choice), 'not_gradable');
select set_grade(:pid1, :q_text, 2.5);
select pg_temp.check(save_ai_grades(:mix_id, jsonb_build_array(jsonb_build_object('participantId', :pid1, 'questionId', :q_choice, 'score', 1))) = 0, 'ИИ не оценивает тестовые вопросы');
select pg_temp.check((select p->>'total' from jsonb_array_elements(exam_results(:mix_id)->'participants') p where p->>'name' = 'Айдана') = '6.5', 'итог с оценкой учителя');
select pg_temp.check((select e->>'avgPercent' from jsonb_array_elements(teacher_stats()->'exams') e where (e->>'id')::bigint = :mix_id) = '92.9', 'средний процент смешанного экзамена');
select pg_temp.check(not (set_exam_shuffle(:mix_id, false)->>'shuffle')::boolean, 'перемешивание выключено');

-- администратор
reset role;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select pg_temp.check(not is_admin(), 'A пока не администратор');
select pg_temp.expect_error($$ select admin_users() $$, 'forbidden');
reset role;
insert into public.admins (user_id) values ('11111111-1111-1111-1111-111111111111') on conflict do nothing;
set role authenticated;
select pg_temp.check(is_admin(), 'A стал администратором');
select admin_users() as au \gset
select pg_temp.check(((:'au'::jsonb)->'totals'->>'users')::int = 2, 'всего пользователей');
select pg_temp.check(((:'au'::jsonb)->'totals'->>'exams')::int = 4, 'всего экзаменов');
select pg_temp.check((select (u->>'isAdmin')::boolean from jsonb_array_elements((:'au'::jsonb)->'users') u
  where u->>'id' = '11111111-1111-1111-1111-111111111111'), 'отмечен администратор');
select pg_temp.check((select (u->>'exams')::int from jsonb_array_elements((:'au'::jsonb)->'users') u
  where u->>'id' = '22222222-2222-2222-2222-222222222222') = 1, 'экзамены пользователя B');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error($$ select admin_users() $$, 'forbidden');
reset request.jwt.claim.sub;
set role anon;
select pg_temp.expect_error($$ select admin_users() $$, 'unauthorized');
select pg_temp.check(not is_admin(), 'аноним не администратор');

-- ---------- вопросы с кодом ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (create_exam('Программирование', 'text')->>'id')::bigint as code_id \gset
select pg_temp.expect_error(format($$ select save_exam(%s, 'П', '[{"kind":"code","text":"x"}]') $$, :code_id), 'invalid_code_lang');
select pg_temp.expect_error(format($$ select save_exam(%s, 'П', '[{"kind":"code","lang":"cobol","text":"x"}]') $$, :code_id), 'invalid_code_lang');
select pg_temp.expect_error(format($$ select save_exam(%s, 'П', '[{"kind":"code","lang":"python","text":"x","tests":[{"input":"1"}]}]') $$, :code_id), 'invalid_tests');
select pg_temp.expect_error(format($$ select save_exam(%s, 'П', '[{"kind":"code","lang":"python","text":"x","tests":"1"}]') $$, :code_id), 'invalid_tests');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Алгебра', '[{"kind":"code","lang":"python","text":"x"}]') $$, :exam_id), 'exam_locked');
select save_exam(:code_id, 'Программирование', '[
  {"kind":"code","lang":"python","text":"Сложите два числа","starter":"a, b = map(int, input().split())\n","tests":[{"input":"2 3","output":"5"},{"input":"10 -4","output":"6"}],"points":4},
  {"kind":"code","lang":"java","text":"Выведите Hello","tests":[],"points":2},
  {"kind":"text","text":"Что такое цикл?","points":1}]'::jsonb) as cx \gset
select pg_temp.check((:'cx'::jsonb)->'questions'->0->>'lang' = 'python', 'язык сохранён');
select pg_temp.check(jsonb_array_length((:'cx'::jsonb)->'questions'->0->'tests') = 2, 'тесты сохранены');
select pg_temp.check(not ((:'cx'::jsonb)->'questions'->1 ? 'tests'), 'пустой список тестов не хранится');
select (q->>'id')::bigint as q_py from jsonb_array_elements((:'cx'::jsonb)->'questions') q where q->>'lang' = 'python' \gset
select (q->>'id')::bigint as q_java from jsonb_array_elements((:'cx'::jsonb)->'questions') q where q->>'lang' = 'java' \gset
select publish_exam(:code_id)->>'code' as code_code \gset

reset request.jwt.claim.sub;
set role anon;
select join_exam(:'code_code', 'Ерлан') as tc \gset
select get_attempt(:'tc') as ac \gset
select pg_temp.check((select q->>'starter' from jsonb_array_elements((:'ac'::jsonb)->'questions') q where q->>'lang' = 'python') like 'a, b%', 'ученик видит заготовку');
select pg_temp.check(not exists (select 1 from jsonb_array_elements((:'ac'::jsonb)->'questions') q where q ? 'tests'), 'тесты скрыты от ученика');
select submit_attempt(:'tc', jsonb_build_object(:'q_py', 'a, b = map(int, input().split())' || chr(10) || 'print(a + b)', :'q_java', 'class Main {}'));

reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (p->>'id')::bigint as pid_c from jsonb_array_elements(exam_results(:code_id)->'participants') p \gset
select pg_temp.check(save_test_grades(:code_id, jsonb_build_array(
  jsonb_build_object('participantId', :pid_c, 'questionId', :q_py, 'score', 3.9, 'comment', 'Тесты: 2 из 2'))) = 1, 'баллы по тестам сохранены');
select pg_temp.check((exam_results(:code_id)->'participants'->0->'answers'->(:'q_py')->>'score') = '4', 'балл округлён и ограничен максимумом');
select pg_temp.check((exam_results(:code_id)->'participants'->0->'answers'->(:'q_py')->>'source') = 'tests', 'источник — тесты');
select pg_temp.check(save_ai_grades(:code_id, jsonb_build_array(
  jsonb_build_object('participantId', :pid_c, 'questionId', :q_py, 'score', 1),
  jsonb_build_object('participantId', :pid_c, 'questionId', :q_java, 'score', 1.5))) = 1, 'ИИ не перезаписывает тесты, но оценивает код без тестов');
select set_grade(:pid_c, :q_py, 2);
select pg_temp.check(save_test_grades(:code_id, jsonb_build_array(
  jsonb_build_object('participantId', :pid_c, 'questionId', :q_py, 'score', 4))) = 0, 'тесты не перезаписывают оценку учителя');
select pg_temp.check((exam_results(:code_id)->'participants'->0->>'total') = '3.5', 'итог: 2 + 1.5');
select pg_temp.expect_error(format($$ select save_test_grades(%s, '{}') $$, :code_id), 'invalid_grades');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format($$ select save_test_grades(%s, '[]') $$, :code_id), 'not_found');

-- ---------- копия экзамена ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.expect_error(format($$ select copy_exam(%s, ' ') $$, :code_id), 'title_required');
select copy_exam(:code_id, 'Программирование (копия)') as cp \gset
select pg_temp.check((:'cp'::jsonb)->>'status' = 'draft' and (:'cp'::jsonb)->>'code' is null, 'копия — черновик без кода');
select get_exam(((:'cp'::jsonb)->>'id')::bigint) as cpe \gset
select get_exam(:code_id) as orig \gset
select pg_temp.check((select jsonb_agg(q - 'id') from jsonb_array_elements((:'cpe'::jsonb)->'questions') q)
  = (select jsonb_agg(q - 'id') from jsonb_array_elements((:'orig'::jsonb)->'questions') q), 'вопросы скопированы вместе с тестами');
select pg_temp.check(exam_results(((:'cp'::jsonb)->>'id')::bigint)->'participants' = '[]'::jsonb, 'ответы учеников не копируются');
select (save_material(null, 'Циклы', 'Информатика', 'for, while')->>'id')::bigint as mat2 \gset
select update_exam_meta(:chem_id, '9Б', array[:mat2]::bigint[]);
select (copy_exam(:chem_id, 'Химия 2')->>'id')::bigint as chem2 \gset
select pg_temp.check(get_exam(:chem2)->'materialIds' = jsonb_build_array(:mat2), 'материалы скопированы');
select pg_temp.check(get_exam(:chem2)->>'className' is not distinct from get_exam(:chem_id)->>'className', 'класс скопирован');
select (copy_exam(:mix_id, 'Смешанный 2')->>'id')::bigint as mix2 \gset
select pg_temp.check(get_exam(:mix2)->'tools' = '["calculator", "periodic", "sheet"]'::jsonb and get_exam(:mix2)->>'toolsSheet' = 'pV = nRT', 'инструменты скопированы');
select pg_temp.check(set_exam_tools(:mix2, array['code'], 'не видно')->'tools' = '["code"]'::jsonb, 'инструменты меняются');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format($$ select copy_exam(%s, 'Чужой') $$, :code_id), 'not_found');

-- ---------- отзыв ученику ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(exam_results(:code_id)->'participants'->0->'feedback' = 'null'::jsonb, 'отзыва пока нет');
select pg_temp.check(save_feedback(:pid_c, '  Молодец, повтори циклы.  ', 'ai')->>'source' = 'ai', 'отзыв ИИ сохранён');
select pg_temp.check(exam_results(:code_id)->'participants'->0->'feedback'->>'text' = 'Молодец, повтори циклы.', 'текст отзыва без пробелов по краям');
select save_feedback(:pid_c, 'Исправлено учителем');
select pg_temp.check(exam_results(:code_id)->'participants'->0->'feedback'->>'source' = 'teacher', 'по умолчанию отзыв от учителя');
select pg_temp.expect_error(format($$ select save_feedback(%s, 'x', 'student') $$, :pid_c), 'invalid_request');
select save_feedback(:pid_c, ' ');
select pg_temp.check(exam_results(:code_id)->'participants'->0->'feedback' = 'null'::jsonb, 'пустой текст удаляет отзыв');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format($$ select save_feedback(%s, 'Чужой') $$, :pid_c), 'not_found');
reset request.jwt.claim.sub;
reset role;
set role anon;
select pg_temp.expect_error(format($$ select save_feedback(%s, 'Сам себе') $$, :pid_c), 'unauthorized');

-- ---------- удаление ученика ----------
reset role;
set role anon;
select join_exam(:'code_code', 'Лишний') as tx \gset
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (p->>'id')::bigint as pid_x from jsonb_array_elements(exam_results(:code_id)->'participants') p where p->>'name' = 'Лишний' \gset
select save_feedback(:pid_c, 'Отзыв Ерлану');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format('select delete_participant(%s)', :pid_x), 'not_found');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select delete_participant(:pid_x);
select pg_temp.check(jsonb_array_length(exam_results(:code_id)->'participants') = 1, 'остался один ученик');
select pg_temp.check(exam_results(:code_id)->'participants'->0->'feedback'->>'text' = 'Отзыв Ерлану', 'данные другого ученика не тронуты');
select pg_temp.check((exam_results(:code_id)->'participants'->0->>'total') = '3.5', 'оценки другого ученика не тронуты');
select pg_temp.expect_error(format('select delete_participant(%s)', :pid_x), 'not_found');
select delete_participant(:pid_c);
select pg_temp.check(exam_results(:code_id)->'participants' = '[]'::jsonb, 'ученик удалён');
reset role;
select pg_temp.check(not exists (select from answers where participant_id = :pid_c)
  and not exists (select from feedback where participant_id = :pid_c), 'ответы и отзыв удалены');

-- ---------- строгий режим: блокировка после N уходов ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (create_exam('Строгий', 'quiz')->>'id')::bigint as strict_id \gset
select pg_temp.expect_error(format('select set_exam_strict(%s, true, 0)', :strict_id), 'invalid_request');
select pg_temp.check((set_exam_strict(:strict_id, true, 2)->>'maxLeaves') = '2', 'строгий режим включён');
select save_exam(:strict_id, 'Строгий', '[{"text":"2+2","options":["3","4"],"correctIndex":1}]');
select publish_exam(:strict_id)->>'code' as strict_code \gset
select pg_temp.check((copy_exam(:strict_id, 'Копия строгого')->>'strictMode')::boolean, 'копия сохраняет строгий режим');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format('select set_exam_strict(%s, false)', :strict_id), 'not_found');
reset request.jwt.claim.sub;
reset role;
set role anon;
select join_exam(:'strict_code', 'Арман') as ts \gset
select pg_temp.check((get_attempt(:'ts')->'exam'->>'strictMode')::boolean and (get_attempt(:'ts')->'exam'->>'maxLeaves') = '2', 'ученик видит настройки строгого режима');
select log_event(:'ts', 'paste', '{"text":"скопированный текст","blocked":true}');
select log_event(:'ts', 'leave', '{"reason":"fullscreen"}');
select log_event(:'ts', 'return', '{"awayMs":1000}');
select save_answers(:'ts', '{}');
select pg_temp.check((get_attempt(:'ts')->>'leaveCount') = '1', 'один уход');
select log_event(:'ts', 'leave', '{"reason":"hidden"}');
select pg_temp.check((get_attempt(:'ts')->>'locked')::boolean, 'после второго ухода работа заблокирована');
select pg_temp.expect_error(format($$ select save_answers(%L, '{}') $$, :'ts'), 'attempt_locked');
select pg_temp.expect_error(format($$ select submit_attempt(%L, '{}') $$, :'ts'), 'attempt_locked');
select pg_temp.expect_error(format('select unlock_participant(1)'), 'unauthorized');
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (p->>'id')::bigint as pid_s from jsonb_array_elements(exam_monitor(:strict_id, 0)->'participants') p \gset
select pg_temp.check(exam_monitor(:strict_id, 0)->'participants'->0->>'status' = 'locked', 'в мониторинге статус «заблокирован»');
select pg_temp.check(exists (select from jsonb_array_elements(exam_monitor(:strict_id, 0)->'events') ev where ev->>'type' = 'lock'), 'событие блокировки');
select pg_temp.check(exists (select from jsonb_array_elements(exam_monitor(:strict_id, 0)->'events') ev
  where ev->>'type' = 'paste' and (ev->'detail'->>'blocked')::boolean and not (ev->'detail'->>'large')::boolean), 'запрещённая вставка записана, но не считается большой');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect_error(format('select unlock_participant(%s)', :pid_s), 'not_found');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select unlock_participant(:pid_s);
reset request.jwt.claim.sub;
reset role;
set role anon;
select pg_temp.check(not (get_attempt(:'ts')->>'locked')::boolean and (get_attempt(:'ts')->>'leaveCount') = '0', 'разблокирован, счёт уходов сначала');
select log_event(:'ts', 'return', '{"awayMs":5000}');
select log_event(:'ts', 'leave', '{"reason":"blur"}');
select pg_temp.check(not (get_attempt(:'ts')->>'locked')::boolean, 'один уход после разблокировки — ещё не блокировка');
select submit_attempt(:'ts', '{"0":"1"}');

-- ---------- рубрика: критерии оценки ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (create_exam('Рубрика', 'text')->>'id')::bigint as rub_id \gset
select pg_temp.expect_error(format($$ select save_exam(%s, 'Рубрика', '[{"kind":"text","text":"Эссе","rubric":[{"text":"","points":2}]}]') $$, :rub_id), 'invalid_rubric');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Рубрика', '[{"kind":"text","text":"Эссе","rubric":[{"text":"Мысль","points":0.5}]}]') $$, :rub_id), 'invalid_rubric');
select pg_temp.expect_error(format($$ select save_exam(%s, 'Рубрика', '[{"kind":"text","text":"Эссе","rubric":[{"text":"Мысль","points":60},{"text":"Пример","points":50}]}]') $$, :rub_id), 'invalid_rubric');
select save_exam(:rub_id, 'Рубрика', '[{"kind":"text","text":"Эссе","points":1,"rubric":[{"text":" Главная мысль ","points":2},{"text":"Пример","points":1}]},{"kind":"text","text":"Без рубрики","rubric":[]}]') as rub \gset
select pg_temp.check((:'rub'::jsonb->'questions'->0->>'points')::int = 3, 'баллы вопроса = сумма критериев');
select pg_temp.check(:'rub'::jsonb->'questions'->0->'rubric'->0->>'text' = 'Главная мысль', 'текст критерия обрезан');
select pg_temp.check(not (:'rub'::jsonb->'questions'->1 ? 'rubric'), 'пустая рубрика не сохраняется');
select (:'rub'::jsonb->'questions'->0->>'id')::bigint as rq1 \gset
select publish_exam(:rub_id)->>'code' as rub_code \gset
select pg_temp.check(copy_exam(:rub_id, 'Рубрика 2') is not null, 'копия');
select pg_temp.check((select get_exam((e->>'id')::bigint)->'questions'->0->'rubric' from jsonb_array_elements(list_exams()) e where e->>'title' = 'Рубрика 2') is not null, 'рубрика копируется');
reset role;
reset request.jwt.claim.sub;
set role anon;
select join_exam(:'rub_code', 'Рустем') as rtoken \gset
select pg_temp.check(not (get_attempt(:'rtoken')->'questions'->0 ? 'rubric'), 'ученик не видит рубрику');
select submit_attempt(:'rtoken', jsonb_build_object(:'rq1', 'Моё эссе'));
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (exam_results(:rub_id)->'participants'->0->>'id')::bigint as rpid \gset
-- ИИ: баллы по критериям обрезаются по максимуму критерия, оценка — их сумма
select save_ai_grades(:rub_id, jsonb_build_array(jsonb_build_object('participantId', :rpid, 'questionId', :rq1, 'score', 1, 'comment', 'ok', 'criteria', '[5, 0.7]'::jsonb)));
select exam_results(:rub_id)->'participants'->0->'answers'->(:'rq1') as ra \gset
select pg_temp.check((:'ra'::jsonb->>'score')::numeric = 2.5 and :'ra'::jsonb->'criteria' = '[2, 0.5]'::jsonb, 'ИИ: критерии 2 + 0.5');
-- критерии неподходящей длины — берётся просто балл
select save_ai_grades(:rub_id, jsonb_build_array(jsonb_build_object('participantId', :rpid, 'questionId', :rq1, 'score', 1, 'comment', 'ok', 'criteria', '[1]'::jsonb)));
select exam_results(:rub_id)->'participants'->0->'answers'->(:'rq1') as ra \gset
select pg_temp.check((:'ra'::jsonb->>'score')::numeric = 1 and not (:'ra'::jsonb ? 'criteria'), 'неподходящие критерии отброшены');
select set_grade(:rpid, :rq1, 0, 'учитель', '[2, 1]'::jsonb);
select exam_results(:rub_id)->'participants'->0->'answers'->(:'rq1') as ra \gset
select pg_temp.check((:'ra'::jsonb->>'score')::numeric = 3 and :'ra'::jsonb->>'source' = 'teacher', 'учитель: оценка по критериям');
select set_grade(:rpid, :rq1, 1.5, 'без критериев');
select exam_results(:rub_id)->'participants'->0->'answers'->(:'rq1') as ra \gset
select pg_temp.check((:'ra'::jsonb->>'score')::numeric = 1.5 and not (:'ra'::jsonb ? 'criteria'), 'учитель: общий балл без критериев');

-- ---------- варианты: каждому ученику свои случайные вопросы ----------
select (create_exam('Варианты', 'quiz')->>'id')::bigint as var_id \gset
select save_exam(:var_id, 'Варианты', (select jsonb_agg(jsonb_build_object('text', 'В' || i, 'options', '["a","b"]'::jsonb, 'correctIndex', 0, 'points', 1))
  from generate_series(1, 6) i));
select pg_temp.expect_error(format('select set_exam_pick(%s, 0)', :var_id), 'invalid_request');
select pg_temp.check((set_exam_pick(:var_id, 3)->>'pickCount')::int = 3, 'вариант из 3 вопросов');
select publish_exam(:var_id)->>'code' as var_code \gset
select pg_temp.expect_error(format('select set_exam_pick(%s, 2)', :var_id), 'exam_locked');
reset role;
reset request.jwt.claim.sub;
set role anon;
select join_exam(:'var_code', 'В1') as vt1 \gset
select join_exam(:'var_code', 'В2') as vt2 \gset
select join_exam(:'var_code', 'В3') as vt3 \gset
select pg_temp.check(jsonb_array_length(get_attempt(:'vt1')->'questions') = 3, 'ученику 3 вопроса');
select pg_temp.check(get_attempt(:'vt1')->'questions' = get_attempt(:'vt1')->'questions', 'вариант не меняется');
select pg_temp.check(
  (select count(distinct (select string_agg(q->>'id', ',' order by q->>'id') from jsonb_array_elements(get_attempt(t)->'questions') q))
   from unnest(array[:'vt1', :'vt2', :'vt3']::uuid[]) t) > 1, 'варианты у учеников разные');
-- ответ на чужой вопрос не сохраняется; ответим верно на все вопросы своего варианта
select submit_attempt(:'vt1', (select jsonb_object_agg(q->>'id', '0') from jsonb_array_elements(get_attempt(:'vt1')->'questions') q)
  || (select jsonb_object_agg(q.id::text, '0') from (select (x->>'id')::bigint id from jsonb_array_elements(get_attempt(:'vt2')->'questions') x) q
      where q.id not in (select (y->>'id')::bigint from jsonb_array_elements(get_attempt(:'vt1')->'questions') y)));
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select p as vp from jsonb_array_elements(exam_results(:var_id)->'participants') p where p->>'name' = 'В1' \gset
select pg_temp.check((:'vp'::jsonb->>'maxScore')::int = 3 and (:'vp'::jsonb->>'total')::numeric = 3
  and (:'vp'::jsonb->>'gradedCount')::int = 3 and jsonb_array_length(:'vp'::jsonb->'questionIds') = 3
  and (select count(*) from jsonb_object_keys(:'vp'::jsonb->'answers')) = 3, 'результат по своему варианту: 3 из 3');
select pg_temp.check((exam_monitor(:var_id, 0)->>'questionCount')::int = 3, 'в мониторинге 3 вопроса');
select pg_temp.check((select (e->>'avgPercent')::numeric from jsonb_array_elements(teacher_stats()->'exams') e where (e->>'id')::bigint = :var_id) = 100,
  'профиль: 100% по своему варианту');

-- ---------- банк вопросов ----------
select pg_temp.expect_error($$ select add_to_bank('Т', '[{"text":"","options":["a","b"],"correctIndex":0}]') $$, 'question_text_required');
select pg_temp.check(add_to_bank(' Дроби ', '[{"kind":"choice","text":"1/2 + 1/2","options":["1","2"],"correctIndex":0},{"kind":"text","text":"Что такое дробь?","rubric":[{"text":"Определение","points":2}]}]') = 2, 'в банк добавлено 2');
select pg_temp.check(add_to_bank('Дроби', '[{"kind":"choice","text":"1/2 + 1/2","options":["1","3"],"correctIndex":1}]') = 1, 'повтор обновляет');
select pg_temp.check(jsonb_array_length(list_bank()) = 2, 'дубликатов нет');
select pg_temp.check((select b->'options'->>1 from jsonb_array_elements(list_bank()) b where b->>'kind' = 'choice') = '3', 'вопрос обновлён');
select pg_temp.check((select (b->>'points')::int from jsonb_array_elements(list_bank()) b where b->>'kind' = 'text') = 2, 'баллы по рубрике');
select pg_temp.check((select bool_and(b->>'topic' = 'Дроби') from jsonb_array_elements(list_bank()) b), 'тема');
select (list_bank()->0->>'id')::bigint as bq1 \gset
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.check(list_bank() = '[]'::jsonb, 'чужой банк не виден');
select pg_temp.expect_error(format('select delete_bank_question(%s)', :bq1), 'not_found');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select delete_bank_question(:bq1);
select pg_temp.check(jsonb_array_length(list_bank()) = 1, 'удалён');
reset role;
reset request.jwt.claim.sub;
set role anon;
select pg_temp.expect_error($$ select list_bank() $$, 'unauthorized');
reset role;

-- ---------- пробный период ИИ, общий ключ и свой ключ ----------
-- B — обычный учитель (A уже администратор).
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.check(ai_status()->>'access' = 'trial' and (ai_status()->>'spent')::numeric = 0 and not (ai_status()->>'ownKey')::boolean, 'новый учитель на пробном периоде');
select pg_temp.expect_error($$ select ai_account('22222222-2222-2222-2222-222222222222') $$, 'permission denied for function ai_account');
select pg_temp.expect_error($$ select ai_save_key('22222222-2222-2222-2222-222222222222', 'sk-or-x', 'x') $$, 'permission denied for function ai_save_key');
select pg_temp.expect_error($$ select ai_add_usage('22222222-2222-2222-2222-222222222222', 'grade', 'm', 5) $$, 'permission denied for function ai_add_usage');
select pg_temp.expect_error($$ select * from ai_accounts $$, 'permission denied for table ai_accounts');
select pg_temp.expect_error($$ select admin_set_shared_ai('22222222-2222-2222-2222-222222222222', true) $$, 'forbidden');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(ai_status()->>'access' = 'admin', 'администратор без ограничений');

-- функция grade (service_role) записывает расходы и ключ
reset request.jwt.claim.sub;
set role service_role;
select ai_add_usage('22222222-2222-2222-2222-222222222222', 'grade', 'anthropic/claude', 1.25);
select pg_temp.check((ai_add_usage('22222222-2222-2222-2222-222222222222', 'grade', 'x', -1)->>'spent')::numeric = 1.25, 'отрицательная цена не уменьшает расход');
select pg_temp.check(ai_account('22222222-2222-2222-2222-222222222222')->>'access' = 'trial', 'до $2 пробный период идёт');
select pg_temp.check(ai_add_usage('22222222-2222-2222-2222-222222222222', 'feedback', 'openai/gpt-4o', 0.8)->>'access' = 'ended', '$2 потрачено — пробный период закончился');
select pg_temp.check(ai_account('22222222-2222-2222-2222-222222222222')->'apiKey' = 'null'::jsonb, 'своего ключа нет');
select pg_temp.expect_error($$ select ai_save_key('22222222-2222-2222-2222-222222222222', '  ', '1234') $$, 'ai_bad_own_key');
select pg_temp.check((ai_save_key('22222222-2222-2222-2222-222222222222', ' enc1:aaa:bbb ', '1234')->>'keyHint') = '1234', 'ключ сохранён');
select pg_temp.check(ai_account('22222222-2222-2222-2222-222222222222')->>'apiKey' = 'enc1:aaa:bbb', 'функция видит зашифрованный ключ');
select pg_temp.check(ai_account('11111111-1111-1111-1111-111111111111')->'apiKey' = 'null'::jsonb, 'ключ B не достаётся A');
reset role;

-- пробный период кончается и по времени
insert into auth.users (id, email, created_at) values ('33333333-3333-3333-3333-333333333333', 'c@school.kz', now() - interval '15 days');
set role service_role;
select pg_temp.check(ai_account('33333333-3333-3333-3333-333333333333')->>'access' = 'ended', 'через 14 дней пробный период закончился');
reset role;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select ai_status() as st \gset
select pg_temp.check((:'st'::jsonb->>'ownKey')::boolean and not (:'st'::jsonb ? 'apiKey'), 'учитель видит, что ключ есть, но не сам ключ');
select pg_temp.check(not (remove_ai_key()->>'ownKey')::boolean, 'ключ удалён');
-- администратор разрешает общий ключ
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(admin_set_shared_ai('33333333-3333-3333-3333-333333333333', true)->>'access' = 'allowed', 'админ разрешил общий ключ');
select pg_temp.expect_error($$ select admin_set_shared_ai('44444444-4444-4444-4444-444444444444', true) $$, 'not_found');
select admin_users() as au \gset
select pg_temp.check((select u->'ai'->>'access' from jsonb_array_elements((:'au'::jsonb)->'users') u
  where u->>'id' = '33333333-3333-3333-3333-333333333333') = 'allowed', 'админ видит доступ');
select pg_temp.check((select (u->'ai'->>'spent')::numeric from jsonb_array_elements((:'au'::jsonb)->'users') u
  where u->>'id' = '22222222-2222-2222-2222-222222222222') = 2.05, 'админ видит расход учителя');
select pg_temp.check(admin_set_shared_ai('33333333-3333-3333-3333-333333333333', false)->>'access' = 'ended', 'админ запретил общий ключ');
reset role;
reset request.jwt.claim.sub;
set role anon;
select pg_temp.expect_error($$ select ai_status() $$, 'unauthorized');
reset role;
