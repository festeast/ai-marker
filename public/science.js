// Формулы, реакции и таблицы: ввод с нижними и верхними индексами, проверка и показ ответов.
// Индексы — это обычные символы Юникода (H₂O, Fe³⁺), поэтому ответ — простой текст:
// он одинаково выглядит в базе, в Excel и для ИИ.
// Вопрос formula: spec { mode: 'blanks', template: '2H₂ + [O₂] → 2H₂O' } или { mode: 'full', answers: [...] };
// вопрос table: spec { rows: [[{ v, b }]], header }. Ответ на пропуски и таблицу — JSON-массив строк.
const Sci = (() => {
  const SUB = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  };
  const SUP = {
    0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ',
    r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  };
  const SYMBOLS = ['→', '⇌', '↑', '↓', '·', '°', 'Δ', '±', '≈', 'λ', 'μ', 'Ω', 'π'];
  const mapAll = (s, map) => [...s].map((c) => map[c === '−' ? '-' : c] || c).join('');

  // Набор с клавиатуры: «->» → «→», «<=>» → «⇌», «^2+» → «²⁺», «_2» → «₂»;
  // в режиме химии цифры после буквы или скобки — индексы (H2O → H₂O), а «+» и «−» после верхней цифры — заряд.
  function transform(text, chem) {
    let s = text.replace(/<->|<=>/g, '⇌').replace(/-->|->/g, '→')
      .replace(/\^([0-9+\-−=()n]+)/g, (_, g) => mapAll(g, SUP))
      .replace(/_([0-9+\-−=()]+)/g, (_, g) => mapAll(g, SUB));
    if (chem) {
      s = s.replace(/([A-Za-z)\]₀-₉]\[?)(\d+)/g, (_, a, d) => a + mapAll(d, SUB))
        .replace(/([⁰¹²³⁴-⁹])([+\-−]+)/g, (_, a, g) => a + mapAll(g, SUP));
    }
    return s;
  }

  // Вставка текста в поле на место курсора (кнопки панели не забирают фокус).
  function insert(input, text) {
    if (!input) return;
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.setRangeText(text, a, b, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Панель для полей одного вопроса: x₂, x², стрелки и знаки. kit.bind(input, onChange, before) подключает поле;
  // before — символ перед полем (для пропуска внутри формулы: H[2]O → индекс).
  function kit(opts = {}) {
    let target = null, mode = null;
    const first = [];
    const keep = (b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); return b; };
    const modeBtn = (m, label, title) => {
      const b = keep(el('button', { type: 'button', class: 'secondary small sci-mode', title, 'aria-pressed': 'false' }, label));
      b.addEventListener('click', () => {
        const input = target || first[0];
        // Выделенный текст — сразу в индекс; иначе режим включается и выключается.
        if (input && input.selectionStart !== input.selectionEnd) {
          const sel = input.value.slice(input.selectionStart, input.selectionEnd);
          insert(input, mapAll(sel, m === 'sub' ? SUB : SUP));
          return;
        }
        mode = mode === m ? null : m;
        bar.querySelectorAll('.sci-mode').forEach((x) => { x.classList.toggle('on', x === b && mode === m); x.setAttribute('aria-pressed', String(x === b && mode === m)); });
        if (input) input.focus();
      });
      return b;
    };
    const bar = el('div', { class: 'sci-bar' },
      modeBtn('sub', 'x₂', t('sci_sub')), modeBtn('sup', 'x²', t('sci_sup')),
      SYMBOLS.map((s) => {
        const b = keep(el('button', { type: 'button', class: 'secondary small' }, s));
        b.addEventListener('click', () => insert(target || first[0], s));
        return b;
      }));
    const node = el('div', { class: 'sci-kit' }, bar, opts.hint === false ? null : el('p', { class: 'muted small sci-hint' }, t(opts.chem ? 'sci_hint_chem' : 'sci_hint')));
    return {
      node,
      setChem(v) { opts.chem = v; node.querySelector('.sci-hint') && (node.querySelector('.sci-hint').textContent = t(v ? 'sci_hint_chem' : 'sci_hint')); },
      bind(input, onChange, before = '') {
        first.push(input);
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('autocomplete', 'off');
        input.addEventListener('focus', () => { target = input; });
        input.addEventListener('beforeinput', (e) => {
          if (!mode || e.inputType !== 'insertText' || !e.data || e.isComposing) return;
          const out = mapAll(e.data, mode === 'sub' ? SUB : SUP);
          if (out === e.data) return;
          e.preventDefault();
          insert(input, out);
        });
        input.addEventListener('input', (e) => {
          if (e.isComposing) return;
          const pos = input.selectionStart ?? input.value.length;
          const head = input.value.slice(0, pos);
          const ctx = typeof before === 'function' ? before() : before;
          const fixed = transform(ctx + head, opts.chem).slice(ctx.length);
          if (fixed !== head && transform(ctx, opts.chem) === ctx) {
            input.value = fixed + input.value.slice(pos);
            input.setSelectionRange(fixed.length, fixed.length);
          }
          if (onChange) onChange(input.value);
        });
        return input;
      },
    };
  }

  // ---------- Сравнение (тот же алгоритм, что _sci_norm в supabase/schema.sql) ----------
  function norm(s, cs) {
    let v = String(s ?? '').replace(/[−–]/g, '-').replace(/<->/g, '⇌').replace(/<=>/g, '⇌').replace(/[⇄↔]/g, '⇌')
      .replace(/-->/g, '→').replace(/->/g, '→').replace(/=>/g, '→').replace(/[⟶⇒=]/g, '→')
      .replace(/[*×⋅∙]/g, '·').replace(/(\d),(?=\d)/g, '$1.').replace(/\s+/g, '');
    if (!cs) v = v.toLowerCase().replace(/ё/g, 'е');
    const sides = [];
    let terms = [], cur = '', depth = 0;
    const flush = () => [...terms, cur].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('+');
    for (const ch of v) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(depth - 1, 0);
      if (depth === 0 && (ch === '→' || ch === '⇌')) { sides.push(flush() + ch); terms = []; cur = ''; }
      else if (depth === 0 && ch === '+') { terms.push(cur); cur = ''; }
      else cur += ch;
    }
    return sides.join('') + flush();
  }
  function match(expected, given, cs) {
    const g = norm(given, cs);
    return g !== '' && String(expected ?? '').split('|').some((a) => norm(a, cs) === g);
  }
  const caseSensitive = (q) => (q.spec && q.spec.cs !== undefined ? !!q.spec.cs : q.kind === 'formula');

  // Шаблон с [пропусками] → куски текста между ними и верные ответы.
  function splitTemplate(template) {
    const parts = [], answers = [];
    let last = 0;
    String(template || '').replace(/\[([^[\]]*)\]/g, (m, a, at) => { parts.push(template.slice(last, at)); answers.push(a); last = at + m.length; return m; });
    parts.push(String(template || '').slice(last));
    return { parts, answers };
  }
  const first = (alts) => String(alts ?? '').split('|')[0].trim();
  const isBlanks = (q) => q.kind === 'formula' && q.spec && q.spec.mode !== 'full';

  // Ответ ученика на пропуски или таблицу — массив строк.
  function parseList(value) {
    try { const a = JSON.parse(value); return Array.isArray(a) ? a.map((x) => (x == null ? '' : String(x))) : []; } catch { return []; }
  }
  // Верные ответы пропусков или ячеек по порядку (только у учителя).
  function expected(q) {
    if (q.kind === 'formula') return splitTemplate(q.spec.template).answers;
    return q.spec.rows.flat().filter((c) => c.b).map((c) => c.v);
  }
  // Проверка по пунктам: [{ given, expected, ok }] — для пропусков и таблицы; для формулы целиком — один пункт.
  function check(q, value) {
    if (!q.spec) return [];
    const cs = caseSensitive(q);
    if (q.kind === 'formula' && q.spec.mode === 'full') {
      const given = value || '';
      return [{ given, expected: (q.spec.answers || [])[0] || '', ok: (q.spec.answers || []).some((a) => match(a, given, cs)) }];
    }
    const given = parseList(value);
    return expected(q).map((e, i) => ({ given: given[i] || '', expected: e, ok: match(e, given[i] || '', cs) }));
  }
  function isEmpty(q, value) {
    if (q.kind === 'formula' && q.spec && q.spec.mode === 'full') return !String(value || '').trim();
    return !parseList(value).some((x) => x.trim());
  }

  // Ответ текстом (Excel, группы ответов): пропуски вписаны в формулу, таблица — строками через « | ».
  function answerText(q, value) {
    if (value === undefined || value === null || value === '' || !q.spec) return value || '';
    if (q.kind === 'formula' && q.spec.mode === 'full') return value;
    const given = parseList(value);
    if (q.kind === 'formula') {
      const { parts } = splitTemplate(q.spec.template);
      return parts.map((p, i) => p + (i < parts.length - 1 ? `[${given[i] || '…'}]` : '')).join('');
    }
    let k = 0;
    return q.spec.rows.map((row) => row.map((c) => (c.b ? `[${given[k++] || '…'}]` : c.v)).join(' | ')).join('\n');
  }
  function correctText(q) {
    if (!q.spec) return '';
    if (q.kind === 'formula' && q.spec.mode === 'full') return (q.spec.answers || []).join(' / ');
    if (q.kind === 'formula') {
      const { parts, answers } = splitTemplate(q.spec.template);
      return parts.map((p, i) => p + (i < answers.length ? first(answers[i]) : '')).join('');
    }
    return q.spec.rows.map((row) => row.map((c) => (c.b ? first(c.v) : c.v)).join(' | ')).join('\n');
  }

  // ---------- Ученик ----------
  // Поле для пропуска: ширина по содержимому.
  function blankInput(value) {
    const input = el('input', { type: 'text', class: 'sci-blank', 'aria-label': t('answer') });
    input.value = value || '';
    const fit = () => { input.style.width = Math.max(3, [...input.value].length + 1.5) + 'ch'; };
    input.addEventListener('input', fit);
    fit();
    return input;
  }

  // Вопрос для ученика. value — сохранённый ответ, onChange(newValue) — сохранить.
  function studentView(q, value, onChange) {
    const spec = q.spec || {};
    const k = kit({ chem: !!spec.chem });
    if (q.kind === 'formula' && spec.mode === 'full') {
      const input = k.bind(el('input', { type: 'text', class: 'sci-input', 'aria-label': t('answer'), placeholder: t('sci_full_placeholder') }), onChange);
      input.value = value || '';
      return el('div', {}, el('p', { class: 'muted' }, t('sci_full_student')), k.node, input);
    }
    const given = parseList(value);
    const vals = [];
    const save = () => onChange(JSON.stringify(vals));
    const field = (i, before) => {
      vals[i] = given[i] || '';
      const input = blankInput(vals[i]);
      return k.bind(input, (v) => { vals[i] = v; save(); }, before);
    };
    if (q.kind === 'formula') {
      const parts = spec.parts || [''];
      const line = el('div', { class: 'sci-formula' });
      parts.forEach((p, i) => {
        line.append(el('span', {}, p));
        if (i < parts.length - 1) line.append(field(i, () => (p.slice(-1) || '')));
      });
      return el('div', {}, el('p', { class: 'muted' }, t('sci_blanks_student')), k.node, line);
    }
    let n = 0;
    const rows = (spec.rows || []).map((row, r) => el('tr', {}, row.map((c) => {
      const head = spec.header && r === 0;
      if (c.b) { const input = field(n++, ''); input.classList.add('sci-cell'); return el(head ? 'th' : 'td', { class: 'sci-fill' }, input); }
      return el(head ? 'th' : 'td', {}, c.v || '');
    })));
    return el('div', {}, el('p', { class: 'muted' }, t('table_student')), k.node,
      el('div', { class: 'table-scroll' }, el('table', { class: 'sci-table' }, el('tbody', {}, rows))));
  }

  // ---------- Учитель: просмотр ответа ----------
  const mark = (x) => el('span', { class: 'sci-ans ' + (x.ok ? 'ok' : 'error'), title: x.ok ? '' : `${t('correct_answer')}: ${x.expected.split('|').join(' / ')}` },
    x.given.trim() ? x.given : '…');
  function resultView(q, value) {
    if (!q.spec) return el('span', {}, value || '');
    const items = check(q, value);
    const none = value === undefined || value === null || isEmpty(q, value);
    if (q.kind === 'formula' && q.spec.mode === 'full') {
      return el('div', {},
        el('p', { style: 'margin:6px 0' }, `${t('answer')}: `, none ? el('span', { class: 'muted' }, t('no_answer')) : el('span', { class: items[0].ok ? 'ok' : 'error' }, (items[0].ok ? '✓ ' : '✗ ') + value)),
        items[0].ok ? null : el('p', { class: 'muted', style: 'margin:0' }, `${t('correct_answer')}: ${correctText(q)}`));
    }
    const right = items.filter((x) => x.ok).length;
    const summary = el('p', { class: 'muted', style: 'margin:6px 0' }, none ? t('no_answer') : t('sci_right_of').replace('{k}', right).replace('{n}', items.length));
    if (q.kind === 'formula') {
      const { parts } = splitTemplate(q.spec.template);
      const line = el('div', { class: 'sci-formula' }, parts.flatMap((p, i) => (i < parts.length - 1 ? [el('span', {}, p), mark(items[i])] : [el('span', {}, p)])));
      return el('div', {}, line, summary, right < items.length ? el('p', { class: 'muted', style: 'margin:0' }, `${t('correct_answer')}: ${correctText(q)}`) : null);
    }
    let n = 0;
    const rows = q.spec.rows.map((row, r) => el('tr', {}, row.map((c) => {
      const tag = q.spec.header && r === 0 ? 'th' : 'td';
      if (!c.b) return el(tag, {}, c.v);
      const x = items[n++];
      return el(tag, { class: 'sci-fill' }, mark(x), x.ok ? null : el('div', { class: 'muted small' }, first(x.expected)));
    })));
    return el('div', {}, el('div', { class: 'table-scroll' }, el('table', { class: 'sci-table' }, el('tbody', {}, rows))), summary);
  }

  return { kit, transform, norm, match, check, isEmpty, splitTemplate, answerText, correctText, studentView, resultView, parseList, blankInput, first };
})();
