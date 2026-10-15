// Разрешённые учителем инструменты на странице экзамена: открываются панелью поверх страницы,
// ученик никуда не уходит; недостающий инструмент можно попросить у учителя.
// ExamTools.mount(tools, { sheet, storeKey, requests, ask, refresh }) — вызывается из exam.html.
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

  let tools = [], requests = [], sheetText = '', notice;

  // options: { sheet, storeKey, requests, ask(tool) → Promise<state>, refresh() → Promise<state> }
  // state — ответ attempt_tools: { tools, toolsSheet, requests: [{ tool, status }] }.
  function mount(list, options = {}) {
    opts = options;
    panel = el('section', { class: 'tool-panel', role: 'dialog', 'aria-modal': 'false' });
    titleEl = el('h2', {});
    body = el('div', { class: 'tool-body' });
    const close = el('button', { type: 'button', class: 'secondary small', 'aria-label': t('tool_close'), onclick: () => open(null) }, '✕');
    panel.append(el('div', { class: 'tool-head' }, titleEl, close), body);
    panel.hidden = true;
    dock = el('nav', { class: 'tools-dock', 'aria-label': t('tools_title') });
    notice = el('div', { class: 'tool-notice', role: 'status' });
    notice.hidden = true;
    document.body.append(panel, notice, dock);
    document.body.classList.add('has-tools');
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) open(null); });
    update({ tools: list, toolsSheet: options.sheet, requests: options.requests || [] }, true);
    // Учитель может выдать инструмент во время экзамена — проверяем время от времени.
    if (opts.refresh) setInterval(() => { if (panel) opts.refresh().then((st) => update(st)).catch(() => {}); }, 15000);
  }

  function update(st, first) {
    if (!panel || !st) return;
    const before = new Set(tools);
    const was = new Map(requests.map((r) => [r.tool, r.status]));
    tools = ORDER.filter((k) => (st.tools || []).includes(k));
    requests = st.requests || [];
    if (st.toolsSheet !== undefined && st.toolsSheet !== sheetText) { sheetText = st.toolsSheet || ''; delete built.sheet; }
    if (!first) {
      const added = tools.filter((k) => !before.has(k));
      const denied = requests.filter((r) => r.status === 'denied' && was.get(r.tool) === 'pending');
      const parts = [];
      if (added.length) parts.push(t('tool_granted') + ': ' + added.map((k) => t('tool_' + k + '_short')).join(', '));
      if (denied.length) parts.push(t('tool_denied') + ': ' + denied.map((r) => t('tool_' + r.tool + '_short')).join(', '));
      if (parts.length) { notice.textContent = parts.join('. '); notice.hidden = false; setTimeout(() => { notice.hidden = true; }, 8000); }
    }
    const canAsk = opts.ask && ORDER.some((k) => !tools.includes(k));
    dock.replaceChildren(...tools.map((k) => el('button', { type: 'button', class: 'secondary', 'data-tool': k, onclick: () => open(current === k ? null : k) },
      ICONS[k] + ' ' + t('tool_' + k + '_short'))),
    ...(canAsk ? [el('button', { type: 'button', class: 'secondary', 'data-tool': 'ask', title: t('tool_ask_title'), onclick: () => open(current === 'ask' ? null : 'ask') },
      tools.length ? '＋' : '＋ ' + t('tool_ask_short'))] : []));
    for (const b of dock.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tool === current);
    if (current === 'ask') { delete built.ask; open('ask'); }
    else if (current && !tools.includes(current)) open(null);
  }

  function open(k) {
    current = k;
    for (const b of dock.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tool === k);
    if (!k) { panel.hidden = true; return; }
    titleEl.textContent = t(k === 'ask' ? 'tool_ask_title' : 'tool_' + k);
    panel.classList.toggle('wide', k === 'periodic' || k === 'graph');
    if (k === 'ask') delete built.ask; // список запросов всегда свежий
    if (!built[k]) built[k] = BUILD[k]();
    body.replaceChildren(built[k].node);
    // панель над кнопками: на узком экране они могут занять две строки
    const gap = dock.offsetHeight + 20;
    panel.style.bottom = gap + 'px';
    panel.style.maxHeight = `calc(100vh - ${gap + 16}px)`;
    panel.hidden = false;
    if (built[k].onShow) built[k].onShow();
  }

  // ---------- запрос инструмента у учителя ----------
  function ask() {
    const status = new Map(requests.map((r) => [r.tool, r.status]));
    const msg = el('p', { class: 'error small' });
    const rows = ORDER.filter((k) => !tools.includes(k)).map((k) => {
      const st = status.get(k);
      const btn = el('button', { type: 'button', class: 'secondary small' }, t(st === 'denied' ? 'tool_ask_again' : 'tool_ask'));
      btn.disabled = st === 'pending';
      btn.addEventListener('click', async () => {
        btn.disabled = true; msg.textContent = '';
        try { update(await opts.ask(k)); } catch (err) { msg.textContent = err.message; btn.disabled = false; }
      });
      return el('div', { class: 'tool-ask-row' },
        el('span', {}, ICONS[k] + ' ' + t('tool_' + k)),
        st ? el('span', { class: 'badge ' + (st === 'denied' ? 'flag' : 'away') }, t('tool_req_' + st)) : null,
        btn);
    });
    return { node: el('div', {}, el('p', { class: 'muted small', style: 'margin-top:0' }, t('tool_ask_hint')), rows, msg) };
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
    return { node: el('div', { class: 'tool-sheet' }, sheetText || t('tool_sheet_empty')) };
  }

  const BUILD = { calculator, code, sheet, ask };
  function unmount() {
    if (panel) { panel.remove(); dock.remove(); notice.remove(); document.body.classList.remove('has-tools'); panel = null; }
  }

  return { mount, unmount, BUILD, store: () => store };
})();
