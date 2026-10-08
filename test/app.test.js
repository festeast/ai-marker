const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');

async function startServer() {
  const server = createApp({ db: openDb(':memory:') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  return { server, call };
}

test('учитель создаёт тест, подтверждает, видит участников, уходы и вставки', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());

  assert.equal((await call('GET', '/api/exams')).status, 401);
  const reg = await call('POST', '/api/auth/register', { email: 'T@school.kz', name: 'Айгуль', password: 'secret123' });
  assert.equal(reg.status, 200);

  const exam = (await call('POST', '/api/exams', { title: 'Алгебра', type: 'quiz' })).body;
  assert.equal(exam.status, 'draft');

  // нельзя подтвердить пустой экзамен и вопрос без верного варианта
  assert.equal((await call('POST', `/api/exams/${exam.id}/publish`)).body.error, 'no_questions');
  assert.equal((await call('PUT', `/api/exams/${exam.id}`, { questions: [{ text: '2+2', options: ['3', '4'] }] })).body.error, 'quiz_needs_correct');

  const saved = await call('PUT', `/api/exams/${exam.id}`, {
    questions: [{ text: '2+2', options: ['3', '4'], correctIndex: 1 }, { text: '3*3', options: ['9', '6'], correctIndex: 0 }],
  });
  assert.equal(saved.body.questions.length, 2);

  const pub = (await call('POST', `/api/exams/${exam.id}/publish`)).body;
  assert.match(pub.code, /^[A-Z2-9]{6}$/);
  assert.equal((await call('PUT', `/api/exams/${exam.id}`, { questions: [] })).body.error, 'exam_locked');

  // студент входит по коду (регистр не важен), правильные ответы ему не отдаются
  const join = await call('POST', `/api/public/exams/${pub.code.toLowerCase()}/join`, { name: 'Ерлан' });
  const h = { 'X-Attempt-Token': join.body.token };
  const attempt = (await call('GET', '/api/public/attempt', undefined, h)).body;
  assert.equal(attempt.questions.length, 2);
  assert.ok(attempt.questions.every((q) => !('correctIndex' in q)));

  await call('POST', '/api/public/attempt/events', { type: 'leave', reason: 'hidden' }, h);
  await call('POST', '/api/public/attempt/events', { type: 'return', awayMs: 12000 }, h);
  await call('POST', '/api/public/attempt/events', { type: 'paste', text: 'x'.repeat(500) }, h);
  await call('POST', '/api/public/attempt/events', { type: 'paste', text: 'short' }, h);
  const [q1, q2] = attempt.questions;
  await call('POST', '/api/public/attempt/submit', { answers: { [q1.id]: '1', [q2.id]: '1' } }, h);
  assert.equal((await call('POST', '/api/public/attempt/answers', { answers: {} }, h)).body.error, 'already_submitted');

  const mon = (await call('GET', `/api/exams/${exam.id}/monitor`)).body;
  const [p] = mon.participants;
  assert.equal(p.name, 'Ерлан');
  assert.equal(p.status, 'submitted');
  assert.equal(p.leaveCount, 1);
  assert.equal(p.awayMs, 12000);
  assert.equal(p.largePasteCount, 1);
  assert.deepEqual(p.score, { correct: 1, total: 2 });
  assert.deepEqual(mon.events.map((e) => e.type), ['join', 'leave', 'return', 'paste', 'paste', 'submit']);
  assert.equal(mon.events[3].detail.snippet.length, 500);

  // дальнейший опрос возвращает только новые события
  const after = mon.events.at(-1).id;
  assert.equal((await call('GET', `/api/exams/${exam.id}/monitor?after=${after}`)).body.events.length, 0);
});

test('учитель не видит чужие экзамены; закрытый экзамен не принимает студентов', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());

  await call('POST', '/api/auth/register', { email: 'a@a.kz', name: 'A', password: 'password1' });
  const exam = (await call('POST', '/api/exams', { title: 'Эссе', type: 'text' })).body;
  await call('PUT', `/api/exams/${exam.id}`, { questions: [{ text: 'Опишите…' }] });
  const { code } = (await call('POST', `/api/exams/${exam.id}/publish`)).body;
  await call('POST', `/api/exams/${exam.id}/close`);
  assert.equal((await call('POST', `/api/public/exams/${code}/join`, { name: 'S' })).body.error, 'exam_not_open');

  await call('POST', '/api/auth/register', { email: 'b@b.kz', name: 'B', password: 'password2' });
  assert.equal((await call('GET', `/api/exams/${exam.id}/monitor`)).status, 404);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@a.kz', password: 'wrong-pass' })).body.error, 'invalid_credentials');
});
