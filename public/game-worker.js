// Отдельный поток для игр учеников (задачи «Игра (ООП)» в классной работе).
// Здесь живут Pyodide, движок game-engine.py и сама игра; страница передаёт сюда холст
// (OffscreenCanvas), нажатия клавиш и мышь. Если игра зависнет, страница просто перезапустит поток.
// Используется из game-runtime.js.
let py = null;
let assets = {};
let keys = new Set();
let pressed = new Set();
let beatCount = 0;
const post = (m) => postMessage(m);

// ---------- встроенные пиксельные картинки: hero, hero_walk, enemy, coin, wall ----------
function makeSheet(frames, pal) {
  const n = frames.length;
  const c = new OffscreenCanvas(8 * n, 8);
  const x = c.getContext('2d');
  frames.forEach((rows, f) => rows.forEach((row, y) => [...row].forEach((ch, xx) => {
    const col = pal[ch];
    if (col) { x.fillStyle = col; x.fillRect(f * 8 + xx, y, 1, 1); }
  })));
  return { img: c, fw: 8, fh: 8, cols: n, frames: n };
}
const HERO_TOP = ['..hhhh..', '.hhhhhh.', '.hwkhwk.', '.hhhhhh.', 'abbbbbba', '.bbbbbb.'];
const LEGS = [['..l..l..', '..l..l..'], ['.l....l.', 'l......l'], ['..l..l..', '..l..l..'], ['..ll.ll.', '..l..l..']];
const HERO_PAL = { h: '#4cc9f0', w: '#ffffff', k: '#0b1020', b: '#3a86ff', a: '#4cc9f0', l: '#1d3557' };
const BUILTIN = {
  hero: { pal: HERO_PAL, frames: [HERO_TOP.concat(LEGS[0])] },
  hero_walk: { pal: HERO_PAL, frames: LEGS.map((l) => HERO_TOP.concat(l)) },
  enemy: { pal: { r: '#ff4d6d', w: '#ffffff', k: '#0b1020' }, frames: [['........', '..rrrr..', '.rrrrrr.', 'rrwkrwkr', 'rrrrrrrr', 'rrrrrrrr', '.rrrrrr.', '........']] },
  coin: { pal: { g: '#ffd166', h: '#fff3b0' }, frames: [['..gggg..', '.gggggg.', 'ggghhggg', 'ggghhggg', 'gggggggg', 'gggggggg', '.gggggg.', '..gggg..']] },
  wall: { pal: { k: '#5c6b8a', m: '#1b263b' }, frames: [['kkkkkkkm', 'kkkkkkkm', 'mmmmmmmm', 'kkmkkkkk', 'kkmkkkkk', 'mmmmmmmm', 'kkkkkkkm', 'kkkkkkkm']] },
};
function builtinAssets() {
  const out = {};
  for (const name in BUILTIN) out[name] = makeSheet(BUILTIN[name].frames, BUILTIN[name].pal);
  return out;
}

// ---------- то, что движок вызывает через js.globalThis ----------
self.getAsset = (name) => assets[name];
self.getAssetText = () => undefined;
self.keyDown = (n) => keys.has(n);
self.keyPressed = (n) => pressed.has(n);
self.endFrame = () => {
  pressed.clear();
  self.MOUSE.clicked = false;
  beatCount++;
  if (beatCount % 20 === 0) post({ type: 'beat' });
};
self.MOUSE = { x: 0, y: 0, down: false, clicked: false };
self.onGameSize = (w, h) => post({ type: 'size', w, h });
self.onGameScore = (n) => post({ type: 'score', n: Number(n) });
self.gameError = (line, msg) => post({ type: 'error', line, msg });
if (!self.requestAnimationFrame) {
  self.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  self.cancelAnimationFrame = (id) => clearTimeout(id);
}

// Маленькая картинка игры (JPEG) для галереи.
async function snapshot() {
  const c = self.GAME_CANVAS;
  if (!c) { post({ type: 'thumb', dataUrl: null }); return; }
  const w = 192;
  const h = Math.max(1, Math.round((w * c.height) / c.width));
  const tc = new OffscreenCanvas(w, h);
  tc.getContext('2d').drawImage(c, 0, 0, w, h);
  const blob = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const fr = new FileReader();
  fr.onload = () => post({ type: 'thumb', dataUrl: fr.result });
  fr.readAsDataURL(blob);
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      importScripts(m.indexURL + 'pyodide.js');
      py = await loadPyodide({ indexURL: m.indexURL });
      py.setStdout({ batched: (s) => post({ type: 'log', text: s }) });
      py.setStderr({ batched: (s) => post({ type: 'log', text: s }) });
      const engine = await (await fetch(m.engineUrl)).text();
      py.globals.set('ENGINE_SRC', engine);
      py.runPython(
        'import sys, types\n' +
          'mod = types.ModuleType("engine")\n' +
          'exec(compile(ENGINE_SRC, "engine.py", "exec"), mod.__dict__)\n' +
          'sys.modules["engine"] = mod\n'
      );
      post({ type: 'ready' });
    } else if (m.type === 'run') {
      self.GAME_CANVAS = m.canvas;
      keys = new Set();
      pressed = new Set();
      assets = builtinAssets();
      py.globals.set('USER_CODE', m.code);
      post({ type: 'started' });
      py.runPython('import engine\nengine.run_user_code(USER_CODE)');
      const loop = py.runPython('import engine\nbool(engine._current is not None and engine._current._running)');
      if (!loop) post({ type: 'noloop' });
    } else if (m.type === 'stop') {
      if (py) py.runPython('import engine\nengine.stop_all()');
    } else if (m.type === 'key') {
      if (m.down) {
        if (!keys.has(m.name)) pressed.add(m.name);
        keys.add(m.name);
      } else keys.delete(m.name);
    } else if (m.type === 'mouse') {
      self.MOUSE.x = m.x;
      self.MOUSE.y = m.y;
      self.MOUSE.down = m.down;
      if (m.click) self.MOUSE.clicked = true;
    } else if (m.type === 'snap') {
      await snapshot();
    }
  } catch (e) {
    post({ type: m.type === 'init' ? 'fatal' : 'error', line: 0, msg: String(e && e.message ? e.message : e) });
  }
};
