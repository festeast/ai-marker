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
  type text not null check (type in ('quiz', 'text')),       -- quiz: варианты ответа; text: открытые вопросы
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  code text unique,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

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

create index if not exists exams_teacher on public.exams(teacher_id);
create index if not exists questions_exam on public.questions(exam_id, position);
create index if not exists participants_exam on public.participants(exam_id);
create index if not exists events_exam on public.events(exam_id, id);
create index if not exists events_participant on public.events(participant_id);

alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.participants enable row level security;
alter table public.answers enable row level security;
alter table public.events enable row level security;
alter table public.grades enable row level security;

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
    'createdAt', e.created_at, 'publishedAt', e.published_at)
$$;

create or replace function public._questions_json(p_exam_id bigint, p_with_answers boolean) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', q.id, 'text', q.text, 'options', q.options, 'points', q.points,
      'correctIndex', case when p_with_answers then q.correct_index end,
      'reference', case when p_with_answers then q.reference end))
    order by q.position), '[]'::jsonb)
  from public.questions q where q.exam_id = p_exam_id
$$;

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

create or replace function public.create_exam(p_title text, p_type text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e exams;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title_required'; end if;
  if p_type not in ('quiz', 'text') or p_type is null then raise exception 'invalid_type'; end if;
  insert into exams (teacher_id, title, type) values (auth.uid(), trim(p_title), p_type) returning * into e;
  return _exam_json(e);
end $$;

create or replace function public.get_exam(p_exam_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  return _exam_json(e) || jsonb_build_object('questions', _questions_json(e.id, true));
end $$;

-- Сохраняет название и весь список вопросов черновика целиком.
-- p_questions: [{ "text": "...", "options": ["a","b"], "correctIndex": 0, "points": 1, "reference": "..." }, ...]
create or replace function public.save_exam(p_exam_id bigint, p_title text, p_questions jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e exams := _own_exam(p_exam_id);
  q jsonb;
  opts jsonb;
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
    if e.type = 'quiz' then
      opts := q->'options';
      if opts is null or jsonb_typeof(opts) <> 'array' or jsonb_array_length(opts) < 2
         or exists (select 1 from jsonb_array_elements_text(opts) o where trim(o) = '') then
        raise exception 'quiz_needs_options';
      end if;
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
    insert into questions (exam_id, position, text, options, correct_index, points, reference)
    values (
      e.id, idx, trim(q->>'text'),
      case when e.type = 'quiz' then (select jsonb_agg(trim(o)) from jsonb_array_elements_text(q->'options') o) end,
      case when e.type = 'quiz' then (q->>'correctIndex')::int end,
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
          'score', case when e.type = 'quiz' and p.submitted_at is not null then jsonb_build_object(
            'correct', (select count(*) from questions q join answers a on a.question_id = q.id and a.participant_id = p.id
                        where q.exam_id = e.id and a.value = q.correct_index::text),
            'total', jsonb_array_length(qs)) end
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
-- Тест оценивается автоматически (верный вариант = баллы вопроса),
-- текстовые ответы — по таблице grades (учитель или ИИ).
create or replace function public.exam_results(p_exam_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e exams := _own_exam(p_exam_id);
begin
  return jsonb_build_object(
    'exam', _exam_json(e),
    'questions', _questions_json(e.id, true),
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
              'score', case when e.type = 'quiz' then
                         case when a.value = q.correct_index::text then q.points else 0 end
                       else g.score end,
              'comment', g.comment,
              'source', case when e.type = 'quiz' then 'auto' else g.source end)))
            from questions q
            left join answers a on a.question_id = q.id and a.participant_id = p.id
            left join grades g on g.question_id = q.id and g.participant_id = p.id
            where q.exam_id = e.id and (a.value is not null or g.score is not null)), '{}'::jsonb),
          'total', (
            select sum(case when e.type = 'quiz' then
                         case when a.value = q.correct_index::text then q.points else 0 end
                       else g.score end)
            from questions q
            left join answers a on a.question_id = q.id and a.participant_id = p.id
            left join grades g on g.question_id = q.id and g.participant_id = p.id
            where q.exam_id = e.id),
          'gradedCount', case when e.type = 'quiz'
            then (select count(*) from questions q where q.exam_id = e.id)
            else (select count(*) from grades g join questions q on q.id = g.question_id
                  where g.participant_id = p.id and q.exam_id = e.id) end
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
  if e.type <> 'text' then raise exception 'not_gradable'; end if;
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
  if e.type <> 'text' then raise exception 'not_gradable'; end if;
  if p_grades is null or jsonb_typeof(p_grades) <> 'array' then raise exception 'invalid_grades'; end if;
  insert into grades (participant_id, question_id, score, comment, source, updated_at)
  select p.id, q.id,
         trim_scale(greatest(0, least(q.points, round((g->>'score')::numeric * 2) / 2))),
         nullif(left(trim(coalesce(g->>'comment', '')), 5000), ''),
         'ai', now()
  from jsonb_array_elements(p_grades) g
  join participants p on p.id = (g->>'participantId')::bigint and p.exam_id = e.id
  join questions q on q.id = (g->>'questionId')::bigint and q.exam_id = e.id
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
    'questions', _questions_json(e.id, false),
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
