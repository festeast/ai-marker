// Графический калькулятор для экзамена: до трёх функций y = f(x), сдвиг и масштаб,
// значения под курсором, нули функций и точки пересечения. Подключается после exam-tools.js.
ExamTools.BUILD.graph = function graph() {
  const COLORS = ['#2557d6', '#c53030', '#1f8a4c'];
  const store = ExamTools.store();
  let view = { x0: -10, x1: 10, y0: -7, y1: 7 };
  let fns = [null, null, null];
  let marks = [];
  let hoverX = null;

  const canvas = el('canvas', { class: 'graph-canvas', height: 320 });
  const readout = el('div', { class: 'muted small graph-readout' }, t('graph_hint'));
  const found = el('div', { class: 'small' });
  const inputs = COLORS.map((c, i) => {
    const inp = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: i === 0 ? 'x^2 - 3' : '' });
    inp.value = store.get('graph' + i) || '';
    inp.addEventListener('input', () => { store.set('graph' + i, inp.value); parse(); draw(); });
    return inp;
  });
  const fnRows = inputs.map((inp, i) => el('label', { class: 'graph-fn' },
    el('span', { style: `color:${COLORS[i]}` }, `y${'₁₂₃'[i]} =`), inp));

  function parse() {
    marks = [];
    found.replaceChildren();
    fns = inputs.map((inp) => {
      inp.classList.remove('bad');
      if (!inp.value.trim()) return null;
      try { const f = CalcEngine.compile(inp.value); f(1); return f; } catch { inp.classList.add('bad'); return null; }
    });
  }

  const val = (f, x) => { const y = f(x); return Number.isFinite(y) ? y : NaN; };

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 360, h = 320;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const X = (x) => ((x - view.x0) / (view.x1 - view.x0)) * w;
    const Y = (y) => h - ((y - view.y0) / (view.y1 - view.y0)) * h;
    // сетка с «круглым» шагом
    const step = (span, px) => { const raw = span / (px / 60), p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw); };
    const sx = step(view.x1 - view.x0, w), sy = step(view.y1 - view.y0, h);
    g.font = '11px system-ui, sans-serif'; g.lineWidth = 1;
    const label = (v) => String(Number(v.toPrecision(6)));
    for (let x = Math.ceil(view.x0 / sx) * sx; x <= view.x1; x += sx) {
      g.strokeStyle = '#eef0f4'; g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), h); g.stroke();
      if (Math.abs(x) > sx / 2) { g.fillStyle = '#6b7280'; g.fillText(label(x), X(x) + 2, Math.min(h - 3, Math.max(11, Y(0) + 12))); }
    }
    for (let y = Math.ceil(view.y0 / sy) * sy; y <= view.y1; y += sy) {
      g.strokeStyle = '#eef0f4'; g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(w, Y(y)); g.stroke();
      if (Math.abs(y) > sy / 2) { g.fillStyle = '#6b7280'; g.fillText(label(y), Math.min(w - 30, Math.max(2, X(0) + 3)), Y(y) - 2); }
    }
    g.strokeStyle = '#9aa1ad';
    g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.moveTo(X(0), 0); g.lineTo(X(0), h); g.stroke();
    // функции: разрываем линию, где значение уходит далеко за экран (tan, 1/x)
    fns.forEach((f, i) => {
      if (!f) return;
      g.strokeStyle = COLORS[i]; g.lineWidth = 2; g.beginPath();
      let pen = false;
      const span = view.y1 - view.y0;
      for (let px = 0; px <= w; px++) {
        const y = val(f, view.x0 + (px / w) * (view.x1 - view.x0));
        if (Number.isNaN(y) || y > view.y1 + 4 * span || y < view.y0 - 4 * span) { pen = false; continue; }
        if (pen) g.lineTo(px, Y(y)); else g.moveTo(px, Y(y));
        pen = true;
      }
      g.stroke();
    });
    g.fillStyle = '#1d2330';
    for (const m of marks) { g.beginPath(); g.arc(X(m.x), Y(m.y), 4, 0, 2 * Math.PI); g.fill(); }
    if (hoverX !== null) {
      g.strokeStyle = '#9aa1ad'; g.lineWidth = 1; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(X(hoverX), 0); g.lineTo(X(hoverX), h); g.stroke(); g.setLineDash([]);
      const parts = [`x = ${CalcEngine.format(hoverX)}`];
      fns.forEach((f, i) => {
        if (!f) return;
        const y = val(f, hoverX);
        if (Number.isNaN(y)) return;
        g.fillStyle = COLORS[i]; g.beginPath(); g.arc(X(hoverX), Y(y), 4, 0, 2 * Math.PI); g.fill();
        parts.push(`y${'₁₂₃'[i]} = ${CalcEngine.format(y)}`);
      });
      readout.textContent = parts.join(';  ');
    }
  }

  // Корень на отрезке со сменой знака — делением пополам.
  function bisect(h, a, b) {
    let fa = h(a);
    for (let k = 0; k < 60; k++) {
      const m = (a + b) / 2, fm = h(m);
      if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
    }
    return (a + b) / 2;
  }
  function findPoints() {
    marks = [];
    const items = [];
    const n = 2000, dx = (view.x1 - view.x0) / n;
    const scan = (h, f, label) => {
      let prev = h(view.x0);
      for (let k = 1; k <= n; k++) {
        const x = view.x0 + k * dx, cur = h(x);
        if (Number.isFinite(prev) && Number.isFinite(cur) && (cur === 0 || prev * cur < 0)) {
          const r = cur === 0 ? x : bisect(h, x - dx, x);
          const y = f(r);
          // смена знака через разрыв (как у tan) — не корень
          if (Math.abs(h(r)) < 1e-6 * (1 + Math.abs(y)) && items.length < 30) { marks.push({ x: r, y }); items.push(`${label}: (${CalcEngine.format(Number(r.toPrecision(8)))}; ${CalcEngine.format(Number(y.toPrecision(8)))})`); }
        }
        prev = cur;
      }
    };
    fns.forEach((f, i) => { if (f) scan((x) => val(f, x), (x) => 0, t('graph_zero') + ` y${'₁₂₃'[i]}`); });
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const a = fns[i], b = fns[j];
      if (a && b) scan((x) => val(a, x) - val(b, x), (x) => val(a, x), t('graph_cross') + ` y${'₁₂₃'[i]}, y${'₁₂₃'[j]}`);
    }
    found.replaceChildren(items.length ? el('ul', {}, items.map((s) => el('li', {}, s))) : el('p', { class: 'muted' }, t('graph_none')));
    draw();
  }

  function zoom(k, cx, cy) {
    cx = cx ?? (view.x0 + view.x1) / 2; cy = cy ?? (view.y0 + view.y1) / 2;
    view = { x0: cx + (view.x0 - cx) * k, x1: cx + (view.x1 - cx) * k, y0: cy + (view.y0 - cy) * k, y1: cy + (view.y1 - cy) * k };
    draw();
  }

  // мышь и касание: перетаскивание сдвигает, движение показывает значения
  let drag = null;
  const toX = (e) => { const r = canvas.getBoundingClientRect(); return view.x0 + ((e.clientX - r.left) / r.width) * (view.x1 - view.x0); };
  canvas.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY, v: { ...view }, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (drag && (Math.abs(e.clientX - drag.px) > 3 || Math.abs(e.clientY - drag.py) > 3)) drag.moved = true;
    if (drag && drag.moved) {
      const r = canvas.getBoundingClientRect();
      const dx = ((e.clientX - drag.px) / r.width) * (drag.v.x1 - drag.v.x0), dy = ((e.clientY - drag.py) / r.height) * (drag.v.y1 - drag.v.y0);
      view = { x0: drag.v.x0 - dx, x1: drag.v.x1 - dx, y0: drag.v.y0 + dy, y1: drag.v.y1 + dy };
    }
    hoverX = toX(e);
    draw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, toX(e)); }, { passive: false });

  const btn = (text, fn, title) => el('button', { type: 'button', class: 'secondary small', title: title || '', onclick: fn }, text);
  parse();
  window.addEventListener('resize', () => { if (canvas.isConnected) draw(); });
  return {
    node: el('div', { class: 'graph' }, fnRows, canvas, readout,
      el('div', { class: 'row', style: 'margin-top:6px' },
        btn('＋', () => zoom(1 / 1.5), t('graph_zoom_in')), btn('－', () => zoom(1.5), t('graph_zoom_out')),
        btn(t('graph_reset'), () => { view = { x0: -10, x1: 10, y0: -7, y1: 7 }; draw(); }),
        btn(t('graph_find'), findPoints)),
      found,
      el('p', { class: 'muted small' }, t('graph_rad_note'))),
    onShow: () => requestAnimationFrame(draw),
  };
};
