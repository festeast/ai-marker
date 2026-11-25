// Задачи «Игра (ООП)» в классной работе — по мотивам OOP Game Jam.
// Ученик пишет игру на Python с классами на маленьком движке (game-engine.py), игра идёт прямо
// в браузере (Pyodide в отдельном потоке, game-worker.js), а страница проверяет по тексту кода,
// есть ли в нём главные идеи ООП: классы, инкапсуляция, свой родительский класс, полиморфизм,
// статические члены.
//
// GameKit.stage({ onScore })     → { node, run(code), stop(), snapshot(), running() } — экран игры с консолью
// GameKit.analyze(code)          → { ok: Set(id), lines, classes } — ООП-проверки
// GameKit.badgesView(code, req)  → список проверок (✓ / ○), обязательные отмечены
// GameKit.cheatSheet()           → <details> со шпаргалкой по движку
// GameKit.STARTERS, starterName  → готовые игры и примеры для заготовки
// GameKit.jamLesson()            → задачи готового урока Game Jam (шаги + своя игра)
// Подключается после i18n.js и app.js (нужны t и el).
const GameKit = (() => {
  const PYODIDE_URL = window.CODE_RUNNER_PYODIDE_URL || 'https://cdn.jsdelivr.net/npm/pyodide@0.29.5/';
  // Та же версия (?v=...), что и у этого скрипта, — чтобы после обновления сайта не взять старый движок из кэша.
  const VER = (() => { try { return new URL(document.currentScript.src).search; } catch { return ''; } })();
  const ABS = (u) => new URL(u, location.href).href;
  const LOAD_TIMEOUT_MS = 180000;

  const BADGES = ['classes', 'enc', 'parent', 'poly', 'static'];

  // ---------- ООП-проверки по тексту кода ----------
  function analyze(code) {
    const lines = String(code || '').split('\n');
    const classes = {};
    let cur = null, staticHit = false, ctor = 0, privates = 0, accessors = 0;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const cm = line.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
      if (cm) { cur = cm[1]; classes[cur] = { base: (cm[2] || '').split(',')[0].trim(), methods: new Set() }; continue; }
      if (/^\S/.test(line) && !/^\s*#/.test(line)) cur = null;
      if (!cur) continue;
      const mm = line.match(/^\s{2,}def\s+(\w+)/);
      if (mm) {
        classes[cur].methods.add(mm[1]);
        if (mm[1] === '__init__') ctor++;
        if (/^(get|set)_\w+/.test(mm[1])) accessors++;
      }
      if (/^\s+@(staticmethod|classmethod|property)/.test(line)) {
        if (/static|class/.test(line)) staticHit = true;
        if (/property/.test(line)) accessors++;
      }
      if (/^ {4}[A-Za-z_]\w*\s*=/.test(line)) staticHit = true; // атрибут класса
    }
    const names = Object.keys(classes);
    for (const l of lines) { const m = l.match(/self\.__[A-Za-z]\w*/g); if (m) privates += m.length; }
    let ownParent = false, poly = false;
    for (const n of names) {
      const b = classes[n].base;
      if (b && classes[b]) {
        ownParent = true;
        for (const m of classes[n].methods) if (m !== '__init__' && classes[b].methods.has(m)) poly = true;
      }
    }
    const ok = new Set();
    if (names.length >= 3 && ctor >= 3) ok.add('classes');
    if (privates >= 1 && accessors >= 1) ok.add('enc');
    if (ownParent) ok.add('parent');
    if (poly) ok.add('poly');
    if (staticHit) ok.add('static');
    return { ok, lines: lines.filter((l) => l.trim()).length, classes: names.length };
  }

  function badgesView(code, require, extraClass) {
    const res = analyze(code);
    const req = new Set(require || []);
    return el('ul', { class: 'gm-badges ' + (extraClass || '') }, BADGES.map((id) => {
      const ok = res.ok.has(id);
      return el('li', { class: ok ? 'ok' : (req.has(id) ? 'need' : 'muted'), title: t('gm_badge_' + id + '_hint') },
        (ok ? '✓ ' : '○ ') + t('gm_badge_' + id) + (req.has(id) ? ' *' : ''));
    }));
  }

  // ---------- поток с Python ----------
  const Runner = {
    worker: null, ready: null, active: null, lastBeat: 0,
    spawn() {
      const w = this.worker = new Worker('game-worker.js' + VER);
      this.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t('err_code_load_failed') + ' (timeout)')), LOAD_TIMEOUT_MS);
        this._res = () => { clearTimeout(timer); resolve(); };
        this._rej = (e) => { clearTimeout(timer); reject(e); };
      });
      this.ready.catch(() => {});
      w.onmessage = (e) => this.onMsg(e.data, w);
      w.onerror = (e) => { if (w === this.worker) this._rej(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'init', indexURL: PYODIDE_URL, engineUrl: ABS('game-engine.py' + VER) });
    },
    onMsg(m, w) {
      if (w !== this.worker) return;
      const a = this.active;
      if (m.type === 'ready') this._res();
      else if (m.type === 'fatal') this._rej(new Error(t('err_code_load_failed') + ' (' + m.msg + ')'));
      else if (m.type === 'beat') this.lastBeat = Date.now();
      else if (m.type === 'thumb') { const r = this._thumb; this._thumb = null; if (r) r(m.dataUrl); }
      else if (!a) return;
      else if (m.type === 'log') a.h.log(m.text);
      else if (m.type === 'error') { a.running = false; a.h.error(m.line, m.msg); }
      else if (m.type === 'size') a.h.size(m.w, m.h);
      else if (m.type === 'score') a.h.score(m.n);
      else if (m.type === 'started') { a.running = true; this.lastBeat = Date.now(); a.h.started(); }
      else if (m.type === 'noloop') { if (a.running) { a.running = false; a.h.error(0, t('gm_noloop')); } }
    },
    async ensure() {
      if (!this.worker) this.spawn();
      try { await this.ready; } catch (e) { this.kill(); throw e; }
    },
    kill() {
      try { this.worker && this.worker.terminate(); } catch {}
      this.worker = null; this.ready = null;
    },
    async run(code, host, h) {
      this.stop();
      h.log(Runner.worker ? t('gm_starting') : t('gm_loading'), 'reset');
      try { await this.ensure(); } catch (e) { h.error(0, e.message); return false; }
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      host.replaceChildren(cv);
      this.active = { h, host, running: false };
      bindInput(host, cv);
      const off = cv.transferControlToOffscreen();
      this.worker.postMessage({ type: 'run', code, canvas: off }, [off]);
      return true;
    },
    stop() {
      if (this.worker && this.active) this.worker.postMessage({ type: 'stop' });
      const a = this.active;
      this.active = null;
      if (a) { a.running = false; a.h.stopped(); }
    },
    isRunning() { return !!(this.active && this.active.running); },
    snapshot() {
      return new Promise((resolve) => {
        if (!this.isRunning()) return resolve(null);
        this._thumb = resolve;
        this.worker.postMessage({ type: 'snap' });
        setTimeout(() => { if (this._thumb === resolve) { this._thumb = null; resolve(null); } }, 3000);
      });
    },
  };

  function bindInput(host, cv) {
    const toGame = (e) => {
      const r = cv.getBoundingClientRect();
      const ar = cv.width / cv.height;
      let w = r.width, hh = r.height, ox = 0, oy = 0;
      if (r.width / r.height > ar) { w = r.height * ar; ox = (r.width - w) / 2; } else { hh = r.width / ar; oy = (r.height - hh) / 2; }
      return { x: ((e.clientX - r.left - ox) * cv.width) / w, y: ((e.clientY - r.top - oy) * cv.height) / hh };
    };
    const send = (e, down, click) => { const p = toGame(e); if (Runner.worker) Runner.worker.postMessage({ type: 'mouse', x: p.x, y: p.y, down, click }); };
    cv.addEventListener('pointermove', (e) => send(e, e.buttons > 0, false));
    cv.addEventListener('pointerdown', (e) => { host.focus(); send(e, true, true); });
    cv.addEventListener('pointerup', (e) => send(e, false, false));
  }

  // Клавиши идут в игру, пока она запущена и курсор не в поле ввода.
  const KEYNAME = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'space', Enter: 'enter', Escape: 'escape', Shift: 'shift' };
  const MOVE = ['left', 'right', 'up', 'down', 'space'];
  const typing = (el) => el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  function forwardKey(e, down) {
    if (!Runner.isRunning() || typing(e.target)) return;
    const n = KEYNAME[e.key] || e.key.toLowerCase();
    if (MOVE.includes(n)) e.preventDefault();
    if (e.repeat) return;
    Runner.worker.postMessage({ type: 'key', name: n, down });
  }
  window.addEventListener('keydown', (e) => forwardKey(e, true));
  window.addEventListener('keyup', (e) => forwardKey(e, false));
  window.addEventListener('blur', () => { if (Runner.isRunning()) MOVE.forEach((n) => Runner.worker.postMessage({ type: 'key', name: n, down: false })); });
  // Зависшую игру (while True без выхода) останавливаем вместе с потоком.
  setInterval(() => {
    if (Runner.isRunning() && Date.now() - Runner.lastBeat > 5000) {
      const a = Runner.active;
      Runner.active = null;
      Runner.kill();
      if (a) a.h.error(0, t('gm_hang'));
    }
  }, 1000);

  // ---------- экран игры ----------
  function stage(opts = {}) {
    const host = el('div', { class: 'gm-screen', tabindex: '0', 'aria-label': t('gm_screen') }, el('p', { class: 'gm-placeholder' }, t('gm_screen_hint')));
    const con = el('div', { class: 'gm-console', 'aria-live': 'polite' });
    const runBtn = el('button', { type: 'button' }, t('gm_run'));
    const stopBtn = el('button', { type: 'button', class: 'secondary', disabled: true }, t('gm_stop'));
    let mine = null; // обработчики этого экрана, пока игра идёт на нём
    const log = (text, cls) => {
      if (cls === 'reset') { con.replaceChildren(el('div', { class: 'muted' }, text)); return; }
      con.append(el('div', { class: cls || '' }, text));
      while (con.childNodes.length > 200) con.firstChild.remove();
      con.scrollTop = con.scrollHeight;
    };
    const h = {
      log: (text, cls) => log(text, cls),
      started: () => { log(t('gm_running'), 'reset'); stopBtn.disabled = false; host.focus(); if (opts.onStart) opts.onStart(); },
      error: (line, msg) => { log((line ? t('gm_line').replace('{n}', line) + ': ' : '') + msg, 'error'); stopBtn.disabled = true; },
      size: (w, hh) => { host.style.aspectRatio = w + ' / ' + hh; },
      score: (n) => { log(t('gm_score_sent').replace('{n}', n), 'ok'); if (opts.onScore) opts.onScore(n); },
      stopped: () => { stopBtn.disabled = true; },
    };
    async function run(code) {
      mine = h;
      runBtn.disabled = true;
      try { await Runner.run(code, host, h); } finally { runBtn.disabled = false; }
    }
    const isMine = () => Runner.active && Runner.active.h === h;
    function stop() { if (isMine()) Runner.stop(); }
    runBtn.addEventListener('click', () => run(opts.getCode ? opts.getCode() : ''));
    stopBtn.addEventListener('click', stop);
    const node = el('div', { class: 'gm-stage' },
      host,
      el('div', { class: 'row', style: 'margin-top:8px' }, opts.getCode ? runBtn : null, stopBtn,
        el('span', { class: 'muted small' }, t('gm_keys_hint'))),
      el('div', { class: 'muted small', style: 'margin-top:8px' }, t('gm_console')), con);
    return { node, run, stop, snapshot: () => (isMine() ? Runner.snapshot() : Promise.resolve(null)), running: () => isMine() && Runner.isRunning(), log };
  }

  // Заранее скачать Python, пока ученик читает условие.
  function warm() { setTimeout(() => { Runner.ensure().catch(() => {}); }, 800); }

  // ---------- шпаргалка ----------
  const CHEAT = [
    ['Game(width, height, title)', 'gm_cs_game'],
    ['add(entity)  entities  score  state  background  tilemap  width  height  time', 'gm_cs_game_attrs'],
    ['key("left")  pressed("space")  mouse()', 'gm_cs_keys'],
    ['update(dt)  draw_ui(screen)  run()  report_score(points)', 'gm_cs_hooks'],
    ['Entity(x, y, w, h, image="hero")', 'gm_cs_entity'],
    ['update(game, dt)  draw(screen)  collides(other)  kill()  x y w h flip anim image color', 'gm_cs_entity_attrs'],
    ['Animation("hero_walk", fps=8)  .playing  .reset()', 'gm_cs_anim'],
    ['TileMap(rows, tile, legend, solid)  find("P")  replace("P", ".")  blocked(x, y, w, h)', 'gm_cs_map'],
    ['screen.text  rect  circle  line  image(name, x, y, w, h)', 'gm_cs_screen'],
    ['rand(a, b)  randint(a, b)  choice(list)', 'gm_cs_helpers'],
    ['hero  hero_walk  enemy  coin  wall', 'gm_cs_images'],
    ['left right up down space enter a..z', 'gm_cs_keynames'],
  ];
  function cheatSheet(open) {
    return el('details', { class: 'gm-cheat', open: !!open }, el('summary', {}, t('gm_cheat')),
      el('dl', {}, CHEAT.flatMap(([code, key]) => [el('dt', {}, el('code', {}, code)), el('dd', { class: 'muted small' }, t(key))])));
  }

  // ---------- готовые игры и примеры ----------
  const STARTERS = {
    blank: `from engine import *

# 1. Your classes go here. Each thing in your game is a class.
class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")

    def update(self, game, dt):
        pass   # move, animate, react


# 2. The game class holds the rules.
class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360, "My Game")
        self.player = self.add(Player(300, 160))

    def update(self, dt):
        super().update(dt)     # updates every entity

    def draw_ui(self, screen):
        screen.text("Score: " + str(self.score), 10, 10, 20)


MyGame().run()
`,
    loop: `from engine import *

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.box_x = 0                      # where the box is

    def update(self, dt):                   # runs about 60 times per second
        self.box_x += 120 * dt              # 120 pixels per second
        if self.box_x > self.width:
            self.box_x = -40

    def draw_ui(self, screen):              # runs after the map and entities are drawn
        screen.text("Hello, OOP Game Jam!", 20, 20, 24, "white")
        screen.rect(self.box_x, 160, 40, 40, "orange")

MyGame().run()
`,
    player: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")
        self.__speed = 180          # private: only Player code touches it
        self.__lives = 3

    def get_lives(self):            # a getter lets others read it safely
        return self.__lives

    def lose_life(self):
        self.__lives -= 1

    def update(self, game, dt):
        if game.key("left"):
            self.x -= self.__speed * dt
        if game.key("right"):
            self.x += self.__speed * dt
        if game.key("up"):
            self.y -= self.__speed * dt
        if game.key("down"):
            self.y += self.__speed * dt
        # stay inside the window
        self.x = max(0, min(self.x, game.width - self.w))
        self.y = max(0, min(self.y, game.height - self.h))

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(300, 160))

    def draw_ui(self, screen):
        screen.text("Lives: " + str(self.player.get_lives()), 10, 10, 20)
        screen.text("Move with the arrow keys", 10, 336, 14, "#9db4d6")

MyGame().run()
`,
    sprite: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 64, 64)
        self.anim = Animation("hero_walk", fps=8)   # a sprite sheet with 4 frames
        self.__speed = 160

    def update(self, game, dt):
        moving = False
        if game.key("left"):
            self.x -= self.__speed * dt
            self.flip = True                         # face left
            moving = True
        if game.key("right"):
            self.x += self.__speed * dt
            self.flip = False
            moving = True
        self.anim.playing = moving                   # animate only while moving
        if not moving:
            self.anim.reset()

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(280, 250))

    def draw_ui(self, screen):
        screen.text("Left / Right: walk", 10, 10, 18)

MyGame().run()
`,
    map: `from engine import *

LEVEL = [
    "####################",
    "#P.................#",
    "#..####....####....#",
    "#..#..........#..C.#",
    "#..#...####...#....#",
    "#......#..#........#",
    "#..#...####...#....#",
    "#..#..........#..C.#",
    "#..####....####....#",
    "#.C................#",
    "####################",
]

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 28, 28, image="hero")
        self.__speed = 140

    def update(self, game, dt):
        dx = (game.key("right") - game.key("left")) * self.__speed * dt
        dy = (game.key("down") - game.key("up")) * self.__speed * dt
        if not game.tilemap.blocked(self.x + dx, self.y, self.w, self.h):
            self.x += dx                  # walls stop us on each axis separately
        if not game.tilemap.blocked(self.x, self.y + dy, self.w, self.h):
            self.y += dy

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 352)
        self.tilemap = TileMap(LEVEL, tile=32, legend={"#": "wall"}, solid="#")
        px, py = self.tilemap.find("P")[0]    # spawn point from the map
        self.tilemap.replace("P", ".")
        self.player = self.add(Player(px + 2, py + 2))

MyGame().run()
`,
    inherit: `from engine import *

class Item(Entity):                       # PARENT class
    def __init__(self, x, y, image):
        super().__init__(x, y, 32, 32, image=image)

    def on_touch(self, game):             # children override this
        pass

class Coin(Item):                         # CHILD class
    def __init__(self, x, y):
        super().__init__(x, y, "coin")

    def on_touch(self, game):
        game.score += 10
        self.kill()

class Bomb(Item):                         # another CHILD, same method, other behaviour
    def __init__(self, x, y):
        super().__init__(x, y, "enemy")

    def on_touch(self, game):
        game.score -= 20
        self.kill()

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")

    def update(self, game, dt):
        self.x += (game.key("right") - game.key("left")) * 200 * dt
        self.y += (game.key("down") - game.key("up")) * 200 * dt
        for e in game.entities:
            if isinstance(e, Item) and self.collides(e):
                e.on_touch(game)          # POLYMORPHISM: each Item reacts its own way

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(300, 160))
        for i in range(6):
            self.add(Coin(rand(20, 600), rand(20, 320)))
            self.add(Bomb(rand(20, 600), rand(20, 320)))

    def draw_ui(self, screen):
        screen.text("Score: " + str(self.score), 10, 10, 20)

MyGame().run()
`,
    coins: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")
        self.__speed = 200
        self.__lives = 3
        self.__hurt_timer = 0.0

    def get_lives(self):
        return self.__lives

    def hurt(self):
        if self.__hurt_timer <= 0:          # short protection after a hit
            self.__lives -= 1
            self.__hurt_timer = 1.0

    def update(self, game, dt):
        self.__hurt_timer -= dt
        self.x += (game.key("right") - game.key("left")) * self.__speed * dt
        self.y += (game.key("down") - game.key("up")) * self.__speed * dt
        self.x = max(0, min(self.x, game.width - self.w))
        self.y = max(0, min(self.y, game.height - self.h))

class Coin(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 28, 28, image="coin")

class Slime(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="enemy")
        self.__vx = choice([-90, 90])
        self.__vy = choice([-70, 70])

    def update(self, game, dt):
        self.x += self.__vx * dt
        self.y += self.__vy * dt
        if self.x < 0 or self.x > game.width - self.w:
            self.__vx = -self.__vx
        if self.y < 0 or self.y > game.height - self.h:
            self.__vy = -self.__vy

class CoinGame(Game):
    def __init__(self):
        super().__init__(640, 360, "Coin Collector")
        self.start()

    def start(self):
        self.entities = []
        self.score = 0
        self.state = "play"
        self.player = self.add(Player(300, 160))
        for i in range(8):
            self.add(Coin(rand(20, 590), rand(40, 320)))
        for i in range(3):
            self.add(Slime(rand(20, 590), rand(40, 320)))

    def update(self, dt):
        if self.state != "play":
            if self.pressed("enter"):
                self.start()
            return
        super().update(dt)
        for e in self.entities:
            if isinstance(e, Coin) and self.player.collides(e):
                e.kill()
                self.score += 10
            if isinstance(e, Slime) and self.player.collides(e):
                self.player.hurt()
        if self.player.get_lives() <= 0:
            self.state = "lose"
            self.report_score(self.score)
        elif self.score >= 80:
            self.state = "win"
            self.report_score(self.score + self.player.get_lives() * 20)

    def draw_ui(self, screen):
        screen.text("Score: " + str(self.score), 10, 10, 20)
        screen.text("Lives: " + str(self.player.get_lives()), 540, 10, 20)
        if self.state == "win":
            screen.text("YOU WIN!  Enter = play again", 320, 160, 26, "#ffd166", "center")
        if self.state == "lose":
            screen.text("GAME OVER  Enter = play again", 320, 160, 26, "#ff4d6d", "center")

CoinGame().run()
`,
    dodger: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 36, 36, image="hero")

    def update(self, game, dt):
        self.x += (game.key("right") - game.key("left")) * 280 * dt
        self.x = max(0, min(self.x, game.width - self.w))

class Rock(Entity):
    def __init__(self, x, speed):
        super().__init__(x, -40, 32, 32, image="enemy")
        self.__speed = speed

    def update(self, game, dt):
        self.y += self.__speed * dt
        if self.y > game.height:
            self.kill()
            game.dodged += 1

class DodgeGame(Game):
    def __init__(self):
        super().__init__(640, 360, "Dodger")
        self.start()

    def start(self):
        self.entities = []
        self.state = "play"
        self.dodged = 0
        self.timer = 0.0
        self.player = self.add(Player(300, 310))

    def update(self, dt):
        if self.state != "play":
            if self.pressed("enter"):
                self.start()
            return
        super().update(dt)
        self.timer -= dt
        if self.timer <= 0:                       # spawn a new rock
            self.add(Rock(rand(0, 600), rand(120, 120 + self.dodged * 6)))
            self.timer = max(0.25, 0.9 - self.dodged * 0.02)
        for e in self.entities:
            if isinstance(e, Rock) and self.player.collides(e):
                self.state = "lose"
                self.report_score(self.dodged)

    def draw_ui(self, screen):
        screen.text("Dodged: " + str(self.dodged), 10, 10, 20)
        if self.state == "lose":
            screen.text("CRASH!  Enter = try again", 320, 150, 26, "#ff4d6d", "center")

DodgeGame().run()
`,
    maze: `from engine import *

LEVEL = [
    "####################",
    "#P...#.........#...#",
    "#.##.#.#######.#.#.#",
    "#.#C...#.....#...#.#",
    "#.#.####.###.#####.#",
    "#.#......#C#.......#",
    "#.######.#.#######.#",
    "#...C....#.....#...#",
    "###.######.###.#.#.#",
    "#C.......E...#...#C#",
    "####################",
]

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 26, 26, image="hero")
        self.__speed = 130

    def update(self, game, dt):
        dx = (game.key("right") - game.key("left")) * self.__speed * dt
        dy = (game.key("down") - game.key("up")) * self.__speed * dt
        if not game.tilemap.blocked(self.x + dx, self.y, self.w, self.h):
            self.x += dx
        if not game.tilemap.blocked(self.x, self.y + dy, self.w, self.h):
            self.y += dy

class Coin(Entity):
    def __init__(self, x, y):
        super().__init__(x + 4, y + 4, 24, 24, image="coin")

class MazeGame(Game):
    def __init__(self):
        super().__init__(640, 352, "Maze")
        self.start()

    def start(self):
        self.entities = []
        self.state = "play"
        self.score = 0
        self.tilemap = TileMap(LEVEL, 32, {"#": "wall", "E": "#2ec4b6"}, "#")
        px, py = self.tilemap.find("P")[0]
        self.exit = self.tilemap.find("E")[0]
        self.tilemap.replace("P", ".")
        self.player = self.add(Player(px + 3, py + 3))
        for (cx, cy) in self.tilemap.find("C"):
            self.add(Coin(cx, cy))
        self.tilemap.replace("C", ".")

    def update(self, dt):
        if self.state != "play":
            if self.pressed("enter"):
                self.start()
            return
        super().update(dt)
        for e in self.entities:
            if isinstance(e, Coin) and self.player.collides(e):
                e.kill()
                self.score += 1
        coins_left = len(self.entities) - 1
        ex, ey = self.exit
        at_exit = abs(self.player.x - ex) < 20 and abs(self.player.y - ey) < 20
        if coins_left == 0 and at_exit:
            self.state = "win"
            self.report_score(max(10, 100 - int(self.time)))

    def draw_ui(self, screen):
        screen.text("Coins: " + str(self.score) + "   Time: " + str(int(self.time)), 8, 4, 16, "#ffd166")
        if self.state == "win":
            screen.text("YOU ESCAPED!  Enter = again", 320, 160, 26, "#2ec4b6", "center")

MazeGame().run()
`,
  };
  // Каркасы для урока Game Jam: почти без готового кода, только подсказки TODO (код и комментарии — на английском, как в OOP Game Jam).
  // Полные примеры остаются в STARTERS (учитель может подставить их сам).
  const TASKS = {
    loop: `from engine import *

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        # TODO: add an attribute: the x position of the box

    def update(self, dt):
        # TODO: move the box right at 120 pixels per second (speed * dt)
        # TODO: make the box bounce back at the window edges
        pass

    def draw_ui(self, screen):
        # TODO: write a greeting: screen.text(...)
        # TODO: draw a 40×40 box: screen.rect(...)
        pass

MyGame().run()
`,
    player: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")
        # TODO: private attributes: speed and lives (self.__...)

    # TODO: a get_lives() method

    def update(self, game, dt):
        # TODO: move with the arrow keys (game.key("left") ...), speed * dt
        # TODO: the player cannot leave the window
        pass

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(300, 160))

    def draw_ui(self, screen):
        # TODO: show the player's lives using get_lives()
        pass

MyGame().run()
`,
    sprite: `from engine import *

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 64, 64)
        # TODO: self.anim = Animation(...) using the "hero_walk" sheet
        # TODO: a private speed

    def update(self, game, dt):
        # TODO: walk left / right; self.flip = True when walking left
        # TODO: the animation plays only while moving
        pass

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(280, 250))

MyGame().run()
`,
    map: `from engine import *

# TODO: draw your own level: # wall, . floor, P start, C coin
LEVEL = [
    "####################",
    "#P.................#",
    "#..................#",
    "#..................#",
    "####################",
]

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 28, 28, image="hero")

    def update(self, game, dt):
        # TODO: movement; no walking through walls (game.tilemap.blocked(...)), check x and y separately
        pass

# TODO: a Coin class

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 352)
        self.tilemap = TileMap(LEVEL, tile=32, legend={"#": "wall"}, solid="#")
        # TODO: find P on the map (find) and put the player there
        # TODO: put coins on the C tiles

MyGame().run()
`,
    inherit: `from engine import *

class Item(Entity):
    # TODO: __init__(self, x, y, image) and a method on_touch(self, game)
    pass

# TODO: class Coin(Item): +10 points
# TODO: class Bomb(Item): -20 points
# TODO: one more item of your own

class Player(Entity):
    def __init__(self, x, y):
        super().__init__(x, y, 32, 32, image="hero")

    def update(self, game, dt):
        # TODO: movement
        # TODO: when touching any Item, call its on_touch(game)
        pass

class MyGame(Game):
    def __init__(self):
        super().__init__(640, 360)
        self.player = self.add(Player(300, 160))
        # TODO: scatter items around (rand)

    def draw_ui(self, screen):
        screen.text("Score: " + str(self.score), 10, 10, 20)

MyGame().run()
`,
  };
  const STARTER_ORDER = ['blank', 'coins', 'dodger', 'maze', 'loop', 'player', 'sprite', 'map', 'inherit'];
  const starterName = (k) => t('gm_starter_' + k);
  function starterSelect(onPick) {
    const sel = el('select', { style: 'width:auto;margin:0' },
      el('option', { value: '' }, t('gm_starter_pick')),
      STARTER_ORDER.map((k) => el('option', { value: k }, starterName(k))),
      el('optgroup', { label: t('gm_tasks_group') }, Object.keys(TASKS).map((k) => el('option', { value: 'task:' + k }, starterName(k) + ' — ' + t('gm_task_suffix')))));
    sel.addEventListener('change', () => { const k = sel.value; sel.value = ''; if (k) onPick(k, k.startsWith('task:') ? TASKS[k.slice(5)] : STARTERS[k]); });
    return sel;
  }

  // ---------- готовый урок: 5 коротких шагов и своя игра ----------
  function jamLesson() {
    // Заготовки — каркасы с TODO: ученик пишет код сам. Урок всегда на английском (так попросила владелица),
    // на каком бы языке ни был сайт у учителя.
    const en = (k) => (I18N.en && I18N.en[k]) || t(k);
    const step = (n, starter, require) => ({
      kind: 'game', lang: 'python', title: en('gm_jam_' + n + '_title'), text: en('gm_jam_' + n + '_text'),
      starter, tests: [], game: { require, gallery: n === 6 },
    });
    return [step(1, TASKS.loop, []), step(2, TASKS.player, ['enc']), step(3, TASKS.sprite, []), step(4, TASKS.map, ['classes']),
      step(5, TASKS.inherit, ['parent', 'poly']), step(6, STARTERS.blank, ['classes', 'enc', 'parent', 'poly', 'static'])];
  }

  return { BADGES, analyze, badgesView, stage, warm, cheatSheet, STARTERS, TASKS, STARTER_ORDER, starterName, starterSelect, jamLesson, Runner };
})();
