const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { openDb } = require('./db');

const SESSION_DAYS = 30;
const ONLINE_WINDOW_MS = 30_000; // без heartbeat дольше этого — студент считается офлайн
const LARGE_PASTE_CHARS = Number(process.env.LARGE_PASTE_CHARS || 200);
const PASTE_SNIPPET_CHARS = 500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O и 1/I

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Ошибки отдаём кодами — клиент переводит их на нужный язык (ru / kk).
function fail(res, status, error) {
  return res.status(status).json({ error });
}

function createApp({ db = openDb(), now = () => Date.now() } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // sendBeacon шлёт text/plain — разбираем его как JSON
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));
  app.use((req, _res, next) => {
    if (typeof req.body === 'string') {
      try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
    }
    next();
  });

  // ---------- Аккаунт учителя ----------

  function startSession(res, teacherId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = now() + SESSION_DAYS * 86_400_000;
    db.prepare('INSERT INTO sessions (token, teacher_id, expires_at) VALUES (?, ?, ?)').run(token, teacherId, expires);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  function requireTeacher(req, res, next) {
    const token = parseCookies(req.headers.cookie).sid;
    const row = token && db.prepare(`
      SELECT t.id, t.email, t.name FROM sessions s JOIN teachers t ON t.id = s.teacher_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
    if (!row) return fail(res, 401, 'unauthorized');
    req.teacher = row;
    req.sessionToken = token;
    next();
  }

  app.post('/api/auth/register', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail(res, 400, 'invalid_email');
    if (!name) return fail(res, 400, 'name_required');
    if (password.length < 8) return fail(res, 400, 'password_too_short');
    if (db.prepare('SELECT 1 FROM teachers WHERE email = ?').get(email)) return fail(res, 409, 'email_taken');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO teachers (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(email, name, hashPassword(password), now());
    startSession(res, Number(lastInsertRowid));
    res.json({ id: Number(lastInsertRowid), email, name });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const row = db.prepare('SELECT * FROM teachers WHERE email = ?').get(email);
    if (!row || !checkPassword(String(req.body.password || ''), row.password_hash)) {
      return fail(res, 401, 'invalid_credentials');
    }
    startSession(res, row.id);
    res.json({ id: row.id, email: row.email, name: row.name });
  });

  app.post('/api/auth/logout', requireTeacher, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireTeacher, (req, res) => res.json(req.teacher));

  // ---------- Экзамены (учитель) ----------

  function loadOwnExam(req, res) {
    const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND teacher_id = ?').get(Number(req.params.id), req.teacher.id);
    if (!exam) fail(res, 404, 'not_found');
    return exam;
  }

  function examQuestions(examId, { withAnswers }) {
    return db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY position').all(examId).map((q) => ({
      id: q.id,
      text: q.text,
      ...(q.options ? { options: JSON.parse(q.options) } : {}),
      ...(withAnswers && q.correct_index !== null ? { correctIndex: q.correct_index } : {}),
    }));
  }

  function examJson(exam) {
    return {
      id: exam.id,
      title: exam.title,
      type: exam.type,
      status: exam.status,
      code: exam.code,
      createdAt: exam.created_at,
      publishedAt: exam.published_at,
    };
  }

  app.get('/api/exams', requireTeacher, (req, res) => {
    const rows = db.prepare(`
      SELECT e.*, (SELECT COUNT(*) FROM participants p WHERE p.exam_id = e.id) AS participant_count
      FROM exams e WHERE teacher_id = ? ORDER BY created_at DESC`).all(req.teacher.id);
    res.json(rows.map((e) => ({ ...examJson(e), participantCount: e.participant_count })));
  });

  app.post('/api/exams', requireTeacher, (req, res) => {
    const title = String(req.body.title || '').trim();
    const type = req.body.type;
    if (!title) return fail(res, 400, 'title_required');
    if (type !== 'quiz' && type !== 'text') return fail(res, 400, 'invalid_type');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO exams (teacher_id, title, type, created_at) VALUES (?, ?, ?, ?)'
    ).run(req.teacher.id, title, type, now());
    res.json(examJson(db.prepare('SELECT * FROM exams WHERE id = ?').get(lastInsertRowid)));
  });

  app.get('/api/exams/:id', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    res.json({ ...examJson(exam), questions: examQuestions(exam.id, { withAnswers: true }) });
  });

  function validateQuestions(type, questions) {
    if (!Array.isArray(questions)) return 'invalid_questions';
    for (const q of questions) {
      if (!q || !String(q.text || '').trim()) return 'question_text_required';
      if (type === 'quiz') {
        const opts = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()) : [];
        if (opts.length < 2 || opts.some((o) => !o)) return 'quiz_needs_options';
        if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= opts.length) {
          return 'quiz_needs_correct';
        }
      }
    }
    return null;
  }

  // Сохраняет название и весь список вопросов черновика целиком.
  app.put('/api/exams/:id', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    if (exam.status !== 'draft') return fail(res, 409, 'exam_locked');
    const title = String(req.body.title ?? exam.title).trim();
    if (!title) return fail(res, 400, 'title_required');
    const questions = req.body.questions ?? [];
    const error = validateQuestions(exam.type, questions);
    if (error) return fail(res, 400, error);

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE exams SET title = ? WHERE id = ?').run(title, exam.id);
      db.prepare('DELETE FROM questions WHERE exam_id = ?').run(exam.id);
      const insert = db.prepare(
        'INSERT INTO questions (exam_id, position, text, options, correct_index) VALUES (?, ?, ?, ?, ?)'
      );
      questions.forEach((q, i) => {
        const isQuiz = exam.type === 'quiz';
        insert.run(
          exam.id, i, String(q.text).trim(),
          isQuiz ? JSON.stringify(q.options.map((o) => String(o).trim())) : null,
          isQuiz ? q.correctIndex : null,
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ...examJson({ ...exam, title }), questions: examQuestions(exam.id, { withAnswers: true }) });
  });

  // «Подтвердить»: фиксирует вопросы и выдаёт код экзамена.
  app.post('/api/exams/:id/publish', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    if (exam.status !== 'draft') return fail(res, 409, 'exam_locked');
    const count = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id = ?').get(exam.id).n;
    if (count === 0) return fail(res, 400, 'no_questions');
    let code;
    do code = randomCode(); while (db.prepare('SELECT 1 FROM exams WHERE code = ?').get(code));
    db.prepare("UPDATE exams SET status = 'published', code = ?, published_at = ? WHERE id = ?").run(code, now(), exam.id);
    res.json(examJson(db.prepare('SELECT * FROM exams WHERE id = ?').get(exam.id)));
  });

  app.post('/api/exams/:id/close', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    if (exam.status !== 'published') return fail(res, 409, 'exam_not_open');
    db.prepare("UPDATE exams SET status = 'closed' WHERE id = ?").run(exam.id);
    res.json(examJson(db.prepare('SELECT * FROM exams WHERE id = ?').get(exam.id)));
  });

  app.delete('/api/exams/:id', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    db.prepare('DELETE FROM exams WHERE id = ?').run(exam.id);
    res.json({ ok: true });
  });

  // Мониторинг: участники со сводкой + лента событий после ?after=<id события>.
  app.get('/api/exams/:id/monitor', requireTeacher, (req, res) => {
    const exam = loadOwnExam(req, res);
    if (!exam) return;
    const after = Number(req.query.after || 0);
    const t = now();
    const participants = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM events e WHERE e.participant_id = p.id AND e.type = 'leave') AS leave_count,
        (SELECT COALESCE(SUM(json_extract(e.detail, '$.awayMs')), 0) FROM events e
           WHERE e.participant_id = p.id AND e.type = 'return') AS away_ms,
        (SELECT COUNT(*) FROM events e WHERE e.participant_id = p.id AND e.type = 'paste'
           AND json_extract(e.detail, '$.large') = 1) AS large_paste_count,
        (SELECT type FROM events e WHERE e.participant_id = p.id AND e.type IN ('leave', 'return')
           ORDER BY e.id DESC LIMIT 1) AS last_focus_event
      FROM participants p WHERE p.exam_id = ? ORDER BY p.joined_at`).all(exam.id);

    const questions = exam.type === 'quiz' ? examQuestions(exam.id, { withAnswers: true }) : [];
    const answersStmt = db.prepare('SELECT question_id, value FROM answers WHERE participant_id = ?');

    res.json({
      exam: examJson(exam),
      largePasteChars: LARGE_PASTE_CHARS,
      participants: participants.map((p) => {
        const answers = answersStmt.all(p.id);
        let status = 'online';
        if (p.submitted_at) status = 'submitted';
        else if (t - p.last_seen > ONLINE_WINDOW_MS) status = 'offline';
        else if (p.last_focus_event === 'leave') status = 'away';
        return {
          id: p.id,
          name: p.name,
          joinedAt: p.joined_at,
          lastSeen: p.last_seen,
          submittedAt: p.submitted_at,
          status,
          leaveCount: p.leave_count,
          awayMs: p.away_ms,
          largePasteCount: p.large_paste_count,
          answeredCount: answers.length,
          ...(exam.type === 'quiz' && p.submitted_at ? { score: quizScore(questions, answers) } : {}),
        };
      }),
      questionCount: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id = ?').get(exam.id).n,
      events: db.prepare(`
        SELECT e.id, e.type, e.detail, e.created_at, p.name, p.id AS participant_id
        FROM events e JOIN participants p ON p.id = e.participant_id
        WHERE e.exam_id = ? AND e.id > ? ORDER BY e.id LIMIT 500`).all(exam.id, after).map((e) => ({
        id: e.id,
        type: e.type,
        detail: e.detail ? JSON.parse(e.detail) : null,
        createdAt: e.created_at,
        participantId: e.participant_id,
        name: e.name,
      })),
    });
  });

  function quizScore(questions, answers) {
    const byId = new Map(answers.map((a) => [a.question_id, a.value]));
    const correct = questions.filter((q) => byId.get(q.id) === String(q.correctIndex)).length;
    return { correct, total: questions.length };
  }

  // ---------- Студент (без аккаунта: код + имя) ----------

  function openExamByCode(code) {
    return db.prepare('SELECT * FROM exams WHERE code = ?').get(String(code || '').trim().toUpperCase());
  }

  app.get('/api/public/exams/:code', (req, res) => {
    const exam = openExamByCode(req.params.code);
    if (!exam) return fail(res, 404, 'exam_not_found');
    res.json({ title: exam.title, type: exam.type, status: exam.status, code: exam.code });
  });

  app.post('/api/public/exams/:code/join', (req, res) => {
    const exam = openExamByCode(req.params.code);
    if (!exam) return fail(res, 404, 'exam_not_found');
    if (exam.status !== 'published') return fail(res, 409, 'exam_not_open');
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) return fail(res, 400, 'name_required');
    const token = crypto.randomBytes(24).toString('hex');
    const t = now();
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO participants (exam_id, name, token, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)'
    ).run(exam.id, name, token, t, t);
    addEvent(exam.id, Number(lastInsertRowid), 'join', null);
    res.json({ token });
  });

  function addEvent(examId, participantId, type, detail) {
    db.prepare('INSERT INTO events (exam_id, participant_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(examId, participantId, type, detail ? JSON.stringify(detail) : null, now());
  }

  // Токен попытки — в заголовке или (для sendBeacon) в теле запроса.
  function requireAttempt(req, res, next) {
    const token = req.get('x-attempt-token') || (req.body && req.body.token);
    const p = token && db.prepare('SELECT * FROM participants WHERE token = ?').get(String(token));
    if (!p) return fail(res, 401, 'unauthorized');
    req.participant = p;
    req.exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(p.exam_id);
    db.prepare('UPDATE participants SET last_seen = ? WHERE id = ?').run(now(), p.id);
    next();
  }

  function requireWritable(req, res, next) {
    if (req.participant.submitted_at) return fail(res, 409, 'already_submitted');
    if (req.exam.status !== 'published') return fail(res, 409, 'exam_not_open');
    next();
  }

  app.get('/api/public/attempt', requireAttempt, (req, res) => {
    const answers = {};
    for (const a of db.prepare('SELECT question_id, value FROM answers WHERE participant_id = ?').all(req.participant.id)) {
      answers[a.question_id] = a.value;
    }
    res.json({
      name: req.participant.name,
      submitted: Boolean(req.participant.submitted_at),
      exam: { title: req.exam.title, type: req.exam.type, status: req.exam.status },
      questions: examQuestions(req.exam.id, { withAnswers: false }),
      answers,
    });
  });

  function saveAnswers(participant, exam, answers) {
    if (!answers || typeof answers !== 'object') return;
    const valid = new Set(db.prepare('SELECT id FROM questions WHERE exam_id = ?').all(exam.id).map((q) => q.id));
    const upsert = db.prepare(`
      INSERT INTO answers (participant_id, question_id, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (participant_id, question_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    for (const [qid, value] of Object.entries(answers)) {
      if (valid.has(Number(qid)) && value !== null && value !== undefined) {
        upsert.run(participant.id, Number(qid), String(value).slice(0, 50_000), now());
      }
    }
  }

  app.post('/api/public/attempt/answers', requireAttempt, requireWritable, (req, res) => {
    saveAnswers(req.participant, req.exam, req.body.answers);
    res.json({ ok: true });
  });

  app.post('/api/public/attempt/heartbeat', requireAttempt, (_req, res) => res.json({ ok: true }));

  app.post('/api/public/attempt/events', requireAttempt, (req, res) => {
    if (req.participant.submitted_at) return res.json({ ok: true });
    const { type } = req.body;
    if (type === 'leave') {
      addEvent(req.exam.id, req.participant.id, 'leave', { reason: String(req.body.reason || 'hidden').slice(0, 20) });
    } else if (type === 'return') {
      const awayMs = Math.max(0, Math.min(Number(req.body.awayMs) || 0, 86_400_000));
      addEvent(req.exam.id, req.participant.id, 'return', { awayMs });
    } else if (type === 'paste') {
      const text = String(req.body.text || '');
      const length = Number(req.body.length) || text.length;
      addEvent(req.exam.id, req.participant.id, 'paste', {
        length,
        large: length >= LARGE_PASTE_CHARS ? 1 : 0,
        questionId: Number(req.body.questionId) || null,
        snippet: text.slice(0, PASTE_SNIPPET_CHARS),
      });
    } else {
      return fail(res, 400, 'invalid_event');
    }
    res.json({ ok: true });
  });

  app.post('/api/public/attempt/submit', requireAttempt, requireWritable, (req, res) => {
    saveAnswers(req.participant, req.exam, req.body.answers);
    db.prepare('UPDATE participants SET submitted_at = ? WHERE id = ?').run(now(), req.participant.id);
    addEvent(req.exam.id, req.participant.id, 'submit', null);
    res.json({ ok: true });
  });

  // ---------- Страницы ----------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/e/:code', (_req, res) => res.sendFile(path.join(pub, 'exam.html')));
  app.use(express.static(pub, { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    console.error(err);
    fail(res, 500, 'server_error');
  });

  return app;
}

module.exports = { createApp, LARGE_PASTE_CHARS };
