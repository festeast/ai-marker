# Игровой движок для заданий «Игра (ООП)» в классной работе (идея и движок — OOP Game Jam).
# Работает в Pyodide внутри game-worker.js. Ученик пишет: from engine import *
"""OOP Game Jam engine.  Read it: it is a few classes, just like your game."""
import sys
import math
import random
import js
from pyodide.ffi import create_proxy

window = js.globalThis
_current = None

__all__ = ["Game", "Entity", "Animation", "TileMap", "Screen", "rand", "randint", "choice", "math", "random"]


def rand(a, b):
    """Random decimal number between a and b."""
    return random.uniform(a, b)


def randint(a, b):
    """Random whole number between a and b (both included)."""
    return random.randint(a, b)


def choice(items):
    """Random item from a list."""
    return random.choice(items)


def _asset(name):
    if not name:
        return None
    return window.getAsset(name)


class Screen:
    """Everything you can draw. The Game gives you one in draw_ui(screen)."""

    def __init__(self, ctx, width, height):
        self.ctx = ctx
        self.width = width
        self.height = height

    def clear(self, color="#0b1020"):
        self.ctx.fillStyle = color
        self.ctx.fillRect(0, 0, self.width, self.height)

    def rect(self, x, y, w, h, color="white"):
        self.ctx.fillStyle = color
        self.ctx.fillRect(x, y, w, h)

    def circle(self, x, y, r, color="white"):
        self.ctx.fillStyle = color
        self.ctx.beginPath()
        self.ctx.arc(x, y, r, 0, 6.2832)
        self.ctx.fill()

    def line(self, x1, y1, x2, y2, color="white", width=2):
        self.ctx.strokeStyle = color
        self.ctx.lineWidth = width
        self.ctx.beginPath()
        self.ctx.moveTo(x1, y1)
        self.ctx.lineTo(x2, y2)
        self.ctx.stroke()

    def text(self, text, x, y, size=18, color="white", align="left"):
        self.ctx.fillStyle = color
        self.ctx.font = "bold " + str(size) + "px monospace"
        self.ctx.textAlign = align
        self.ctx.textBaseline = "top"
        self.ctx.fillText(str(text), x, y)

    def image(self, name, x, y, w=None, h=None, flip=False, frame=0):
        """Draw an image (or one frame of a sprite sheet) by its asset name."""
        a = _asset(name)
        if a is None:
            # unknown name: draw a pink box so you notice
            self.rect(x, y, w or 32, h or 32, "#ff2bd6")
            return
        fw = int(a.fw)
        fh = int(a.fh)
        cols = max(1, int(a.cols))
        frame = int(frame) % max(1, int(a.frames))
        sx = (frame % cols) * fw
        sy = (frame // cols) * fh
        if w is None:
            w = fw
        if h is None:
            h = fh
        ctx = self.ctx
        if flip:
            ctx.save()
            ctx.translate(x + w, y)
            ctx.scale(-1, 1)
            ctx.drawImage(a.img, sx, sy, fw, fh, 0, 0, w, h)
            ctx.restore()
        else:
            ctx.drawImage(a.img, sx, sy, fw, fh, x, y, w, h)


class Animation:
    """Plays the frames of a sprite sheet. Animation("hero_walk", fps=8)."""

    def __init__(self, name, fps=8, frames=None):
        self.name = name
        self.fps = fps
        a = _asset(name)
        total = int(a.frames) if a is not None else 1
        self.frames = list(frames) if frames is not None else list(range(total))
        self.time = 0.0
        self.index = 0
        self.playing = True

    def update(self, dt):
        if self.playing and len(self.frames) > 1:
            self.time += dt
            self.index = int(self.time * self.fps) % len(self.frames)

    def reset(self):
        self.time = 0.0
        self.index = 0

    def draw(self, screen, x, y, w, h, flip=False):
        screen.image(self.name, x, y, w, h, flip=flip, frame=self.frames[self.index])


class Entity:
    """Anything that lives in the game: player, enemy, coin... Make your own by inheriting."""

    def __init__(self, x, y, w=32, h=32, image=None, color="#4cc9f0"):
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.image = image
        self.color = color
        self.flip = False
        self.anim = None
        self.alive = True

    def update(self, game, dt):
        pass

    def draw(self, screen):
        if self.anim is not None:
            self.anim.draw(screen, self.x, self.y, self.w, self.h, self.flip)
        elif self.image:
            screen.image(self.image, self.x, self.y, self.w, self.h, self.flip)
        else:
            screen.rect(self.x, self.y, self.w, self.h, self.color)

    def collides(self, other):
        return (self.x < other.x + other.w and self.x + self.w > other.x and
                self.y < other.y + other.h and self.y + self.h > other.y)

    def center(self):
        return (self.x + self.w / 2, self.y + self.h / 2)

    def kill(self):
        self.alive = False


class TileMap:
    """A level drawn with text. Each character is one tile."""

    def __init__(self, rows, tile=32, legend=None, solid="#"):
        if isinstance(rows, str):
            rows = rows.strip("\n").splitlines()
        self.rows = []
        for r in rows:
            r = r.rstrip("\r")
            if "," in r:
                self.rows.append([c.strip() for c in r.split(",")])
            else:
                self.rows.append(list(r))
        self.tile = tile
        self.legend = legend if legend is not None else {"#": "wall"}
        self.solid = set(solid) if isinstance(solid, (str, list, tuple, set)) else set()
        self.rows_count = len(self.rows)
        self.cols_count = max([len(r) for r in self.rows] + [0])
        self.pixel_width = self.cols_count * tile
        self.pixel_height = self.rows_count * tile

    @staticmethod
    def from_asset(name, tile=32, legend=None, solid="#"):
        text = window.getAssetText(name)
        if text is None:
            raise ValueError("Нет карты с именем '" + name + "'. Используйте TileMap([...строки...]) прямо в коде.")
        return TileMap(str(text), tile, legend, solid)

    def char_at(self, px, py):
        c = int(px // self.tile)
        r = int(py // self.tile)
        if r < 0 or r >= self.rows_count or c < 0 or c >= len(self.rows[r]):
            return None
        return self.rows[r][c]

    def is_solid(self, px, py):
        ch = self.char_at(px, py)
        return ch is None or ch in self.solid

    def blocked(self, x, y, w, h):
        """True if the rectangle touches a solid tile."""
        return (self.is_solid(x, y) or self.is_solid(x + w - 1, y) or
                self.is_solid(x, y + h - 1) or self.is_solid(x + w - 1, y + h - 1))

    def find(self, ch):
        """Top-left pixel (x, y) of every tile that has this character."""
        out = []
        for r, row in enumerate(self.rows):
            for c, cell in enumerate(row):
                if cell == ch:
                    out.append((c * self.tile, r * self.tile))
        return out

    def replace(self, ch, new=" "):
        for row in self.rows:
            for c in range(len(row)):
                if row[c] == ch:
                    row[c] = new

    def draw(self, screen):
        t = self.tile
        for r, row in enumerate(self.rows):
            for c, cell in enumerate(row):
                what = self.legend.get(cell)
                if what is None:
                    continue
                if _asset(what) is not None:
                    screen.image(what, c * t, r * t, t, t)
                else:
                    screen.rect(c * t, r * t, t, t, what)


class Game:
    """The window and the loop. Inherit from it:  class MyGame(Game)."""

    def __init__(self, width=640, height=360, title="My Game"):
        global _current
        stop_all()
        canvas = window.GAME_CANVAS
        canvas.width = width
        canvas.height = height
        ctx = canvas.getContext("2d")
        ctx.imageSmoothingEnabled = False
        self.width = width
        self.height = height
        self.title = title
        self.screen = Screen(ctx, width, height)
        self.entities = []
        self.tilemap = None
        self.background = "#0b1020"
        self.score = 0
        self.time = 0.0
        self.state = "play"
        self._running = False
        self._last = None
        self._raf = None
        self._proxy = None
        self._in_frame = False
        _current = self
        window.onGameSize(width, height)

    # ----- things you can use -----
    def add(self, entity):
        self.entities.append(entity)
        return entity

    def key(self, name):
        """Is this key held down right now?  "left" "right" "up" "down" "space" "a".."z" """
        return bool(window.keyDown(name))

    def pressed(self, name):
        """Was this key pressed just now (once per press)?"""
        return bool(window.keyPressed(name))

    def mouse(self):
        """(x, y, clicked) of the mouse in game pixels."""
        m = window.MOUSE
        return (m.x, m.y, bool(m.clicked))

    def report_score(self, points):
        """Send your points to the Arena leaderboard."""
        window.onGameScore(points)

    # ----- hooks you can override -----
    def update(self, dt):
        if self.state != "play":
            return
        self.time += dt
        for e in list(self.entities):
            if e.anim is not None:
                e.anim.update(dt)
            e.update(self, dt)
        self.entities = [e for e in self.entities if e.alive]

    def draw(self):
        s = self.screen
        s.clear(self.background)
        if self.tilemap is not None:
            self.tilemap.draw(s)
        for e in self.entities:
            e.draw(s)
        self.draw_ui(s)

    def draw_ui(self, screen):
        pass

    # ----- the loop -----
    def run(self):
        self._running = True
        self._proxy = create_proxy(self._frame)
        self._raf = window.requestAnimationFrame(self._proxy)

    def stop(self):
        self._running = False
        try:
            if self._raf is not None:
                window.cancelAnimationFrame(self._raf)
        except Exception:
            pass
        self._raf = None
        if self._proxy is not None and not self._in_frame:
            try:
                self._proxy.destroy()
            except Exception:
                pass
            self._proxy = None

    def _frame(self, ts):
        if not self._running:
            return
        self._in_frame = True
        try:
            if self._last is None:
                dt = 0.016
            else:
                dt = min((ts - self._last) / 1000.0, 0.05)
            self._last = ts
            self.update(dt)
            self.draw()
            window.endFrame()
        except BaseException:
            self._running = False
            line, msg = _describe_error()
            window.gameError(line, msg)
            return
        finally:
            self._in_frame = False
        if self._running:
            self._raf = window.requestAnimationFrame(self._proxy)


def stop_all():
    global _current
    if _current is not None:
        _current.stop()
        _current = None


def _describe_error():
    et, ev, tb = sys.exc_info()
    line = 0
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "game.py":
            line = tb.tb_lineno
        tb = tb.tb_next
    return line, str(et.__name__) + ": " + str(ev)


def run_user_code(code):
    stop_all()
    ns = {"__name__": "__main__"}
    try:
        exec(compile(code, "game.py", "exec"), ns)
    except SyntaxError as e:
        window.gameError(e.lineno or 0, "SyntaxError: " + str(e.msg))
    except BaseException:
        line, msg = _describe_error()
        window.gameError(line, msg)
