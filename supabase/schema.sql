-- AI Marker: схема базы для Supabase.
-- Выполните этот файл целиком в Supabase → SQL Editor. Повторный запуск безопасен.
--
-- Браузер не читает таблицы напрямую: RLS включён без политик, а все действия
-- идут через функции ниже. Учитель определяется по auth.uid(), студент — по
-- токену попытки, который он получает при входе по коду.

create table if not exists public.exams (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  type text not null,      -- quiz: тест (автопроверка); text: открытые вопросы; mixed: и то и другое
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  code text unique,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
-- Добавлено позже: класс или группа (для анализа по классам).
alter table public.exams add column if not exists class_name text;
-- Добавлено позже: смешанный экзамен (тест + открытые вопросы) и перемешивание для каждого ученика.
alter table public.exams drop constraint if exists exams_type_check;
alter table public.exams add constraint exams_type_check check (type in ('quiz', 'text', 'mixed'));
alter table public.exams add column if not exists shuffle boolean not null default false;

create table if not exists public.questions (
  id bigint generated always as identity primary key,
  exam_id bigint not null references public.exams(id) on delete cascade,
  position int not null,
  text text not null,
  options jsonb,          -- массив вариантов (только quiz)
  correct_index int       -- индекс верного варианта (только quiz)
);

-- Добавлено позже: максимальный балл и эталонный ответ / критерии (для оценки текстовых ответов).
alter table public.questions add column if not exists points int not null default 1;
alter table public.questions add column if not exists reference text;
-- Добавлено позже: вид вопроса.
--   choice    — один верный вариант из нескольких (correct_index);
--   truefalse — «Верно / Неверно» (options из двух подписей, correct_index 0 или 1);
--   order     — расставить по порядку (options в верном порядке, ответ — индексы через запятую);
--   text      — открытый ответ, оценивает учитель или ИИ.
alter table public.questions add column if not exists kind text;
update public.questions q set kind = case when e.type = 'text' then 'text' else 'choice' end
  from public.exams e where e.id = q.exam_id and q.kind is null;
alter table public.questions alter column kind set default 'choice';
alter table public.questions alter column kind set not null;
alter table public.questions drop constraint if exists questions_kind_check;
alter table public.questions add constraint questions_kind_check check (kind in ('choice', 'truefalse', 'order', 'text'));

create table if not exists public.participants (
  id bigint generated always as identity primary key,
  exam_id bigint not null references public.exams(id) on delete cascade,
  name text not null,
  token uuid not null unique default gen_random_uuid(),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  submitted_at timestamptz
);

create table if not exists public.answers (
  participant_id bigint not null references public.participants(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (participant_id, question_id)
);

-- Оценка текстового ответа. source: teacher (поставил учитель) | ai (предложил ИИ).
create table if not exists public.grades (
  participant_id bigint not null references public.participants(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  score numeric not null,
  comment text,
  source text not null check (source in ('teacher', 'ai')),
  updated_at timestamptz not null default now(),
  primary key (participant_id, question_id)
);

-- type: join | leave | return | paste | submit
create table if not exists public.events (
  id bigint generated always as identity primary key,
  exam_id bigint not null references public.exams(id) on delete cascade,
  participant_id bigint not null references public.participants(id) on delete cascade,
  type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Библиотека учителя: эталонные ответы, конспекты, документы по темам.
-- Текст (content) ИИ использует при проверке экзаменов, к которым материал привязан;
-- файл (если есть) лежит в Supabase Storage, корзина library, папка <id учителя>.
create table if not exists public.materials (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  topic text,
  content text,
  file_path text,
  file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.exam_materials (
  exam_id bigint not null references public.exams(id) on delete cascade,
  material_id bigint not null references public.materials(id) on delete cascade,
  primary key (exam_id, material_id)
);

create index if not exists exams_teacher on public.exams(teacher_id);
create index if not exists questions_exam on public.questions(exam_id, position);
create index if not exists participants_exam on public.participants(exam_id);
create index if not exists events_exam on public.events(exam_id, id);
create index if not exists events_participant on public.events(participant_id);
create index if not exists materials_teacher on public.materials(teacher_id);

alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.participants enable row level security;
alter table public.answers enable row level security;
alter table public.events enable row level security;
alter table public.grades enable row level security;
alter table public.materials enable row level security;
alter table public.exam_materials enable row level security;

-- ---------- Настройки ----------

-- Вставка от стольких символов считается «большой».
create or replace function public.large_paste_chars() returns int
language sql immutable as $$ select 200 $$;

-- Студент без heartbeat дольше этого считается офлайн.
create or replace function public.online_window() returns interval
language sql immutable as $$ select interval '30 seconds' $$;

-- ---------- Вспомогательные (не вызываются из браузера) ----------

create or replace function public._exam_json(e public.exams) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', e.id, 'title', e.title, 'type', e.type, 'status', e.status, 'code', e.code,
    'createdAt', e.created_at, 'publishedAt', e.published_at, 'className', e.class_name, 'shuffle', e.shuffle)
$$;

create or replace function public._questions_json(p_exam_id bigint, p_with_answers boolean) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', q.id, 'kind', q.kind, 'text', q.text, 'options', q.options, 'points', q.points,
      'correctIndex', case when p_with_answers then q.correct_index end,
      'reference', case when p_with_answers then q.reference end))
    order by q.position), '[]'::jsonb)
  from public.questions q where q.exam_id = p_exam_id
$$;

-- Верен ли ответ на вопрос с автопроверкой (для открытого вопроса — null).
create or replace function public._is_correct(q public.questions, v text) returns boolean
language sql immutable as $$
  select case q.kind
    when 'text' then null
    when 'order' then v = (select string_agg(i::text, ',' order by i) from generate_series(0, jsonb_array_length(q.options) - 1) i)
    else v = q.correct_index::text end
$$;

-- Балл за вопрос: автопроверка или оценка учителя / ИИ (g) для открытого вопроса.
create or replace function public._q_score(q public.questions, v text, g numeric) returns numeric
language sql immutable as $$
  select case when q.kind = 'text' then g when _is_correct(q, v) then q.points else 0 end
$$;

-- Вопросы для ученика: без верных ответов. Варианты приходят как {i, text}, где i — номер
-- варианта у учителя (его ученик и отправляет). Порядок для «расставь по порядку» всегда
-- перемешан; при включённом shuffle перемешаны и вопросы, и варианты. Перемешивание своё
-- для каждого ученика (seed — его токен) и не меняется при перезагрузке страницы.
create or replace function public._student_questions(e public.exams, p_seed text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q questions;
  res jsonb := '[]'::jsonb;
  perm int[];
  n int;
begin
  for q in select * from questions where exam_id = e.id
           order by case when e.shuffle then md5(p_seed || ':q' || id) end, position loop
    if q.kind = 'text' or q.options is null then
      res := res || jsonb_build_array(jsonb_build_object('id', q.id, 'kind', q.kind, 'text', q.text, 'points', q.points));
      continue;
    end if;
    n := jsonb_array_length(q.options);
    if q.kind = 'order' or (q.kind = 'choice' and e.shuffle) then
      select array_agg(i order by md5(p_seed || ':' || q.id || ':' || i)) into perm from generate_series(0, n - 1) i;
      -- для «по порядку» перемешанный список не должен совпасть с верным
      if q.kind = 'order' and perm = (select array_agg(i order by i) from generate_series(0, n - 1) i) then
        select array_agg(perm[k] order by k desc) into perm from generate_subscripts(perm, 1) k;
      end if;
    else
      select array_agg(i order by i) into perm from generate_series(0, n - 1) i;
    end if;
    res := res || jsonb_build_array(jsonb_build_object('id', q.id, 'kind', q.kind, 'text', q.text, 'points', q.points,
      'options', (select jsonb_agg(jsonb_build_object('i', perm[k], 'text', q.options->>perm[k]) order by k)
                  from generate_subscripts(perm, 1) k)));
  end loop;
  return res;
end $$;

-- Экзамен текущего учителя или ошибка.
create or replace function public._own_exam(p_exam_id bigint) returns public.exams
language plpgsql stable security definer set search_path = public as $$
declare e public.exams;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  select * into e from exams where id = p_exam_id and teacher_id = auth.uid();
  if not found then raise exception 'not_found'; end if;
  return e;
end $$;

-- Попытка студента по токену; заодно отмечает, что он на связи.
create or replace function public._attempt(p_token uuid) returns public.participants
language plpgsql security definer set search_path = public as $$
declare p public.participants;
begin
  update participants set last_seen = now() where token = p_token returning * into p;
  if not found then raise exception 'unauthorized'; end if;
  return p;
end $$;

create or replace function public._add_event(p public.participants, p_type text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into events (exam_id, participant_id, type, detail) values (p.exam_id, p.id, p_type, p_detail)
$$;

create or replace function public._save_answers(p public.participants, p_answers jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then return; end if;
  insert into answers (participant_id, question_id, value, updated_at)
  select p.id, q.id, left(a.value, 50000), now()
  from jsonb_each_text(p_answers) a
  join questions q on q.exam_id = p.exam_id and q.id::text = a.key
  where a.value is not null
  on conflict (participant_id, question_id) do update set value = excluded.value, updated_at = excluded.updated_at;
end $$;

create or replace function public._check_writable(p public.participants) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p.submitted_at is not null then raise exception 'already_submitted'; end if;
  if (select status from exams where id = p.exam_id) <> 'published' then raise exception 'exam_not_open'; end if;
end $$;

revoke execute on function public._is_correct(public.questions, text), public._q_score(public.questions, text, numeric),
  public._student_questions(public.exams, text)
  from public, anon, authenticated;

revoke execute on function public._own_exam(bigint), public._attempt(uuid),
  public._add_event(public.participants, text, jsonb), public._save_answers(public.participants, jsonb),
  public._check_writable(public.participants)
  from public, anon, authenticated;

-- ---------- Учитель ----------

create or replace function public.list_exams() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  return coalesce((
    select jsonb_agg(_exam_json(e) || jsonb_build_object(
      'participantCount', (select count(*) from participants p where p.exam_id = e.id))
      order by e.created_at desc)
    from exams e where e.teacher_id = auth.uid()), '[]'::jsonb);
end $$;

drop function if exists public.create_exam(text, text);
create or replace function public.create_exam(p_title text, p_type text, p_shuffle boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e exams;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title_required'; end if;
  if p_type not in ('quiz', 'text', 'mixed') or p_type is null then raise exception 'invalid_type'; end if;
  insert into exams (teacher_id, title, type, shuffle)
  values (auth.uid(), trim(p_title), p_type, coalesce(p_shuffle, false)) returning * into e;
  return _exam_json(e);
end $$;

-- Перемешивать вопросы и варианты для каждого ученика. Можно менять и во время экзамена.
create or replace function public.set_exam_shuffle(p_exam_id bigint, p_shuffle boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  update exams set shuffle = coalesce(p_shuffle, false) where id = e.id returning * into e;
  return _exam_json(e);
end $$;

create or replace function public.get_exam(p_exam_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  return _exam_json(e) || jsonb_build_object(
    'questions', _questions_json(e.id, true),
    'materialIds', coalesce((select jsonb_agg(material_id order by material_id) from exam_materials where exam_id = e.id), '[]'::jsonb));
end $$;

-- Сохраняет название и весь список вопросов черновика целиком.
-- p_questions: [{ "kind": "choice", "text": "...", "options": ["a","b"], "correctIndex": 0, "points": 1, "reference": "..." }, ...]
-- kind по умолчанию: choice в тесте, text в экзамене с открытыми вопросами.
create or replace function public.save_exam(p_exam_id bigint, p_title text, p_questions jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e exams := _own_exam(p_exam_id);
  q jsonb;
  opts jsonb;
  k text;
  idx int := 0;
begin
  if e.status <> 'draft' then raise exception 'exam_locked'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title_required'; end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then raise exception 'invalid_questions'; end if;

  for q in select value from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(q) <> 'object' or coalesce(trim(q->>'text'), '') = '' then raise exception 'question_text_required'; end if;
    if q ? 'points' and (jsonb_typeof(q->'points') is distinct from 'number'
       or (q->>'points')::numeric <> floor((q->>'points')::numeric)
       or (q->>'points')::numeric not between 1 and 100) then
      raise exception 'invalid_points';
    end if;
    k := coalesce(q->>'kind', case when e.type = 'text' then 'text' else 'choice' end);
    if k not in ('choice', 'truefalse', 'order', 'text')
       or (e.type = 'quiz' and k = 'text') or (e.type = 'text' and k <> 'text') then
      raise exception 'invalid_kind';
    end if;
    if k <> 'text' then
      opts := q->'options';
      if opts is null or jsonb_typeof(opts) <> 'array' or jsonb_array_length(opts) < 2
         or (k = 'truefalse' and jsonb_array_length(opts) <> 2)
         or exists (select 1 from jsonb_array_elements(opts) o where jsonb_typeof(o) <> 'string' or trim(o #>> '{}') = '') then
        raise exception 'quiz_needs_options';
      end if;
    end if;
    if k in ('choice', 'truefalse') then
      if jsonb_typeof(q->'correctIndex') is distinct from 'number'
         or (q->>'correctIndex')::numeric <> floor((q->>'correctIndex')::numeric)
         or (q->>'correctIndex')::int not between 0 and jsonb_array_length(opts) - 1 then
        raise exception 'quiz_needs_correct';
      end if;
    end if;
  end loop;

  update exams set title = trim(p_title) where id = e.id;
  delete from questions where exam_id = e.id;
  for q in select value from jsonb_array_elements(p_questions) loop
    k := coalesce(q->>'kind', case when e.type = 'text' then 'text' else 'choice' end);
    insert into questions (exam_id, position, kind, text, options, correct_index, points, reference)
    values (
      e.id, idx, k, trim(q->>'text'),
      case when k <> 'text' then (select jsonb_agg(trim(o) order by n) from jsonb_array_elements_text(q->'options') with ordinality t(o, n)) end,
      case when k in ('choice', 'truefalse') then (q->>'correctIndex')::int end,
      coalesce((q->>'points')::int, 1),
      nullif(left(trim(coalesce(q->>'reference', '')), 5000), ''));
    idx := idx + 1;
  end loop;
  return get_exam(e.id);
end $$;

-- «Подтвердить»: фиксирует вопросы и выдаёт код экзамена.
create or replace function public.publish_exam(p_exam_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e exams := _own_exam(p_exam_id);
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- без 0/O и 1/I
  new_code text;
begin
  if e.status <> 'draft' then raise exception 'exam_locked'; end if;
  if not exists (select 1 from questions where exam_id = e.id) then raise exception 'no_questions'; end if;
  loop
    select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
      into new_code from generate_series(1, 6);
    exit when not exists (select 1 from exams where code = new_code);
  end loop;
  update exams set status = 'published', code = new_code, published_at = now() where id = e.id returning * into e;
  return _exam_json(e);
end $$;

create or replace function public.close_exam(p_exam_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  if e.status <> 'published' then raise exception 'exam_not_open'; end if;
  update exams set status = 'closed' where id = e.id returning * into e;
  return _exam_json(e);
end $$;

create or replace function public.delete_exam(p_exam_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  delete from exams where id = e.id;
end $$;

-- Мониторинг: участники со сводкой + события с id больше p_after.
create or replace function public.exam_monitor(p_exam_id bigint, p_after bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  e exams := _own_exam(p_exam_id);
  qs jsonb := _questions_json(e.id, true);
begin
  return jsonb_build_object(
    'exam', _exam_json(e),
    'largePasteChars', large_paste_chars(),
    'questionCount', jsonb_array_length(qs),
    'participants', coalesce((
      select jsonb_agg(row order by joined_at) from (
        select p.joined_at, jsonb_strip_nulls(jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'joinedAt', p.joined_at,
          'lastSeen', p.last_seen,
          'submittedAt', p.submitted_at,
          'status', case
            when p.submitted_at is not null then 'submitted'
            when now() - p.last_seen > online_window() then 'offline'
            when (select ev.type from events ev where ev.participant_id = p.id and ev.type in ('leave', 'return')
                  order by ev.id desc limit 1) = 'leave' then 'away'
            else 'online' end,
          'leaveCount', (select count(*) from events ev where ev.participant_id = p.id and ev.type = 'leave'),
          'awayMs', (select coalesce(sum((ev.detail->>'awayMs')::bigint), 0) from events ev
                     where ev.participant_id = p.id and ev.type = 'return'),
          'largePasteCount', (select count(*) from events ev where ev.participant_id = p.id and ev.type = 'paste'
                              and (ev.detail->>'large')::boolean),
          'answeredCount', (select count(*) from answers a where a.participant_id = p.id),
          'score', case when e.type <> 'text' and p.submitted_at is not null then jsonb_build_object(
            'correct', (select count(*) from questions q join answers a on a.question_id = q.id and a.participant_id = p.id
                        where q.exam_id = e.id and _is_correct(q, a.value)),
            'total', (select count(*) from questions q where q.exam_id = e.id and q.kind <> 'text')) end
        )) as row
        from participants p where p.exam_id = e.id
      ) s), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'type', ev.type, 'detail', ev.detail, 'createdAt', ev.created_at,
        'participantId', p.id, 'name', p.name) order by ev.id)
      from (select * from events where exam_id = e.id and id > coalesce(p_after, 0) order by id limit 500) ev
      join participants p on p.id = ev.participant_id), '[]'::jsonb)
  );
end $$;

-- Ответы и оценки по каждому студенту.
-- Вопросы теста оцениваются автоматически (верный ответ = баллы вопроса),
-- открытые — по таблице grades (учитель или ИИ).
create or replace function public.exam_results(p_exam_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  return jsonb_build_object(
    'exam', _exam_json(e),
    'questions', _questions_json(e.id, true),
    'materials', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'topic', m.topic, 'content', m.content) order by m.title)
      from exam_materials em join materials m on m.id = em.material_id where em.exam_id = e.id), '[]'::jsonb),
    'maxScore', (select coalesce(sum(points), 0) from questions where exam_id = e.id),
    'participants', coalesce((
      select jsonb_agg(r.row order by r.name) from (
        select p.name, jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'joinedAt', p.joined_at,
          'submittedAt', p.submitted_at,
          'answers', coalesce((
            select jsonb_object_agg(q.id::text, jsonb_strip_nulls(jsonb_build_object(
              'value', a.value,
              'score', _q_score(q, a.value, g.score),
              'comment', g.comment,
              'source', case when q.kind <> 'text' then 'auto' else g.source end)))
            from questions q
            left join answers a on a.question_id = q.id and a.participant_id = p.id
            left join grades g on g.question_id = q.id and g.participant_id = p.id
            where q.exam_id = e.id and (a.value is not null or g.score is not null)), '{}'::jsonb),
          'total', (
            select sum(_q_score(q, a.value, g.score))
            from questions q
            left join answers a on a.question_id = q.id and a.participant_id = p.id
            left join grades g on g.question_id = q.id and g.participant_id = p.id
            where q.exam_id = e.id),
          'gradedCount', (select count(*) from questions q
                          left join grades g on g.question_id = q.id and g.participant_id = p.id
                          where q.exam_id = e.id and (q.kind <> 'text' or g.score is not null))
        ) as row
        from participants p where p.exam_id = e.id
      ) r), '[]'::jsonb));
end $$;

-- Учитель ставит или исправляет оценку текстового ответа.
create or replace function public.set_grade(p_participant_id bigint, p_question_id bigint, p_score numeric, p_comment text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  p participants;
  q questions;
  e exams;
begin
  select * into p from participants where id = p_participant_id;
  if not found then raise exception 'not_found'; end if;
  e := _own_exam(p.exam_id);
  select * into q from questions where id = p_question_id and exam_id = e.id;
  if not found then raise exception 'not_found'; end if;
  if q.kind <> 'text' then raise exception 'not_gradable'; end if;
  if p_score is null or p_score < 0 or p_score > q.points then raise exception 'invalid_score'; end if;
  insert into grades (participant_id, question_id, score, comment, source, updated_at)
  values (p.id, q.id, p_score, nullif(left(trim(coalesce(p_comment, '')), 5000), ''), 'teacher', now())
  on conflict (participant_id, question_id) do update
    set score = excluded.score, comment = excluded.comment, source = 'teacher', updated_at = now();
end $$;

-- Сохраняет оценки ИИ (вызывается из функции supabase/functions/grade).
-- Оценки, которые учитель поставил сам, ИИ не перезаписывает.
-- p_grades: [{ "participantId": 1, "questionId": 2, "score": 3.5, "comment": "..." }, ...]
create or replace function public.save_ai_grades(p_exam_id bigint, p_grades jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  e exams := _own_exam(p_exam_id);
  n int;
begin
  if e.type = 'quiz' then raise exception 'not_gradable'; end if;
  if p_grades is null or jsonb_typeof(p_grades) <> 'array' then raise exception 'invalid_grades'; end if;
  insert into grades (participant_id, question_id, score, comment, source, updated_at)
  select p.id, q.id,
         trim_scale(greatest(0, least(q.points, round((g->>'score')::numeric * 2) / 2))),
         nullif(left(trim(coalesce(g->>'comment', '')), 5000), ''),
         'ai', now()
  from jsonb_array_elements(p_grades) g
  join participants p on p.id = (g->>'participantId')::bigint and p.exam_id = e.id
  join questions q on q.id = (g->>'questionId')::bigint and q.exam_id = e.id and q.kind = 'text'
  where jsonb_typeof(g->'score') = 'number'
  on conflict (participant_id, question_id) do update
    set score = excluded.score, comment = excluded.comment, source = 'ai', updated_at = now()
    where grades.source = 'ai';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Студент (без аккаунта: код + имя) ----------

create or replace function public.exam_by_code(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e exams;
begin
  select * into e from exams where code = upper(trim(p_code));
  if not found then raise exception 'exam_not_found'; end if;
  return jsonb_build_object('title', e.title, 'type', e.type, 'status', e.status, 'code', e.code);
end $$;

create or replace function public.join_exam(p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e exams;
  p participants;
begin
  select * into e from exams where code = upper(trim(p_code));
  if not found then raise exception 'exam_not_found'; end if;
  if e.status <> 'published' then raise exception 'exam_not_open'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  insert into participants (exam_id, name) values (e.id, left(trim(p_name), 100)) returning * into p;
  perform _add_event(p, 'join', null);
  return p.token;
end $$;

create or replace function public.get_attempt(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p participants := _attempt(p_token);
  e exams;
begin
  select * into e from exams where id = p.exam_id;
  return jsonb_build_object(
    'name', p.name,
    'submitted', p.submitted_at is not null,
    'exam', jsonb_build_object('title', e.title, 'type', e.type, 'status', e.status),
    'questions', _student_questions(e, p.token::text),
    'answers', coalesce((select jsonb_object_agg(a.question_id::text, a.value) from answers a where a.participant_id = p.id), '{}'::jsonb));
end $$;

create or replace function public.save_answers(p_token uuid, p_answers jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare p participants := _attempt(p_token);
begin
  perform _check_writable(p);
  perform _save_answers(p, p_answers);
end $$;

create or replace function public.heartbeat(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _attempt(p_token);
end $$;

-- p_type: leave {reason} | return {awayMs} | paste {text, questionId}
create or replace function public.log_event(p_token uuid, p_type text, p_detail jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare
  p participants := _attempt(p_token);
  d jsonb := coalesce(p_detail, '{}'::jsonb);
  pasted text;
  len int;
  last_focus text;
begin
  if p.submitted_at is not null then return; end if;
  -- уход и возвращение чередуются: повторный «ушёл» или «вернулся» без ухода не пишем
  select type into last_focus from events
  where participant_id = p.id and type in ('leave', 'return') order by id desc limit 1;
  if p_type = 'leave' and last_focus = 'leave' then return; end if;
  if p_type = 'return' and last_focus is distinct from 'leave' then return; end if;
  if p_type = 'leave' then
    perform _add_event(p, 'leave', jsonb_build_object('reason', left(coalesce(d->>'reason', 'hidden'), 20)));
  elsif p_type = 'return' then
    perform _add_event(p, 'return', jsonb_build_object(
      'awayMs', greatest(0, least(coalesce((d->>'awayMs')::numeric, 0), 86400000))::bigint));
  elsif p_type = 'paste' then
    pasted := coalesce(d->>'text', '');
    len := length(pasted);
    perform _add_event(p, 'paste', jsonb_build_object(
      'length', len,
      'large', len >= large_paste_chars(),
      'questionId', case when jsonb_typeof(d->'questionId') = 'number' then (d->>'questionId')::bigint end,
      'snippet', left(pasted, 500)));
  else
    raise exception 'invalid_event';
  end if;
end $$;

create or replace function public.submit_attempt(p_token uuid, p_answers jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare p participants := _attempt(p_token);
begin
  perform _check_writable(p);
  perform _save_answers(p, p_answers);
  update participants set submitted_at = now() where id = p.id;
  perform _add_event(p, 'submit', null);
end $$;

-- ---------- Профиль, анализ по классам, библиотека ----------

-- Баллы каждого участника экзамена. graded — сколько вопросов уже оценено
-- (вопросы теста — все сразу, открытые — по таблице grades).
create or replace function public._participant_scores(p_exam_id bigint)
returns table (participant_id bigint, name text, submitted boolean, total numeric, graded bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.submitted_at is not null,
    coalesce(sum(_q_score(q, a.value, g.score)), 0),
    count(q.id) filter (where q.kind <> 'text' or g.score is not null)
  from participants p
  left join questions q on q.exam_id = p.exam_id
  left join answers a on a.question_id = q.id and a.participant_id = p.id
  left join grades g on g.question_id = q.id and g.participant_id = p.id
  where p.exam_id = p_exam_id
  group by p.id, p.name, p.submitted_at
$$;

-- Сводка экзамена: сколько сдали и средний процент по полностью оценённым работам.
create or replace function public._exam_summary(e public.exams) returns jsonb
language sql stable security definer set search_path = public as $$
  with m as (select coalesce(sum(points), 0) as max, count(*) as qn from questions where exam_id = e.id),
       s as (select * from _participant_scores(e.id))
  select _exam_json(e) || jsonb_build_object(
    'maxScore', m.max,
    'participants', (select count(*) from s),
    'submitted', (select count(*) from s where s.submitted),
    'graded', (select count(*) from s where s.submitted and s.graded = m.qn and m.qn > 0),
    'avgPercent', (select round(avg(s.total * 100.0 / nullif(m.max, 0)), 1) from s
                   where s.submitted and s.graded = m.qn and m.qn > 0))
  from m
$$;

-- Результаты всех учеников учителя: одна строка на участника
-- (экзамен без участников — одна строка с пустым именем).
-- pct — процент от максимума, только если работа сдана и полностью оценена.
create or replace function public._teacher_results(p_teacher uuid)
returns table (cls text, exam_id bigint, created_at timestamptz, name text, pct numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(e.class_name, ''), e.id, e.created_at, s.name,
    case when s.submitted and s.graded = m.qn and m.qn > 0 and m.max > 0 then s.total * 100.0 / m.max end
  from exams e
  cross join lateral (select coalesce(sum(points), 0) as max, count(*) as qn from questions where exam_id = e.id) m
  left join lateral _participant_scores(e.id) s on true
  where e.teacher_id = p_teacher
$$;

-- Профиль учителя: все экзамены со сводкой, классы и ученики по классам.
create or replace function public.teacher_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  return jsonb_build_object(
    'exams', coalesce((select jsonb_agg(_exam_summary(e) order by e.created_at desc)
                       from exams e where e.teacher_id = auth.uid()), '[]'::jsonb),
    'materials', (select count(*) from materials where teacher_id = auth.uid()),
    'students', (select count(distinct lower(r.name)) from _teacher_results(auth.uid()) r),
    'classes', coalesce((
      with r as (select * from _teacher_results(auth.uid())),
      st as (
        select r.cls, min(r.name) as name, count(distinct r.exam_id) as exams,
               round(avg(r.pct), 1) as avg_pct,
               round((array_agg(r.pct order by r.created_at desc) filter (where r.pct is not null))[1], 1) as last_pct
        from r where r.name is not null group by r.cls, lower(r.name)),
      c as (
        select r.cls, count(distinct r.exam_id) as exams, count(distinct lower(r.name)) as students,
               round(avg(r.pct), 1) as avg_pct
        from r group by r.cls)
      select jsonb_agg(jsonb_build_object(
        'className', c.cls, 'exams', c.exams, 'students', c.students, 'avgPercent', c.avg_pct,
        'studentList', (select jsonb_agg(jsonb_build_object(
                          'name', st.name, 'exams', st.exams, 'avgPercent', st.avg_pct, 'lastPercent', st.last_pct)
                          order by st.avg_pct desc nulls last, st.name)
                        from st where st.cls = c.cls))
        order by c.cls = '', c.cls)
      from c), '[]'::jsonb));
end $$;

-- Класс экзамена и материалы библиотеки, которые ИИ учитывает при проверке.
-- Можно менять в любой момент, в том числе после публикации.
create or replace function public.update_exam_meta(p_exam_id bigint, p_class_name text, p_material_ids bigint[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  update exams set class_name = nullif(left(trim(coalesce(p_class_name, '')), 50), '') where id = e.id;
  delete from exam_materials where exam_id = e.id;
  insert into exam_materials (exam_id, material_id)
  select e.id, m.id from materials m
  where m.teacher_id = auth.uid() and m.id = any(coalesce(p_material_ids, '{}'));
  return get_exam(e.id);
end $$;

-- Классы, которые учитель уже указывал (для подсказки при вводе).
create or replace function public.list_classes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  return coalesce((select jsonb_agg(distinct class_name) from exams
                   where teacher_id = auth.uid() and class_name is not null), '[]'::jsonb);
end $$;

create or replace function public._material_json(m public.materials) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', m.id, 'title', m.title, 'topic', m.topic, 'content', m.content,
    'filePath', m.file_path, 'fileName', m.file_name, 'createdAt', m.created_at, 'updatedAt', m.updated_at,
    'examCount', (select count(*) from exam_materials where material_id = m.id))
$$;

create or replace function public.list_materials() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  return coalesce((select jsonb_agg(_material_json(m) order by lower(coalesce(m.topic, '')), lower(m.title))
                   from materials m where m.teacher_id = auth.uid()), '[]'::jsonb);
end $$;

-- Создаёт (p_id = null) или изменяет материал. Файл загружает браузер в Storage,
-- сюда передаётся только путь: он должен лежать в папке этого учителя.
create or replace function public.save_material(p_id bigint, p_title text, p_topic text, p_content text,
  p_file_path text default null, p_file_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m materials;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title_required'; end if;
  if length(coalesce(p_content, '')) > 100000 then raise exception 'material_too_long'; end if;
  if p_file_path is not null and p_file_path not like auth.uid()::text || '/%' then raise exception 'invalid_file'; end if;
  if coalesce(trim(p_content), '') = '' and p_file_path is null then raise exception 'material_empty'; end if;
  if p_id is null then
    insert into materials (teacher_id, title, topic, content, file_path, file_name)
    values (auth.uid(), left(trim(p_title), 200), nullif(left(trim(coalesce(p_topic, '')), 100), ''),
            nullif(trim(coalesce(p_content, '')), ''), p_file_path, left(p_file_name, 200))
    returning * into m;
  else
    update materials set title = left(trim(p_title), 200), topic = nullif(left(trim(coalesce(p_topic, '')), 100), ''),
      content = nullif(trim(coalesce(p_content, '')), ''), file_path = p_file_path,
      file_name = left(p_file_name, 200), updated_at = now()
    where id = p_id and teacher_id = auth.uid() returning * into m;
    if not found then raise exception 'not_found'; end if;
  end if;
  return _material_json(m);
end $$;

-- Удаляет материал; возвращает путь файла, чтобы браузер удалил его из Storage.
create or replace function public.delete_material(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m materials;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  delete from materials where id = p_id and teacher_id = auth.uid() returning * into m;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('filePath', m.file_path);
end $$;

revoke execute on function public._participant_scores(bigint), public._exam_summary(public.exams),
  public._teacher_results(uuid), public._material_json(public.materials)
  from public, anon, authenticated;

-- Файлы библиотеки: закрытая корзина library, каждый учитель видит только свою папку.
-- (Блок пропускается там, где нет Supabase Storage, например в тестах.)
do $do$
begin
  if exists (select from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('library', 'library', false, 10485760) on conflict (id) do nothing;
    drop policy if exists "library: own files read" on storage.objects;
    drop policy if exists "library: own files upload" on storage.objects;
    drop policy if exists "library: own files delete" on storage.objects;
    create policy "library: own files read" on storage.objects for select to authenticated
      using (bucket_id = 'library' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "library: own files upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'library' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "library: own files delete" on storage.objects for delete to authenticated
      using (bucket_id = 'library' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $do$;

-- ---------- Администратор ----------

-- Кто видит страницу admin.html. Добавить себя (подставьте свою почту, с которой входите на сайт):
--   insert into public.admins (user_id) select id from auth.users where email = 'ваша@почта' on conflict do nothing;
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select from admins where user_id = auth.uid())
$$;

-- Все зарегистрированные пользователи с их активностью и общие цифры сайта.
create or replace function public.admin_users() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'totals', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'newUsers7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'activeUsers7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'exams', (select count(*) from exams),
      'publishedExams', (select count(*) from exams where code is not null),
      'participants', (select count(*) from participants),
      'materials', (select count(*) from materials)),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'email', u.email, 'name', u.raw_user_meta_data->>'name',
        'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
        'isAdmin', exists (select from admins a where a.user_id = u.id),
        'exams', (select count(*) from exams e where e.teacher_id = u.id),
        'participants', (select count(*) from participants p join exams e on e.id = p.exam_id where e.teacher_id = u.id),
        'materials', (select count(*) from materials m where m.teacher_id = u.id),
        'lastExamAt', (select max(e.created_at) from exams e where e.teacher_id = u.id))
        order by u.created_at desc)
      from auth.users u), '[]'::jsonb));
end $$;
