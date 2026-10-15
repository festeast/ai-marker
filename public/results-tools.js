// Страница «Ответы и оценки»: выгрузка в Excel, проверка по вопросу с группами одинаковых ответов,
// поиск похожих (возможно списанных) ответов и оценка по критериям рубрики.

// Вопросы, которые достались ученику (при вариантах у каждого свои).
function studentQuestions(data, p) {
  return p.questionIds ? data.questions.filter((q) => p.questionIds.includes(q.id)) : data.questions;
}
function studentMax(data, p) {
  return p.maxScore ?? data.maxScore;
}
function questionKind(data, q) {
  return q.kind || (data.exam.type === 'quiz' ? 'choice' : 'text');
}

// Ответ ученика текстом (для Excel и сравнения).
function answerText(data, q, value) {
  if (value === undefined || value === null || value === '') return '';
  const kind = questionKind(data, q);
  if (kind === 'order') return value.split(',').map((k) => q.options[Number(k)] ?? '?').join(' → ');
  if (kind === 'choice' || kind === 'truefalse') return q.options[Number(value)] ?? value;
  return value;
}

// ---------- Баллы: общий или по критериям рубрики ----------

// Поле балла для вопроса. С рубрикой — по полю на каждый критерий, общий балл считается сам.
// value() → { score, criteria } (criteria — null, если по критериям не оценивали).
function scoreInputs(q, a) {
  a = a || {};
  const score = el('input', { type: 'number', min: 0, max: q.points, step: 0.5, style: 'width:90px' });
  if (a.score !== undefined && a.score !== null) score.value = a.score;
  const total = el('span', { class: 'row', style: 'margin:0' }, el('span', {}, t('score') + ':'), score, el('span', { class: 'muted' }, `${t('of')} ${q.points}`));
  if (!q.rubric || !q.rubric.length) {
    return { node: total, value: () => ({ score: score.value === '' ? null : Number(score.value), criteria: null }) };
  }
  const crit = q.rubric.map((c, k) => {
    const input = el('input', { type: 'number', min: 0, max: c.points, step: 0.5, style: 'width:70px' });
    if (a.criteria && a.criteria[k] !== undefined && a.criteria[k] !== null) input.value = a.criteria[k];
    input.addEventListener('input', () => {
      score.value = String(crit.reduce((s, x) => s + (Number(x.value) || 0), 0));
    });
    return input;
  });
  // Учитель ввёл общий балл сам — критерии не используются.
  score.addEventListener('input', () => crit.forEach((x) => { x.value = ''; }));
  const rows = q.rubric.map((c, k) => el('tr', {},
    el('td', {}, c.text), el('td', { class: 'nowrap' }, crit[k], el('span', { class: 'muted' }, ` / ${c.points}`))));
  const node = el('div', {},
    el('table', { class: 'rubric-table' }, el('thead', {}, el('tr', {}, el('th', {}, t('rubric_criterion')), el('th', {}, t('score')))), el('tbody', {}, rows)),
    total);
  return {
    node,
    value: () => {
      if (crit.every((x) => x.value === '')) return { score: score.value === '' ? null : Number(score.value), criteria: null };
      const criteria = crit.map((x) => Number(x.value) || 0);
      return { score: criteria.reduce((s, v) => s + v, 0), criteria };
    },
  };
}

// Рубрика вопроса для просмотра (без полей ввода).
function rubricView(q) {
  if (!q.rubric || !q.rubric.length) return null;
  return el('details', {}, el('summary', { class: 'muted' }, `${t('rubric_title')} (${q.rubric.length})`),
    el('ul', { style: 'margin:4px 0' }, q.rubric.map((c) => el('li', {}, `${c.text} — ${c.points}`))));
}

// ---------- Выгрузка в Excel ----------

async function exportResultsXlsx(data) {
  const qs = data.questions;
  const qHead = qs.map((q, i) => `${t('xl_q')}${i + 1} (${q.points})`);
  const grades = [[t('xl_n'), t('col_student'), t('col_status'), ...qHead, t('total'), t('xl_max'), '%', t('xl_grade')]];
  data.participants.forEach((p, n) => {
    const mine = new Set(studentQuestions(data, p).map((q) => q.id));
    const max = studentMax(data, p);
    const full = p.submittedAt && p.gradedCount >= mine.size && max > 0;
    const pct = full ? Math.round(Number(p.total) * 1000 / max) / 10 : null;
    grades.push([n + 1, p.name, t(p.submittedAt ? 'st_submitted' : 'not_submitted'),
      ...qs.map((q) => {
        if (!mine.has(q.id)) return '';
        const s = p.answers[q.id] && p.answers[q.id].score;
        return s === undefined || s === null ? '' : Number(s);
      }),
      p.total === null || p.total === undefined ? '' : Number(p.total), max, pct ?? '', full ? gradeFor(pct) : '']);
  });

  const answers = [[t('col_student'), t('xl_q'), t('question'), t('answer'), t('score'), t('xl_max'), t('xl_comment')]];
  for (const p of data.participants) {
    studentQuestions(data, p).forEach((q) => {
      const a = p.answers[q.id] || {};
      answers.push([p.name, data.questions.indexOf(q) + 1, q.text, answerText(data, q, a.value),
        a.score === undefined || a.score === null ? '' : Number(a.score), q.points, a.comment || '']);
    });
  }
  await XlsxWrite.download(`${data.exam.title} - ${t('xl_file')}`, [
    { name: t('xl_sheet_grades'), rows: grades, widths: [5, 28, 14, ...qs.map(() => 9), 9, 9, 7, 8] },
    { name: t('xl_sheet_answers'), rows: answers, widths: [24, 6, 40, 50, 8, 8, 50], wrap: [2, 3, 6] },
  ]);
}

// ---------- Сравнение ответов ----------

function normAnswer(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Похожесть строк по парам букв (0…1): ловит опечатки в коротких ответах.
function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2), c = grams.get(g);
    if (c > 0) { grams.set(g, c - 1); common++; }
  }
  return 2 * common / (a.length + b.length - 2);
}

function shingles(tokens, n) {
  const set = new Set();
  for (let i = 0; i + n <= tokens.length; i++) set.add(tokens.slice(i, i + n).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

// Код без комментариев, пустых строк и строк заготовки учителя — в виде слов-токенов.
function codeTokens(code, starter) {
  const skip = new Set(String(starter || '').split('\n').map((l) => l.trim()).filter(Boolean));
  return String(code || '').split('\n')
    .map((l) => l.replace(/(#|\/\/).*$/, '').trim())
    .filter((l) => l && !skip.has(l))
    .join('\n').match(/[A-Za-z_]\w*|\d+|\S/g) || [];
}

// Отпечаток ответа для сравнения или null, если ответ слишком короткий, чтобы судить.
const COPY_RULES = {
  text: { n: 3, minTokens: 8, threshold: 0.5 },
  code: { n: 5, minTokens: 25, threshold: 0.7 },
};
function fingerprint(kind, q, value) {
  const rule = COPY_RULES[kind];
  const tokens = kind === 'code' ? codeTokens(value, q.starter) : normAnswer(value).split(' ').filter(Boolean);
  return tokens.length >= rule.minTokens ? shingles(tokens, rule.n) : null;
}

// Пары учеников с подозрительно похожими ответами.
// Открытые вопросы и код — по совпадающим кусочкам текста; ответы, похожие на эталон, не считаются.
// Тест — по одинаковым неверным ответам.
function findSuspiciousPairs(data) {
  const students = data.participants.filter((p) => p.submittedAt);
  const pairs = new Map();
  const pairOf = (a, b) => {
    const key = a.id + ':' + b.id;
    if (!pairs.has(key)) pairs.set(key, { a, b, items: [], wrong: [] });
    return pairs.get(key);
  };
  const owns = (p, q) => !p.questionIds || p.questionIds.includes(q.id);

  data.questions.forEach((q, qi) => {
    const kind = questionKind(data, q);
    if (kind === 'text' || kind === 'code') {
      const rule = COPY_RULES[kind];
      const ref = q.reference ? fingerprint(kind, q, q.reference) : null;
      const prints = students.filter((p) => owns(p, q) && p.answers[q.id] && p.answers[q.id].value)
        .map((p) => ({ p, value: p.answers[q.id].value, fp: fingerprint(kind, q, p.answers[q.id].value) }))
        .filter((x) => x.fp);
      prints.forEach((x) => { x.refSim = ref ? jaccard(x.fp, ref) : 0; });
      for (let i = 0; i < prints.length; i++) {
        for (let j = i + 1; j < prints.length; j++) {
          const x = prints[i], y = prints[j];
          const sim = jaccard(x.fp, y.fp);
          if (sim < rule.threshold) continue;
          if (x.refSim >= rule.threshold && y.refSim >= rule.threshold) continue;
          pairOf(x.p, y.p).items.push({ q, qi, kind, sim, va: x.value, vb: y.value });
        }
      }
    } else {
      const correct = kind === 'order' ? q.options.map((_, k) => k).join(',') : String(q.correctIndex);
      const wrong = students.filter((p) => owns(p, q) && p.answers[q.id] && p.answers[q.id].value && p.answers[q.id].value !== correct);
      for (let i = 0; i < wrong.length; i++) {
        for (let j = i + 1; j < wrong.length; j++) {
          if (wrong[i].answers[q.id].value === wrong[j].answers[q.id].value) pairOf(wrong[i], wrong[j]).wrong.push(qi);
        }
      }
    }
  });

  // Сколько неверных ответов у ученика среди вопросов теста.
  const wrongCount = new Map(students.map((p) => [p.id, data.questions.filter((q) => {
    const kind = questionKind(data, q);
    if (kind === 'text' || kind === 'code' || !owns(p, q)) return false;
    const a = p.answers[q.id];
    const correct = kind === 'order' ? q.options.map((_, k) => k).join(',') : String(q.correctIndex);
    return a && a.value && a.value !== correct;
  }).length]));

  return [...pairs.values()].map((x) => {
    const sameWrong = x.wrong.length >= 3 && x.wrong.length >= 0.6 * Math.max(wrongCount.get(x.a.id), wrongCount.get(x.b.id));
    return { ...x, wrong: sameWrong ? x.wrong : [], top: Math.max(0, ...x.items.map((i) => i.sim)) };
  }).filter((x) => x.items.length || x.wrong.length)
    .sort((x, y) => (y.items.length ? 1 + y.top : 0) - (x.items.length ? 1 + x.top : 0) || y.wrong.length - x.wrong.length);
}

function renderSuspicious(box, data) {
  const pairs = findSuspiciousPairs(data);
  const name = (p) => el('a', { href: '#p' + p.id }, p.name);
  if (!pairs.length) {
    box.replaceChildren(el('p', { class: 'muted' }, t('copy_none')), el('p', { class: 'muted small' }, t('copy_hint')));
    return pairs;
  }
  box.replaceChildren(el('p', { class: 'muted small' }, t('copy_hint')), ...pairs.map((x) => {
    const parts = x.items.map((i) => `${t('question')} ${i.qi + 1}: ${Math.round(i.sim * 100)}%`);
    if (x.wrong.length) parts.push(t('copy_same_wrong').replace('{n}', x.wrong.length));
    const body = x.items.map((i) => el('div', { class: 'question' },
      el('b', {}, `${i.qi + 1}. ${i.q.text}`), el('span', { class: 'muted' }, ` · ${t('copy_similar')} ${Math.round(i.sim * 100)}%`),
      el('div', { class: 'compare' },
        el('div', {}, el('div', { class: 'muted' }, x.a.name), el('pre', { class: i.kind === 'code' ? 'code-view' : 'answer-view' }, i.va)),
        el('div', {}, el('div', { class: 'muted' }, x.b.name), el('pre', { class: i.kind === 'code' ? 'code-view' : 'answer-view' }, i.vb)))));
    if (x.wrong.length) {
      body.push(el('p', {}, t('copy_same_wrong_list').replace('{list}', x.wrong.map((qi) => qi + 1).join(', '))));
    }
    return el('details', { class: 'copy-pair' },
      el('summary', {}, name(x.a), ' — ', name(x.b), el('span', { class: 'muted' }, ' · ' + parts.join(' · '))), body);
  }));
  return pairs;
}

// ---------- Проверка по вопросу: одинаковые ответы — одной группой ----------

// Группы ответов на вопрос: одинаковые после нормализации (регистр, знаки, пробелы) и очень похожие короткие (опечатки).
function answerGroups(data, q) {
  const students = data.participants.filter((p) => p.submittedAt && (!p.questionIds || p.questionIds.includes(q.id)));
  const exact = new Map();
  for (const p of students) {
    const value = (p.answers[q.id] && p.answers[q.id].value) || '';
    const key = questionKind(data, q) === 'code' ? value.replace(/\s+/g, ' ').trim() : normAnswer(value);
    if (!exact.has(key)) exact.set(key, { key, members: [] });
    exact.get(key).members.push({ p, value });
  }
  const groups = [];
  for (const g of [...exact.values()].sort((a, b) => b.members.length - a.members.length)) {
    const near = g.key && g.key.length <= 300 && questionKind(data, q) !== 'code'
      ? groups.find((x) => x.key && x.key.length <= 300 && diceSimilarity(x.key, g.key) >= 0.8) : null;
    if (near) near.members.push(...g.members);
    else groups.push(g);
  }
  // Пустые ответы — в конце.
  return groups.sort((a, b) => (!a.key) - (!b.key) || b.members.length - a.members.length);
}

// box — контейнер; state.questionId — выбранный вопрос; onSaved — перезагрузить страницу.
function renderGrouping(box, data, state, onSaved) {
  const qs = data.questions.filter((q) => ['text', 'code'].includes(questionKind(data, q)));
  if (!qs.length || !data.participants.some((p) => p.submittedAt)) { box.closest('details').hidden = true; return; }
  box.closest('details').hidden = false;
  if (!qs.some((q) => q.id === state.questionId)) state.questionId = qs[0].id;
  const select = el('select', { style: 'width:auto;max-width:100%' }, qs.map((q) => {
    const i = data.questions.indexOf(q);
    return el('option', { value: q.id }, `${t('question')} ${i + 1}: ${q.text.length > 70 ? q.text.slice(0, 70) + '…' : q.text}`);
  }));
  select.value = String(state.questionId);
  select.addEventListener('change', () => { state.questionId = Number(select.value); renderGrouping(box, data, state, onSaved); });

  const q = qs.find((x) => x.id === state.questionId);
  const groups = answerGroups(data, q);
  const cards = groups.map((g) => {
    const variants = [...new Set(g.members.map((m) => m.value.trim()))];
    const first = g.members[0].p.answers[q.id] || {};
    // Если у всей группы одна и та же оценка — подставляем её.
    const same = g.members.every((m) => {
      const a = m.p.answers[q.id] || {};
      return a.score === first.score && (a.comment || '') === (first.comment || '');
    });
    const inputs = scoreInputs(q, same ? first : {});
    const comment = el('input', { type: 'text', placeholder: t('comment_placeholder') });
    if (same) comment.value = first.comment || '';
    const msg = el('span', { class: 'muted' });
    const save = el('button', { class: 'small', onclick: async () => {
      const v = inputs.value();
      msg.className = 'muted'; msg.textContent = '';
      if (v.score === null || Number.isNaN(v.score)) { msg.className = 'error'; msg.textContent = t('err_invalid_score'); return; }
      save.disabled = true;
      try {
        for (let i = 0; i < g.members.length; i++) {
          msg.textContent = `${i + 1} / ${g.members.length}…`;
          await rpc('set_grade', { p_participant_id: g.members[i].p.id, p_question_id: q.id, p_score: v.score, p_comment: comment.value, p_criteria: v.criteria });
        }
        await onSaved();
      } catch (err) { msg.className = 'error'; msg.textContent = err.message; save.disabled = false; }
    } }, g.members.length > 1 ? t('group_save_all').replace('{n}', g.members.length) : t('save'));
    const shown = variants.slice(0, 3);
    return el('div', { class: 'question group' },
      el('div', { class: 'row spread' },
        el('b', {}, g.members.length > 1 ? t('group_n').replace('{n}', g.members.length) : t('group_one')),
        variants.length > 1 ? el('span', { class: 'muted small' }, t('group_variants').replace('{n}', variants.length)) : null),
      g.key ? shown.map((v) => el('pre', { class: questionKind(data, q) === 'code' ? 'code-view' : 'answer-view' }, v)) : el('p', { class: 'muted' }, t('no_answer')),
      variants.length > shown.length ? el('p', { class: 'muted small' }, t('group_more').replace('{n}', variants.length - shown.length)) : null,
      el('p', { class: 'small', style: 'margin:6px 0' }, ...g.members.flatMap((m, k) => {
        const a = m.p.answers[q.id] || {};
        return [k ? ', ' : '', el('a', { href: '#p' + m.p.id }, m.p.name),
          el('span', { class: 'muted' }, a.score === undefined || a.score === null ? '' : ` (${a.score}${a.source ? ' · ' + t('by_' + a.source) : ''})`)];
      })),
      inputs.node, el('div', { style: 'margin-top:6px' }, comment),
      el('div', { class: 'row', style: 'margin-top:8px' }, save, msg));
  });
  box.replaceChildren(...[
    el('p', { class: 'muted' }, t('group_intro')),
    el('label', { class: 'row' }, select),
    rubricView(q), q.reference ? el('p', { class: 'muted' }, `${t('reference')}: ${q.reference}`) : null,
    el('p', { class: 'muted small' }, t('group_count').replace('{groups}', groups.length).replace('{n}', groups.reduce((s, g) => s + g.members.length, 0))),
    ...cards].filter(Boolean));
}
