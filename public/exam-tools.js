// Разрешённые учителем инструменты на странице экзамена: открываются панелью поверх страницы,
// ученик никуда не уходит. ExamTools.mount(tools, { sheet, storeKey }) — вызывается из exam.html.
// Нужны app.js (el, t), calc-engine.js, а для отдельных инструментов — code-runner.js и periodic-data.js.
const ExamTools = (() => {
  const ORDER = ['calculator', 'graph', 'code', 'periodic', 'sheet'];
  const ICONS = { calculator: '🧮', graph: '📈', code: '💻', periodic: '⚛', sheet: '📄' };
  let panel, body, titleEl, dock, current = null;
  const built = {};
  let opts = {};
  const store = {
    get(k) { try { return localStorage.getItem(opts.storeKey + ':tool:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(opts.storeKey + ':tool:' + k, v); } catch {} },
  };

  function mount(tools, options = {}) {
    opts = options;
    const list = ORDER.filter((k) => (tools || []).includes(k));
    if (!list.length) return;
    panel = el('section', { class: 'tool-panel', role: 'dialog', 'aria-modal': 'false' });
    titleEl = el('h2', {});
    body = el('div', { class: 'tool-body' });
    const close = el('button', { type: 'button', class: 'secondary small', 'aria-label': t('tool_close'), onclick: () => open(null) }, '✕');
    panel.append(el('div', { class: 'tool-head' }, titleEl, close), body);
    panel.hidden = true;
    dock = el('nav', { class: 'tools-dock', 'aria-label': t('tools_title') },
      list.map((k) => el('button', { type: 'button', class: 'secondary', 'data-tool': k, onclick: () => open(current === k ? null : k) },
        ICONS[k] + ' ' + t('tool_' + k + '_short'))));
    document.body.append(panel, dock);
    document.body.classList.add('has-tools');
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) open(null); });
  }

  function open(k) {
    current = k;
    for (const b of dock.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tool === k);
    if (!k) { panel.hidden = true; return; }
    titleEl.textContent = t('tool_' + k);
    panel.classList.toggle('wide', k === 'periodic' || k === 'graph');
    if (!built[k]) built[k] = BUILD[k]();
    body.replaceChildren(built[k].node);
    panel.hidden = false;
    if (built[k].onShow) built[k].onShow();
  }

  // ---------- научный калькулятор ----------
  function calculator() {
    let deg = store.get('deg') !== '0', ans = 0;
    const input = el('input', { type: 'text', class: 'calc-input', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('tool_calculator') });
    const result = el('div', { class: 'calc-result', 'aria-live': 'polite' }, '0');
    const history = el('ul', { class: 'calc-history' });
    const modeBtn = el('button', { type: 'button', class: 'secondary small' });
    const showMode = () => { modeBtn.textContent = deg ? 'DEG' : 'RAD'; modeBtn.title = t(deg ? 'calc_deg' : 'calc_rad'); };
    modeBtn.addEventListener('click', () => { deg = !deg; store.set('deg', deg ? '1' : '0'); showMode(); });
    showMode();

    function insert(text) {
      const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
      input.setRangeText(text, a, b, 'end');
      // для функций курсор ставим внутрь скобок
      input.focus();
    }
    function evaluate() {
      const src = input.value.trim();
      if (!src) return;
      let v;
      try { v = CalcEngine.compile(src, { deg })(0, ans); } catch { v = NaN; }
      const shown = CalcEngine.format(v);
      if (shown === null) { result.textContent = t('calc_error'); result.classList.add('error'); return; }
      result.classList.remove('error');
      result.textContent = '= ' + shown;
      ans = v;
      const item = el('li', { title: t('calc_reuse') }, el('span', { class: 'muted' }, src), ' = ', el('b', {}, shown));
      item.addEventListener('click', () => { input.value = src; input.focus(); });
      history.prepend(item);
      while (history.children.length > 20) history.lastChild.remove();
      input.select();
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); evaluate(); } });

    // [надпись, что вставить или действие, класс]
    const keys = [
      ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['(', '('], [')', ')'], ['C', 'clear', 'fn'],
      ['sin⁻¹', 'asin('], ['cos⁻¹', 'acos('], ['tan⁻¹', 'atan('], ['x²', '^2'], ['xʸ', '^'], ['⌫', 'back', 'fn'],
      ['ln', 'ln('], ['log', 'log('], ['eˣ', 'e^'], ['√', 'sqrt('], ['∛', 'cbrt('], ['n!', '!'],
      ['7', '7', 'd'], ['8', '8', 'd'], ['9', '9', 'd'], ['÷', '/'], ['nCr', 'nCr('], ['nPr', 'nPr('],
      ['4', '4', 'd'], ['5', '5', 'd'], ['6', '6', 'd'], ['×', '*'], ['π', 'π'], ['e', 'e'],
      ['1', '1', 'd'], ['2', '2', 'd'], ['3', '3', 'd'], ['−', '-'], ['×10ˣ', 'E'], ['Ans', 'Ans'],
      ['0', '0', 'd'], ['.', '.', 'd'], [',', ','], ['+', '+'], ['=', 'eval', 'eq'],
    ];
    const pad = el('div', { class: 'calc-pad' }, keys.map(([label, act, cls]) => el('button', {
      type: 'button', class: 'calc-key ' + (cls || ''),
      onclick: () => {
        if (act === 'clear') { input.value = ''; result.textContent = '0'; result.classList.remove('error'); input.focus(); }
        else if (act === 'back') {
          const a = input.selectionStart, b = input.selectionEnd;
          if (a !== b) input.setRangeText('', a, b, 'end'); else if (a > 0) input.setRangeText('', a - 1, a, 'end');
          input.focus();
        } else if (act === 'eval') evaluate();
        else insert(act);
      },
    }, label)));
    const help = el('details', { class: 'muted small' }, el('summary', {}, t('calc_help_title')), el('p', {}, t('calc_help')));
    return {
      node: el('div', { class: 'calc' }, el('div', { class: 'row spread' }, modeBtn, el('span', { class: 'muted small' }, t('calc_enter_hint'))),
        input, result, pad, help, history),
      onShow: () => input.focus(),
    };
  }

  // ---------- свободный запуск кода (не связан с вопросами и никуда не отправляется) ----------
  function code() {
    let lang = store.get('lang') === 'java' ? 'java' : 'python';
    const area = CodeRunner.editor(el('textarea', { rows: 12, 'aria-label': t('tool_code') }));
    const stdin = el('textarea', { class: 'code-small', rows: 3, spellcheck: 'false' });
    const status = el('span', { class: 'muted' });
    const out = el('div');
    const select = el('select', {}, CodeRunner.LANGS.map((l) => el('option', { value: l }, CodeRunner.langName(l))));
    const load = () => { area.value = store.get('code:' + lang) ?? CodeRunner.starter(lang); select.value = lang; };
    load();
    select.addEventListener('change', () => { lang = select.value; store.set('lang', lang); load(); CodeRunner.preload(lang); });
    area.addEventListener('input', () => store.set('code:' + lang, area.value));
    const btn = el('button', { type: 'button' }, t('code_run'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.className = 'muted';
      out.replaceChildren();
      try {
        const res = await CodeRunner.run(lang, area.value, [stdin.value], (k) => { status.textContent = t(k); }, { echo: true });
        out.replaceChildren(CodeRunner.resultView(res));
        status.textContent = t('code_finished');
      } catch (err) {
        status.className = 'error';
        status.textContent = err.message;
      } finally { btn.disabled = false; }
    });
    return {
      node: el('div', {},
        el('div', { class: 'row spread' }, select, el('span', { class: 'muted small' }, t('code_tool_hint'))),
        area,
        el('details', { style: 'margin-top:8px' }, el('summary', { class: 'muted' }, t('code_stdin')), stdin),
        el('div', { class: 'row', style: 'margin-top:8px' }, btn, status),
        out),
      onShow: () => CodeRunner.preload(lang),
    };
  }

  // ---------- справочный лист учителя ----------
  function sheet() {
    return { node: el('div', { class: 'tool-sheet' }, opts.sheet || t('tool_sheet_empty')) };
  }

  const BUILD = { calculator, code, sheet };
  return { mount, BUILD, store: () => store };
})();
