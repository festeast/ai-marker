// Разбор и вычисление выражений для калькулятора и графиков на экзамене (без eval).
// CalcEngine.compile('2sin(30)+x^2', { deg: true }) → функция f(x); ошибка в выражении — исключение.
// Поддерживает + − × ÷ ^ !, скобки, умножение без знака (2π, 3x, 2(1+x)), число вида 1.5E3,
// константы pi π e, Ans, переменную x и функции из FUNCS ниже.
const CalcEngine = (() => {
  const fact = (n) => {
    if (n < 0 || !Number.isInteger(n) || n > 170) return NaN;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  };
  const nCr = (n, r) => (r < 0 || r > n ? 0 : Math.round(fact(n) / (fact(r) * fact(n - r))));
  const nPr = (n, r) => (r < 0 || r > n ? 0 : Math.round(fact(n) / fact(n - r)));
  const mean = (...a) => a.reduce((s, x) => s + x, 0) / a.length;
  const variance = (a, sample) => {
    const m = mean(...a);
    return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - (sample ? 1 : 0));
  };
  const median = (...a) => {
    const s = a.slice().sort((x, y) => x - y), k = s.length >> 1;
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
  };
  // Очень маленькое значение тригонометрии (sin 180° = 1e-16) считаем нулём.
  const tidy = (v) => (Math.abs(v) < 1e-14 ? 0 : v);

  // [число аргументов (-1 — любое), функция(угол в радианах или градусах → ...)]
  function funcs(deg) {
    const toRad = deg ? Math.PI / 180 : 1;
    const fromRad = deg ? 180 / Math.PI : 1;
    return {
      sin: [1, (x) => tidy(Math.sin(x * toRad))],
      cos: [1, (x) => tidy(Math.cos(x * toRad))],
      tan: [1, (x) => { const c = tidy(Math.cos(x * toRad)); return c === 0 ? NaN : tidy(Math.sin(x * toRad)) / c; }],
      asin: [1, (x) => Math.asin(x) * fromRad],
      acos: [1, (x) => Math.acos(x) * fromRad],
      atan: [1, (x) => Math.atan(x) * fromRad],
      sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
      sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs], exp: [1, Math.exp],
      ln: [1, Math.log],
      log: [-1, (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b))],
      floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round],
      nCr: [2, nCr], nPr: [2, nPr],
      mean: [-1, mean], median: [-1, median],
      sum: [-1, (...a) => a.reduce((s, x) => s + x, 0)],
      min: [-1, Math.min], max: [-1, Math.max],
      sd: [-1, (...a) => Math.sqrt(variance(a, false))],
      sds: [-1, (...a) => Math.sqrt(variance(a, true))],
    };
  }

  function tokenize(src) {
    const s = String(src)
      .replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-')
      .replace(/²/g, '^2').replace(/³/g, '^3').replace(/π/g, ' pi ').replace(/√/g, ' sqrt ');
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const num = /^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/.exec(s.slice(i));
      if (num) { out.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
      const id = /^[A-Za-z]+/.exec(s.slice(i));
      if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      if ('+-*/^()!,'.includes(c)) { out.push({ t: c }); i++; continue; }
      throw new Error('bad_char');
    }
    return out;
  }

  // Рекурсивный спуск: каждая функция возвращает замыкание (env) => число.
  function compile(src, { deg = false } = {}) {
    const F = funcs(deg);
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p] || { t: 'end' };
    const take = (t) => { if (peek().t !== t) throw new Error('syntax'); return toks[p++]; };
    const startsValue = (tk) => tk.t === 'num' || tk.t === 'id' || tk.t === '(';

    function expr() {
      let a = term();
      while (peek().t === '+' || peek().t === '-') {
        const op = toks[p++].t, l = a, r = term();
        a = op === '+' ? (e) => l(e) + r(e) : (e) => l(e) - r(e);
      }
      return a;
    }
    function term() {
      let a = unary();
      for (;;) {
        const tk = peek();
        if (tk.t === '*' || tk.t === '/') {
          p++;
          const l = a, r = unary();
          a = tk.t === '*' ? (e) => l(e) * r(e) : (e) => l(e) / r(e);
        } else if (startsValue(tk)) { // 2x, 3(1+x), 2pi
          const l = a, r = power();
          a = (e) => l(e) * r(e);
        } else return a;
      }
    }
    function unary() {
      if (peek().t === '-') { p++; const a = unary(); return (e) => -a(e); }
      if (peek().t === '+') { p++; return unary(); }
      return power();
    }
    function power() {
      const base = postfix();
      if (peek().t !== '^') return base;
      p++;
      const ex = unary(); // справа налево: 2^3^2 = 2^9, 2^-1
      return (e) => Math.pow(base(e), ex(e));
    }
    function postfix() {
      let a = primary();
      while (peek().t === '!') { p++; const b = a; a = (e) => fact(b(e)); }
      return a;
    }
    function primary() {
      const tk = peek();
      if (tk.t === 'num') { p++; return () => tk.v; }
      if (tk.t === '(') { p++; const a = expr(); take(')'); return a; }
      if (tk.t !== 'id') throw new Error('syntax');
      p++;
      const name = tk.v;
      if (name === 'pi') return () => Math.PI;
      if (name === 'e') return () => Math.E;
      if (name === 'x' || name === 'X') return (e) => e.x;
      if (name === 'Ans' || name === 'ans') return (e) => e.ans;
      const f = F[name];
      if (!f) throw new Error('unknown');
      // sqrt 2 и √2 без скобок — корень из следующего множителя
      if (peek().t !== '(') { const a = power(); return (e) => f[1](a(e)); }
      p++;
      const args = [expr()];
      while (peek().t === ',') { p++; args.push(expr()); }
      take(')');
      if (f[0] >= 0 && args.length !== f[0] && !(name === 'log' && args.length <= 2)) throw new Error('args');
      if (name === 'log' && args.length > 2) throw new Error('args');
      return (e) => f[1](...args.map((a) => a(e)));
    }

    if (!toks.length) throw new Error('empty');
    const root = expr();
    if (peek().t !== 'end') throw new Error('syntax');
    return (x = 0, ans = 0) => root({ x, ans });
  }

  // Число для показа: до 10 значащих цифр, без хвостовых нулей.
  function format(v) {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-9 || a >= 1e15)) {
      const [m, ex] = v.toExponential(9).split('e');
      return m.replace(/\.?0+$/, '') + 'E' + ex.replace('+', '');
    }
    return String(Number(v.toPrecision(10)));
  }

  return { compile, format };
})();
