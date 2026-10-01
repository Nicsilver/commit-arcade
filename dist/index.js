// src/rng.ts
function createRng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// src/grid.ts
function allCells(grid) {
  return grid.cells.flat().filter((c) => c !== null);
}
function activeCells(grid) {
  return allCells(grid).filter((c) => c.level > 0);
}
var LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4
};
async function fetchGrid(login, token) {
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { contributionCount contributionLevel date weekday } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "commit-arcade"
    },
    body: JSON.stringify({ query, variables: { login } })
  });
  if (!res.ok) {
    throw new Error(`GitHub API answered ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const user = json.data?.user;
  if (!user) throw new Error(`No GitHub user called "${login}"`);
  const weeks = user.contributionsCollection.contributionCalendar.weeks;
  const cells = weeks.map((week, x) => {
    const column = Array(7).fill(null);
    for (const day of week.contributionDays) {
      column[day.weekday] = {
        x,
        y: day.weekday,
        level: LEVELS[day.contributionLevel] ?? 0,
        count: day.contributionCount,
        date: day.date
      };
    }
    return column;
  });
  return { width: cells.length, height: 7, cells };
}

// src/outputs.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// src/anim.ts
var Timeline = class {
  duration;
  rules = [];
  count = 0;
  prefix;
  constructor(duration, prefix = "k") {
    if (!(duration > 0)) throw new Error("Timeline duration must be positive");
    this.duration = duration;
    this.prefix = prefix;
  }
  /**
   * Registers an animation and returns a class name to put on the element.
   * Two frames at the same time make an instant jump, e.g. teleporting or
   * switching sprites.
   */
  track(frames2, timing = "linear") {
    const name = this.keyframes(frames2);
    return this.useKeyframes(name, 0, timing);
  }
  /** Registers bare @keyframes so several elements can share them with different delays. */
  keyframes(frames2) {
    const name = `${this.prefix}${this.count++}`;
    this.rules.push(`@keyframes ${name}{${this.body(frames2)}}`);
    return name;
  }
  /**
   * Plays existing keyframes `lag` seconds behind the loop clock. Implemented
   * as a negative delay so the element is animated from the very first frame
   * instead of sitting still while it waits.
   */
  useKeyframes(name, lag, timing = "linear") {
    const cls = `${this.prefix}${this.count++}`;
    const shift = (lag % this.duration + this.duration) % this.duration;
    const delay = shift === 0 ? "" : ` -${fmt(this.duration - shift)}s`;
    this.rules.push(`.${cls}{animation:${name} ${fmt(this.duration)}s ${timing}${delay} infinite}`);
    return cls;
  }
  /** Visible only between `from` and `to` seconds (with an optional fade). */
  visible(from, to, fade = 0) {
    return this.track(visibilityFrames(from, to, fade));
  }
  /** Visible at the start, gone from `at` until `back`, where it fades in again. */
  hiddenBetween(at, back, fade = 0) {
    return this.track([
      [0, "opacity:1"],
      [at, "opacity:1"],
      [at + Math.max(fade, 1e-3), "opacity:0"],
      [back, "opacity:0"],
      [back + Math.max(fade, 1e-3), "opacity:1"]
    ]);
  }
  css() {
    return this.rules.join("\n");
  }
  body(frames2) {
    if (frames2.length === 0) throw new Error("A track needs at least one frame");
    const sorted = frames2.map(([t, css], i) => ({ t: Math.round(Math.min(Math.max(t, 0), this.duration) * 1e5) / 1e5, css, i })).sort((a, b) => a.t - b.t || a.i - b.i);
    if (sorted[0].t > 0) sorted.unshift({ t: 0, css: sorted[0].css, i: -1 });
    const last = sorted[sorted.length - 1];
    if (last.t < this.duration) sorted.push({ t: this.duration, css: last.css, i: Infinity });
    const kept = sorted.filter(
      (f, i) => i === 0 || i === sorted.length - 1 || !(sorted[i - 1].css === f.css && sorted[i + 1].css === f.css)
    );
    const out = [];
    let prev = -1;
    for (const f of kept) {
      let pct = Math.round(f.t / this.duration * 1e6) / 1e4;
      if (pct <= prev) pct = Math.round((prev + 1e-4) * 1e4) / 1e4;
      if (pct > 100) pct = 100;
      out.push(`${pct}%{${f.css}}`);
      prev = pct;
    }
    return out.join("");
  }
};
function visibilityFrames(from, to, fade = 0) {
  const f = Math.max(fade, 1e-3);
  return [
    [0, "opacity:0"],
    [from, "opacity:0"],
    [from + f, "opacity:1"],
    [to, "opacity:1"],
    [to + f, "opacity:0"]
  ];
}
function translate(x, y, extra = "") {
  return `transform:translate(${fmt(x)}px,${fmt(y)}px)${extra ? " " + extra : ""}`;
}
function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

// src/game.ts
var PACE = {
  intro: 1,
  hold: 1.2,
  restore: 0.6,
  rest: 0.4
};
function loopDuration(play) {
  return PACE.intro + play + PACE.hold + PACE.restore + PACE.rest;
}
function restoreAt(play) {
  return PACE.intro + play + PACE.hold;
}

// src/pixel-font.ts
var GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};
function pixelText(text, scale = 2) {
  const chars = [...text.toUpperCase()];
  const parts = [];
  chars.forEach((ch, i) => {
    const rows = GLYPHS[ch];
    if (!rows) throw new Error(`No pixel glyph for "${ch}"`);
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== "1") {
          x++;
          continue;
        }
        let end = x;
        while (end < row.length && row[end] === "1") end++;
        parts.push(`M${fmt((i * 6 + x) * scale)} ${fmt(y * scale)}h${fmt((end - x) * scale)}v${fmt(scale)}h${fmt(-(end - x) * scale)}z`);
        x = end;
      }
    });
  });
  return { d: parts.join(""), width: Math.max(0, chars.length * 6 - 1) * scale, height: 7 * scale };
}
function bitmapPath(rows, scale = 1, ox = 0, oy = 0) {
  const open = /* @__PURE__ */ new Map();
  const done = [];
  rows.forEach((row, y) => {
    const seen = /* @__PURE__ */ new Set();
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === "#") end++;
      const key = `${x}:${end}`;
      seen.add(key);
      const prev = open.get(key);
      if (prev && prev.y + prev.h === y) prev.h++;
      else open.set(key, { x, end, y, h: 1 });
      x = end;
    }
    for (const [key, run2] of open) {
      if (!seen.has(key)) {
        done.push(run2);
        open.delete(key);
      }
    }
  });
  done.push(...open.values());
  return done.map((r) => `M${fmt(ox + r.x * scale)} ${fmt(oy + r.y * scale)}h${fmt((r.end - r.x) * scale)}v${fmt(r.h * scale)}h${fmt(-(r.end - r.x) * scale)}z`).join("");
}

// src/svg.ts
function makeLayout(grid, opts = {}) {
  const cell = opts.cell ?? 12;
  const gap = opts.gap ?? 4;
  const pitch = cell + gap;
  return {
    cell,
    gap,
    pitch,
    radius: Math.round(cell / 5),
    left: opts.left ?? 16,
    top: opts.top ?? 16,
    gridWidth: grid.width * pitch - gap,
    gridHeight: grid.height * pitch - gap
  };
}
function cellOrigin(layout, x, y) {
  return [layout.left + x * layout.pitch, layout.top + y * layout.pitch];
}
function cellCenter(layout, x, y) {
  const [ox, oy] = cellOrigin(layout, x, y);
  return [ox + layout.cell / 2, oy + layout.cell / 2];
}
function levelColor(theme, cell) {
  if (!cell || cell.level === 0) return theme.empty;
  return theme.levels[cell.level - 1];
}
function cellRect(layout, cell, fill, attrs = "") {
  const [x, y] = cellOrigin(layout, cell.x, cell.y);
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${layout.cell}" height="${layout.cell}" rx="${layout.radius}" fill="${fill}"${attrs ? " " + attrs : ""}/>`;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function svgDocument(p) {
  const bg = p.background ? `<rect width="100%" height="100%" fill="${p.background}"/>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(p.width)} ${fmt(p.height)}" width="${fmt(p.width)}" height="${fmt(p.height)}" role="img" aria-label="${esc(p.title)}">`,
    `<title>${esc(p.title)}</title>`,
    `<style>${p.css}</style>`,
    p.defs ? `<defs>${p.defs}</defs>` : "",
    bg,
    p.body,
    `</svg>`
  ].filter(Boolean).join("\n");
}

// src/kit.ts
var CANVAS = {
  width: 896,
  height: 216,
  /** Top of the graph; above it is the HUD and a one-cell lane. */
  gridTop: 48,
  hudY: 10
};
function arcadeLayout(grid) {
  const probe = makeLayout(grid);
  const width = Math.max(CANVAS.width, probe.gridWidth + 52);
  const layout = makeLayout(grid, { left: Math.round((width - probe.gridWidth) / 2), top: CANVAS.gridTop });
  return { ...layout, width, height: CANVAS.height };
}
function spriteColor(theme, cell) {
  return theme.sprites[Math.max(1, cell.level) - 1];
}
var GLOW_ID = "glow";
function glowDefs(theme) {
  if (theme.glow <= 0) return "";
  return `<filter id="${GLOW_ID}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${fmt(theme.glow)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
}
function glowAttr(theme) {
  return theme.glow > 0 ? ` filter="url(#${GLOW_ID})"` : "";
}
var DIGITS = 6;
var HUD_SCALE = 2;
function hud(tl, grid, opts) {
  const { theme, width } = opts;
  const total = activeCells(grid).reduce((sum, c) => sum + c.count, 0);
  const y = CANVAS.hudY;
  const out = [];
  const label = (text, x, fill) => {
    const p = pixelText(text, HUD_SCALE);
    out.push(`<path d="${p.d}" transform="translate(${fmt(x)} ${y})" fill="${fill}"/>`);
    return p.width;
  };
  const left = 26;
  const scoreX = left + label("SCORE", left, theme.muted) + 10;
  out.push(scoreDigits(tl, opts, scoreX, y, theme.ink));
  const title = pixelText(opts.title, HUD_SCALE);
  out.push(`<path d="${title.d}" transform="translate(${fmt((width - title.width) / 2)} ${y})" fill="${theme.accent}"${glowAttr(theme)}/>`);
  const hi = pad(total);
  const hiText = pixelText(hi, HUD_SCALE);
  const hiX = width - 26 - hiText.width;
  out.push(`<path d="${hiText.d}" transform="translate(${fmt(hiX)} ${y})" fill="${theme.ink}"/>`);
  label("HI", hiX - 10 - pixelText("HI", HUD_SCALE).width, theme.muted);
  return `<g class="hud">${out.join("")}</g>`;
}
function pad(n) {
  return String(Math.min(n, 10 ** DIGITS - 1)).padStart(DIGITS, "0");
}
function scoreDigits(tl, opts, x, y, fill) {
  const steps = [{ t: 0, value: 0 }];
  let running = 0;
  for (const e of [...opts.clears].sort((a, b) => a.t - b.t)) {
    running += e.cell.count;
    steps.push({ t: e.t, value: running });
  }
  steps.push({ t: opts.resetAt, value: 0 });
  const advance = 6 * HUD_SCALE;
  const out = [];
  for (let pos = 0; pos < DIGITS; pos++) {
    const shown = steps.map((s) => ({ t: s.t, d: pad(s.value)[pos] }));
    const runs = [];
    for (const s of shown) {
      if (runs.length && runs[runs.length - 1].t === s.t) runs[runs.length - 1] = s;
      else if (!runs.length || runs[runs.length - 1].d !== s.d) runs.push(s);
    }
    for (const digit of new Set(runs.map((r) => r.d))) {
      const glyph = pixelText(digit, HUD_SCALE);
      const transform = `translate(${fmt(x + pos * advance)} ${y})`;
      if (runs.length === 1) {
        out.push(`<path d="${glyph.d}" transform="${transform}" fill="${fill}"/>`);
        continue;
      }
      const frames2 = [];
      runs.forEach((r, i) => {
        const on = r.d === digit ? "opacity:1" : "opacity:0";
        if (i > 0) frames2.push([r.t, runs[i - 1].d === digit ? "opacity:1" : "opacity:0"]);
        frames2.push([r.t, on]);
      });
      out.push(`<path class="${tl.track(frames2)}" d="${glyph.d}" transform="${transform}" fill="${fill}"/>`);
    }
  }
  return out.join("");
}
function banner(tl, opts) {
  const { theme } = opts;
  const texts = opts.lines.map((line, i) => pixelText(line, i === 0 ? 4 : 2));
  const gap = 8;
  const innerH = texts.reduce((h2, p) => h2 + p.height, 0) + gap * (texts.length - 1);
  const innerW = Math.max(...texts.map((p) => p.width));
  const w = innerW + 40;
  const h = innerH + 28;
  const x = opts.cx - w / 2;
  const y = opts.cy - h / 2;
  const f = opts.from;
  const blink = tl.track([
    [0, "opacity:0"],
    [f, "opacity:0"],
    [f, "opacity:1"],
    [f + 0.18, "opacity:1"],
    [f + 0.18, "opacity:0"],
    [f + 0.3, "opacity:0"],
    [f + 0.3, "opacity:1"],
    [f + 0.48, "opacity:1"],
    [f + 0.48, "opacity:0"],
    [f + 0.6, "opacity:0"],
    [f + 0.6, "opacity:1"],
    [opts.to, "opacity:1"],
    [opts.to + 0.25, "opacity:0"]
  ]);
  const parts = [
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="8" fill="${theme.surface}" fill-opacity="0.92" stroke="${theme.accent}" stroke-width="2"/>`
  ];
  let ty = y + 14;
  texts.forEach((p, i) => {
    const fill = i === 0 ? theme.accent : theme.ink;
    parts.push(`<path d="${p.d}" transform="translate(${fmt(opts.cx - p.width / 2)} ${fmt(ty)})" fill="${fill}"${i === 0 ? glowAttr(theme) : ""}/>`);
    ty += p.height + gap;
  });
  return `<g class="${blink}">${parts.join("")}</g>`;
}
function stageClearLines(grid) {
  const total = activeCells(grid).reduce((sum, c) => sum + c.count, 0);
  return ["STAGE CLEAR", `${total} CONTRIBUTIONS`];
}

// src/games/asteroids.ts
var CLEARANCE = 8;
var NOSE = 11;
var BULLET_SPEED = 800;
var SAUCER_SPEED = 300;
var SAUCER_LANE = 186;
var MAX_PLAY = 80;
var THRUST_EASE = "cubic-bezier(.5,0,.2,1)";
var TURN_EASE = "cubic-bezier(.4,0,.2,1)";
var DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
];
var DEBRIS_LIFE = 0.85;
var ROCK_RADIUS = 6.5;
var BOUNDS = { left: 6, right: 6, top: 28, bottom: 8 };
var SHOT_BUDGET = 1.25;
function wrapDelta(d) {
  const twoPi = Math.PI * 2;
  return ((d + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}
function fold(v, lo, hi) {
  const span = hi - lo;
  let u = (v - lo) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u > span ? 2 * span - u : u);
}
function rockAt(rock, t) {
  const dt = Math.max(0, t - rock.t0);
  return {
    x: fold(rock.x + rock.vx * dt, rock.box.x0, rock.box.x1),
    y: fold(rock.y + rock.vy * dt, rock.box.y0, rock.box.y1)
  };
}
function rockBounces(rock, until) {
  const out = [];
  for (const [p, v, lo, hi] of [
    [rock.x, rock.vx, rock.box.x0, rock.box.x1],
    [rock.y, rock.vy, rock.box.y0, rock.box.y1]
  ]) {
    if (Math.abs(v) < 1e-9) continue;
    const span = hi - lo;
    const step = v > 0 ? 1 : -1;
    let k = v > 0 ? Math.floor((p - lo) / span) + 1 : Math.ceil((p - lo) / span) - 1;
    for (; ; k += step) {
      const t = rock.t0 + (lo + k * span - p) / v;
      if (t >= until) break;
      out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}
function slab(a, dx, dy, x0, y0, x1, y1, tMax) {
  let lo = 0;
  let hi = tMax;
  for (const [o, d, min, max] of [
    [a.x, dx, x0, x1],
    [a.y, dy, y0, y1]
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return null;
      continue;
    }
    let s = (min - o) / d;
    let e = (max - o) / d;
    if (s > e) [s, e] = [e, s];
    lo = Math.max(lo, s);
    hi = Math.min(hi, e);
  }
  return lo <= hi ? lo : null;
}
function nearSegment(a, b, p, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y) < r;
}
var Field = class {
  grid;
  layout;
  alive;
  constructor(grid, layout) {
    this.grid = grid;
    this.layout = layout;
    this.alive = grid.cells.map((col) => col.map((c) => c !== null && c.level > 0));
  }
  free(i, j) {
    return i < 0 || j < 0 || i >= this.grid.width || j >= this.grid.height || !this.alive[i][j];
  }
  node(i, j) {
    const [x, y] = cellCenter(this.layout, i, j);
    return { x, y };
  }
  /** First live cell along the ray, walking the cell grid so each cast stays cheap. */
  cast(o, dx, dy) {
    const { left, top, pitch, cell: size } = this.layout;
    const W = this.grid.width;
    const H = this.grid.height;
    const u0 = (o.x - left) / pitch;
    const v0 = (o.y - top) / pitch;
    const du = dx / pitch;
    const dv = dy / pitch;
    let tMin = 0;
    let tMax = 1e9;
    for (const [p, d, n] of [
      [u0, du, W],
      [v0, dv, H]
    ]) {
      if (Math.abs(d) < 1e-12) {
        if (p < 0 || p > n) return null;
        continue;
      }
      let s = -p / d;
      let e = (n - p) / d;
      if (s > e) [s, e] = [e, s];
      tMin = Math.max(tMin, s);
      tMax = Math.min(tMax, e);
    }
    if (tMin > tMax) return null;
    const u = u0 + (tMin + 1e-6) * du;
    const v = v0 + (tMin + 1e-6) * dv;
    let i = Math.min(W - 1, Math.max(0, Math.floor(u)));
    let j = Math.min(H - 1, Math.max(0, Math.floor(v)));
    const sx = du > 0 ? 1 : -1;
    const sy = dv > 0 ? 1 : -1;
    let tx = Math.abs(du) < 1e-12 ? Infinity : ((du > 0 ? i + 1 : i) - u0) / du;
    let ty = Math.abs(dv) < 1e-12 ? Infinity : ((dv > 0 ? j + 1 : j) - v0) / dv;
    const dtx = Math.abs(du) < 1e-12 ? Infinity : Math.abs(1 / du);
    const dty = Math.abs(dv) < 1e-12 ? Infinity : Math.abs(1 / dv);
    while (i >= 0 && i < W && j >= 0 && j < H) {
      if (this.alive[i][j]) {
        const x = left + i * pitch;
        const y = top + j * pitch;
        const t = slab(o, dx, dy, x, y, x + size, y + size, Infinity);
        if (t !== null) return { cell: this.grid.cells[i][j], dist: t };
      }
      if (tx < ty) {
        if (tx > tMax) break;
        i += sx;
        tx += dtx;
      } else {
        if (ty > tMax) break;
        j += sy;
        ty += dty;
      }
    }
    return null;
  }
  /** Whether a ship flying a to b would brush a live cell. */
  blocked(a, b) {
    const { left, top, pitch, cell: size } = this.layout;
    const r = CLEARANCE;
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r - left) / pitch));
    const i1 = Math.min(this.grid.width - 1, Math.floor((Math.max(a.x, b.x) + r - left) / pitch));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r - top) / pitch));
    const j1 = Math.min(this.grid.height - 1, Math.floor((Math.max(a.y, b.y) + r - top) / pitch));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (!this.alive[i][j]) continue;
        const x = left + i * pitch;
        const y = top + j * pitch;
        if (slab(a, dx, dy, x - r, y - r, x + size + r, y + size + r, 1) !== null) return true;
      }
    }
    return false;
  }
};
function planAsteroids(grid, layout, size, seed, tempo) {
  const rng = createRng(seed);
  const field = new Field(grid, layout);
  const cells = activeCells(grid);
  const total = cells.length;
  const W = grid.width;
  const H = grid.height;
  const NJ = H + 2;
  const { width, height } = size;
  const center = { x: layout.left + layout.gridWidth / 2, y: layout.top + layout.gridHeight / 2 };
  const box = rockBox(width, height);
  const gap = 0.17 / tempo;
  const aimSpeed = 10 * tempo;
  const turnSpeed = 7 * tempo;
  const splitting = chooseSplits(cells, rng);
  const poses = [];
  const burns = [];
  const bullets = [];
  const hits = [];
  const rocks = [];
  const rockHits = [];
  const clears = [];
  const inFlight = [];
  const reserved = /* @__PURE__ */ new Set();
  let saucer = null;
  let lastEvent = 0;
  const id = (i, j) => (i + 1) * NJ + (j + 1);
  const dijkstra = (si, sj) => {
    const n = (W + 2) * NJ;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[id(si, sj)] = 0;
    for (; ; ) {
      let u = -1;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        if (!done[k] && dist[k] < best) {
          best = dist[k];
          u = k;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      const ui = Math.floor(u / NJ) - 1;
      const uj = u % NJ - 1;
      const from = field.node(ui, uj);
      for (const [di, dj] of DIRS) {
        const ni = ui + di;
        const nj = uj + dj;
        if (ni < -1 || nj < -1 || ni > W || nj > H || !field.free(ni, nj)) continue;
        const v = id(ni, nj);
        if (done[v]) continue;
        const d = dist[u] + layout.pitch * Math.hypot(di, dj);
        if (d >= dist[v]) continue;
        if (field.blocked(from, field.node(ni, nj))) continue;
        dist[v] = d;
        prev[v] = u;
      }
    }
    return { dist, prev };
  };
  const pathTo = (prev, i, j) => {
    const pts = [];
    for (let k = id(i, j); k >= 0; k = prev[k]) {
      pts.push(field.node(Math.floor(k / NJ) - 1, k % NJ - 1));
    }
    pts.reverse();
    const out = [pts[0]];
    let a = 0;
    while (a < pts.length - 1) {
      let b = pts.length - 1;
      while (b > a + 1 && field.blocked(pts[a], pts[b])) b--;
      out.push(pts[b]);
      a = b;
    }
    return out;
  };
  const liveCells = () => cells.filter((c) => field.alive[c.x][c.y]);
  const looseRocks = (now) => rocks.filter((r) => r.t1 === Infinity && r.t0 <= now);
  const visibleFrom = (p, now) => {
    let n = 0;
    for (const c of liveCells()) {
      const [cx, cy] = cellCenter(layout, c.x, c.y);
      const len = Math.hypot(cx - p.x, cy - p.y);
      const h = field.cast(p, (cx - p.x) / len, (cy - p.y) / len);
      if (h && h.cell === c) n++;
    }
    for (const r of looseRocks(now)) {
      const q = rockAt(r, now + 1);
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const h = field.cast(p, (q.x - p.x) / len, (q.y - p.y) / len);
      if (!h || h.dist > len) n += 5;
    }
    return n;
  };
  const ring = dijkstra(-1, -1);
  let startNode = { i: -1, j: -1 };
  {
    let best = -Infinity;
    const live = liveCells();
    for (let i = -1; i <= W; i++) {
      for (let j = -1; j <= H; j++) {
        if (!field.free(i, j) || !Number.isFinite(ring.dist[id(i, j)])) continue;
        const p = field.node(i, j);
        let clr = 28;
        for (const c of live) {
          const [cx, cy] = cellCenter(layout, c.x, c.y);
          clr = Math.min(clr, Math.hypot(cx - p.x, cy - p.y));
        }
        const score = clr - 0.1 * Math.hypot(p.x - center.x, p.y - center.y);
        if (score > best) {
          best = score;
          startNode = { i, j };
        }
      }
    }
  }
  let node = startNode;
  let pos = field.node(node.i, node.j);
  let angle = -Math.PI / 2;
  let t = 0;
  poses.push({ t: 0, x: pos.x, y: pos.y, a: angle, ease: "linear" });
  const segment = (t0, t1, x, y, a, ease) => {
    const last = poses[poses.length - 1];
    if (last.t < t0 - 1e-9) poses.push({ ...last, t: t0, ease: "linear" });
    poses[poses.length - 1].ease = ease;
    poses.push({ t: t1, x, y, a, ease: "linear" });
  };
  const spawnRocks = (h) => {
    const [cx, cy] = cellCenter(layout, h.cell.x, h.cell.y);
    const third = Math.floor(h.cell.count / 3);
    [-1, 1].forEach((side, k) => {
      const heading = h.dir + Math.PI + side * (0.6 + rng() * 0.6);
      const speed = 20 + rng() * 10;
      const born = h.t;
      rocks.push({
        cell: h.cell,
        share: k === 0 ? third : h.cell.count - 2 * third,
        t0: born,
        t1: Infinity,
        x: cx,
        y: cy,
        vx: Math.cos(heading) * speed,
        vy: Math.sin(heading) * speed,
        phi: rng() * 360,
        spin: (rng() < 0.5 ? -1 : 1) * (25 + rng() * 40),
        radii: Array.from({ length: 8 }, () => ROCK_RADIUS * (0.78 + rng() * 0.38)),
        ripe: born + 0.7 + rng() * 0.5,
        box
      });
    });
  };
  const land = (now) => {
    for (let k = inFlight.length - 1; k >= 0; k--) {
      const h = inFlight[k];
      if (h.t <= now) {
        field.alive[h.cell.x][h.cell.y] = false;
        if (h.split) spawnRocks(h);
        inFlight.splice(k, 1);
      }
    }
  };
  const flyPath = (points, target) => {
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const delta = wrapDelta(Math.atan2(b.y - a.y, b.x - a.x) - angle);
      if (Math.abs(delta) > 0.02) {
        const dur2 = Math.max(0.12, Math.abs(delta) / turnSpeed);
        angle += delta;
        segment(t, t + dur2, a.x, a.y, angle, TURN_EASE);
        t += dur2;
      }
      const dur = (0.28 + Math.hypot(b.x - a.x, b.y - a.y) / 360) / tempo;
      segment(t, t + dur, b.x, b.y, angle, THRUST_EASE);
      burns.push([t, t + dur * 0.42]);
      t += dur;
    }
    pos = points[points.length - 1];
    node = target;
  };
  const flyTo = (i, j) => {
    const { dist, prev } = dijkstra(node.i, node.j);
    if (!Number.isFinite(dist[id(i, j)]) || i === node.i && j === node.j) return false;
    flyPath(pathTo(prev, i, j), { i, j });
    return true;
  };
  const relocate = () => {
    const { dist } = dijkstra(node.i, node.j);
    const options = [];
    for (let i = -1; i <= W; i++) {
      for (let j = -1; j <= H; j++) {
        const d = dist[id(i, j)];
        if (Number.isFinite(d) && d >= 48 && field.free(i, j)) options.push({ i, j });
      }
    }
    if (options.length === 0) return false;
    for (let k = options.length - 1; k > 0; k--) {
      const r = Math.floor(rng() * (k + 1));
      [options[k], options[r]] = [options[r], options[k]];
    }
    let best = options[0];
    let bestScore = -Infinity;
    for (const o of options.slice(0, 28)) {
      const score = visibleFrom(field.node(o.i, o.j), t) - dist[id(o.i, o.j)] * 8e-3 + rng() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return flyTo(best.i, best.j);
  };
  const fire = (aim, dist) => {
    const delta = wrapDelta(aim - angle);
    const dur = Math.max(gap, Math.abs(delta) / aimSpeed);
    angle += delta;
    segment(t, t + dur, pos.x, pos.y, angle, Math.abs(delta) > 0.5 ? TURN_EASE : "linear");
    t += dur;
    const dx = Math.cos(aim);
    const dy = Math.sin(aim);
    const from = { x: pos.x + dx * NOSE, y: pos.y + dy * NOSE };
    const to = { x: pos.x + dx * dist, y: pos.y + dy * dist };
    const flight = Math.max(0.02, (dist - NOSE) / BULLET_SPEED);
    bullets.push({ t0: t, t1: t + flight, from, to });
    return { t: t + flight, point: to, dir: aim };
  };
  const rockClear = (aim, dist) => {
    const h = field.cast(pos, Math.cos(aim), Math.sin(aim));
    return !h || h.dist > dist - 0.5;
  };
  const leadRock = (rock) => {
    for (const side of [0, 0.7, -0.7]) {
      let fireAt = t + gap;
      let flight = 0.1;
      let aim = 0;
      let dist = 0;
      for (let k = 0; k < 4; k++) {
        const q = rockAt(rock, fireAt + flight);
        const base = Math.atan2(q.y - pos.y, q.x - pos.x);
        const reach = Math.hypot(q.x - pos.x, q.y - pos.y);
        const tx = q.x - Math.sin(base) * ROCK_RADIUS * side;
        const ty = q.y + Math.cos(base) * ROCK_RADIUS * side;
        aim = Math.atan2(ty - pos.y, tx - pos.x);
        dist = Math.max(NOSE + 2, reach - ROCK_RADIUS * 0.8);
        fireAt = t + Math.max(gap, Math.abs(wrapDelta(aim - angle)) / aimSpeed);
        flight = Math.max(0.02, (dist - NOSE) / BULLET_SPEED);
      }
      if (rockClear(aim, dist)) return { aim, dist };
    }
    return null;
  };
  const pickShot = (lastSign2) => {
    let best = null;
    const loose = looseRocks(t).map((r) => ({ r, p: rockAt(r, t + 0.25) }));
    for (const c2 of liveCells()) {
      const [cx2, cy2] = cellCenter(layout, c2.x, c2.y);
      const len2 = Math.hypot(cx2 - pos.x, cy2 - pos.y);
      const hit2 = field.cast(pos, (cx2 - pos.x) / len2, (cy2 - pos.y) / len2);
      if (!hit2 || reserved.has(hit2.cell)) continue;
      const aim = Math.atan2(cy2 - pos.y, cx2 - pos.x);
      const end2 = { x: pos.x + Math.cos(aim) * hit2.dist, y: pos.y + Math.sin(aim) * hit2.dist };
      if (loose.some(({ p }) => nearSegment(pos, end2, p, ROCK_RADIUS + 1))) continue;
      const delta = wrapDelta(aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign2 ? 0.12 : 0;
      const cost = Math.abs(delta) + reversal + hit2.dist * 4e-4;
      if (!best || cost < best.cost) best = { cell: hit2.cell, rock: null, dist: hit2.dist, angle: aim, delta, cost };
    }
    for (const { r } of loose) {
      if (r.ripe > t) continue;
      const lead = leadRock(r);
      if (!lead) continue;
      const delta = wrapDelta(lead.aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign2 ? 0.12 : 0;
      const cost = Math.abs(delta) + reversal + lead.dist * 4e-4 - 1.2;
      if (!best || cost < best.cost) best = { cell: r.cell, rock: r, dist: lead.dist, angle: lead.aim, delta, cost };
    }
    if (!best || best.rock) return best;
    const c = best.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    const ax = cx + (rng() - 0.5) * 5 - pos.x;
    const ay = cy + (rng() - 0.5) * 5 - pos.y;
    const len = Math.hypot(ax, ay);
    const hit = field.cast(pos, ax / len, ay / len);
    if (hit && hit.cell === c) {
      const aim = Math.atan2(ay, ax);
      return { cell: c, rock: null, dist: hit.dist, angle: aim, delta: wrapDelta(aim - angle), cost: best.cost };
    }
    return best;
  };
  const runSaucer = () => {
    const eventStart = t;
    const wide = width / 2;
    const picks = [];
    for (let i = Math.round(W * 0.25); i <= Math.round(W * 0.75); i++) {
      picks.push({ i, d: Math.abs(field.node(i, H).x - pos.x) });
    }
    picks.sort((a, b) => a.d - b.d);
    const spotI = picks[0].i;
    flyTo(spotI, H);
    const arrived = t;
    const spot = pos;
    const dir = spot.x < wide ? -1 : 1;
    const x0 = dir < 0 ? width + 16 : -16;
    const xt = spot.x - dir * 120;
    const approach = Math.abs(xt - x0) / SAUCER_SPEED;
    const wobble = (u) => SAUCER_LANE + 2.6 * Math.sin(u * 2.9);
    const sampleAt = (u) => ({ x: x0 + dir * SAUCER_SPEED * u, y: wobble(u) });
    const aimAt = (p) => {
      const a = Math.atan2(p.y - spot.y, p.x - spot.x);
      return { a, m: { x: spot.x + Math.cos(a) * NOSE, y: spot.y + Math.sin(a) * NOSE } };
    };
    const probe = aimAt({ x: xt, y: SAUCER_LANE });
    const flightEst = Math.hypot(xt - probe.m.x, SAUCER_LANE - probe.m.y) / BULLET_SPEED;
    const tOut = Math.max(arrived + 0.95 + flightEst, eventStart + 0.3 + approach);
    const tIn = tOut - approach;
    const hitPt = sampleAt(approach);
    const second = aimAt(hitPt);
    const flight = Math.hypot(hitPt.x - second.m.x, hitPt.y - second.m.y) / BULLET_SPEED;
    const fire2 = tOut - flight;
    const fire1 = fire2 - 0.3;
    const early = sampleAt(approach - (tOut - fire1));
    const first = aimAt(early);
    const reach = 260;
    segment(t, fire1, spot.x, spot.y, angle + wrapDelta(first.a - angle), TURN_EASE);
    angle += wrapDelta(first.a - angle);
    bullets.push({
      t0: fire1,
      t1: fire1 + reach / BULLET_SPEED,
      from: first.m,
      to: { x: first.m.x + Math.cos(first.a) * reach, y: first.m.y + Math.sin(first.a) * reach }
    });
    segment(fire1, fire2, spot.x, spot.y, angle + wrapDelta(second.a - angle), "linear");
    angle += wrapDelta(second.a - angle);
    bullets.push({ t0: fire2, t1: tOut, from: second.m, to: hitPt });
    t = fire2;
    const path = [];
    for (let u = 0; u < approach; u += 0.25) path.push({ t: tIn + u, ...sampleAt(u) });
    path.push({ t: tOut, ...hitPt });
    saucer = { path, tIn, tOut };
    lastEvent = Math.max(lastEvent, tOut);
  };
  if (total === 0) {
    t = 0.5;
    relocate();
    t += 0.6;
    lastEvent = t;
  }
  const quota = () => Math.round((5 + rng() * 8) * (total > 150 ? 1.5 : 1));
  let spotShots = 0;
  let limit = quota();
  let lastSign = 1;
  let fired = 0;
  let sauced = false;
  while (fired < total || inFlight.length > 0 || rocks.some((r) => r.t1 === Infinity)) {
    land(t);
    if (!sauced && total >= 12 && fired >= Math.floor(total * 0.45)) {
      sauced = true;
      runSaucer();
      spotShots = 0;
      continue;
    }
    const shot = pickShot(lastSign);
    if (!shot) {
      const waits = [...inFlight.map((h) => h.t), ...rocks.filter((r) => r.t1 === Infinity && r.ripe > t).map((r) => r.ripe)];
      if (waits.length > 0) {
        t = Math.min(...waits);
        continue;
      }
      if (!relocate()) break;
      spotShots = 0;
      continue;
    }
    if (!shot.rock && (spotShots >= limit || spotShots >= 2 && Math.abs(shot.delta) > 1.4)) {
      relocate();
      spotShots = 0;
      limit = quota();
      continue;
    }
    const delta = shot.delta;
    const shotAt = fire(shot.angle, shot.dist);
    if (shot.rock) {
      shot.rock.t1 = shotAt.t;
      rockHits.push({ rock: shot.rock, t: shotAt.t, point: shotAt.point, dir: shotAt.dir });
      clears.push({ t: shotAt.t, cell: { ...shot.cell, count: shot.rock.share } });
    } else {
      const split = splitting.has(shot.cell);
      const h = { cell: shot.cell, t: shotAt.t, point: shotAt.point, dir: shotAt.dir, split };
      hits.push(h);
      inFlight.push(h);
      reserved.add(shot.cell);
      const share = split ? Math.floor(shot.cell.count / 3) : shot.cell.count;
      clears.push({ t: h.t, cell: share === shot.cell.count ? shot.cell : { ...shot.cell, count: share } });
      fired++;
    }
    if (Math.abs(delta) > 0.01) lastSign = Math.sign(delta);
    spotShots++;
  }
  let end = Math.max(t, lastEvent);
  for (const h of hits) end = Math.max(end, h.t);
  for (const r of rockHits) end = Math.max(end, r.t);
  return {
    layout,
    width,
    height,
    poses,
    burns,
    bullets,
    hits,
    rocks,
    rockHits,
    clears,
    saucer,
    play: Math.max(end + DEBRIS_LIFE, 2.4)
  };
}
function rockBox(width, height) {
  return { x0: BOUNDS.left + 4, x1: width - BOUNDS.right - 4, y0: BOUNDS.top + 6, y1: height - BOUNDS.bottom - 4 };
}
function chooseSplits(cells, rng) {
  const eligible = cells.filter((c) => c.level >= 3 && c.count >= 3);
  const room = Math.max(0, Math.floor((cells.length * (SHOT_BUDGET - 1) + 20) / 2));
  const order = eligible.map((c) => ({ c, k: c.level + rng() * 1.5 })).sort((a, b) => b.k - a.k);
  return new Set(order.slice(0, room).map((o) => o.c));
}
function playAsteroids(ctx) {
  const layout = arcadeLayout(ctx.grid);
  const size = { width: layout.width, height: layout.height };
  const seed = Math.floor(ctx.rng() * 2 ** 32);
  const n = activeCells(ctx.grid).length;
  let tempo = n < 80 ? Math.max(0.55, n / 80) : 1.5;
  let play = planAsteroids(ctx.grid, layout, size, seed, tempo);
  while (play.play > MAX_PLAY && tempo < 4) {
    tempo *= 1.2;
    play = planAsteroids(ctx.grid, layout, size, seed, tempo);
  }
  return play;
}
var f1 = (n) => String(Math.round(n * 10) / 10);
var SLOTS = 16;
var DRIFT_DISTS = [27, 16, 9];
function debrisBox(width, height) {
  return { x0: BOUNDS.left + 4, x1: width - BOUNDS.right - 4, y0: BOUNDS.top + 4, y1: height - BOUNDS.bottom - 2 };
}
function driftPlan(x, y, vx, vy, b) {
  const inside = (px, py) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;
  const slotOf = (dx2, dy2) => (Math.round(Math.atan2(dy2, dx2) / (Math.PI * 2) * SLOTS) % SLOTS + SLOTS) % SLOTS;
  let dx = vx;
  let dy = vy;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slot = slotOf(dx, dy);
    const a = slot / SLOTS * Math.PI * 2;
    for (const dist of DRIFT_DISTS) {
      if (inside(x + Math.cos(a) * dist, y + Math.sin(a) * dist)) return { slot, dist };
    }
    const last = DRIFT_DISTS[DRIFT_DISTS.length - 1];
    if (attempt === 0) {
      if (x + Math.cos(a) * last < b.x0 || x + Math.cos(a) * last > b.x1) dx = -dx;
      if (y + Math.sin(a) * last < b.y0 || y + Math.sin(a) * last > b.y1) dy = -dy;
    } else {
      dx = (b.x0 + b.x1) / 2 - x;
      dy = (b.y0 + b.y1) / 2 - y;
    }
  }
  return { slot: slotOf((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y), dist: DRIFT_DISTS[DRIFT_DISTS.length - 1] };
}
function shatter(rng, size, count) {
  const half = size / 2;
  const c = { x: (rng() - 0.5) * 3, y: (rng() - 0.5) * 3 };
  const base = rng() * Math.PI * 2;
  const step = Math.PI * 2 / count;
  const cuts = Array.from({ length: count }, (_, k) => {
    const a = base + k * step + (rng() - 0.5) * 0.6 * step;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const sx = dx === 0 ? Infinity : ((dx > 0 ? half : -half) - c.x) / dx;
    const sy = dy === 0 ? Infinity : ((dy > 0 ? half : -half) - c.y) / dy;
    const s = Math.min(sx, sy);
    const edge = { x: c.x + dx * s, y: c.y + dy * s };
    const mid = {
      x: (c.x + edge.x) / 2 - dy * (rng() - 0.5) * 3.2,
      y: (c.y + edge.y) / 2 + dx * (rng() - 0.5) * 3.2
    };
    return { a: (a % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2), edge, mid };
  }).sort((p, q) => p.a - q.a);
  const corners = [
    { x: half, y: half },
    { x: -half, y: half },
    { x: -half, y: -half },
    { x: half, y: -half }
  ].map((p) => ({ p, a: (Math.atan2(p.y - c.y, p.x - c.x) + Math.PI * 2) % (Math.PI * 2) }));
  return cuts.map((cut, k) => {
    const next = cuts[(k + 1) % count];
    const span = (next.a - cut.a + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    const rim = [cut.edge];
    corners.map((q) => ({ p: q.p, off: (q.a - cut.a + Math.PI * 2) % (Math.PI * 2) })).filter((q) => q.off > 1e-6 && q.off < span - 1e-6).sort((p, q) => p.off - q.off).forEach((q) => rim.push(q.p));
    rim.push(next.edge);
    const chipped = [];
    rim.forEach((p, i) => {
      chipped.push(p);
      const n = rim[i + 1];
      if (!n) return;
      const inset = 0.5 + rng() * 1.1;
      const mx2 = (p.x + n.x) / 2;
      const my2 = (p.y + n.y) / 2;
      const len = Math.hypot(c.x - mx2, c.y - my2) || 1;
      chipped.push({ x: mx2 + (c.x - mx2) / len * inset, y: my2 + (c.y - my2) / len * inset });
    });
    const pts = [c, cut.mid, ...chipped, next.mid];
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return {
      cx: mx,
      cy: my,
      points: pts.map((p) => `${f1(p.x - mx)},${f1(p.y - my)}`).join(" ")
    };
  });
}
function rockCorners(rock, deg) {
  return rock.radii.map((r, k) => {
    const a = k * Math.PI / 4 + (rock.phi + deg) * Math.PI / 180;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}
function rockWedges(rock, deg) {
  const corners = rockCorners(rock, deg);
  return [
    [0, 1, 2],
    [2, 3, 4, 5],
    [5, 6, 7, 0]
  ].map((idx) => {
    const pts = [{ x: 0, y: 0 }, ...idx.map((k) => corners[k])];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { cx, cy, points: pts.map((p) => `${f1(p.x - cx)},${f1(p.y - cy)}`).join(" ") };
  });
}
function renderAsteroids(ctx, play) {
  const { theme, grid } = ctx;
  const { layout } = play;
  const rng = createRng(`${play.hits.length}:${play.play}`);
  const D = loopDuration(play.play);
  const tl = new Timeline(D, "a");
  const L = (s) => PACE.intro + s;
  const restore = restoreAt(play.play);
  const ink = theme.ink;
  const accent = theme.accent;
  const eps = 1e-3;
  const body = [];
  const defs = [glowDefs(theme)];
  const dbox = debrisBox(play.width, play.height);
  const driftFrames = (angle, dist, spin) => {
    const out = [];
    for (const s of [0, 0.12, 0.3, 0.55, 1]) {
      const e = 1 - (1 - s) * (1 - s);
      const op = s < 0.4 ? 1 : 1 - (s - 0.4) / 0.6;
      out.push([
        s * DEBRIS_LIFE,
        `transform:translate(${fmt(Math.cos(angle) * dist * e)}px,${fmt(Math.sin(angle) * dist * e)}px) rotate(${fmt(spin * e)}deg);opacity:${fmt(op)}`
      ]);
    }
    return out;
  };
  const drifts = /* @__PURE__ */ new Map();
  const driftClass = (x, y, vx, vy, at) => {
    const { slot, dist } = driftPlan(x, y, vx, vy, dbox);
    const variant = Math.floor(rng() * 4);
    const key = `${slot}:${dist}:${variant}`;
    let name = drifts.get(key);
    if (!name) {
      const spin = (variant & 1 ? -1 : 1) * (variant & 2 ? 300 : 190);
      name = tl.keyframes(driftFrames(slot / SLOTS * Math.PI * 2, dist, spin));
      drifts.set(key, name);
    }
    return tl.useKeyframes(name, L(at));
  };
  const burst = tl.keyframes([
    [0, "transform:scale(.35);opacity:1;animation-timing-function:ease-out"],
    [0.3, "transform:scale(1.9);opacity:0"]
  ]);
  const flash = tl.keyframes([
    [0, "transform:scale(.5);opacity:1;animation-timing-function:ease-out"],
    [0.16, "transform:scale(1.6);opacity:0"]
  ]);
  const implode = tl.keyframes([
    [0, "transform:scale(2.4);opacity:0;animation-timing-function:ease-in"],
    [0.2, "transform:scale(1.7);opacity:.9"],
    [0.5, "transform:scale(.25);opacity:0"]
  ]);
  const explode = tl.keyframes([
    [0, "transform:scale(.25);opacity:.9;animation-timing-function:ease-out"],
    [0.4, "transform:scale(2.4);opacity:0"]
  ]);
  const rays = (count, near, far, turn2) => Array.from({ length: count }, (_, k) => {
    const a = k / count * Math.PI * 2 + turn2;
    const r = far(k);
    return `M${f1(Math.cos(a) * near)} ${f1(Math.sin(a) * near)}L${f1(Math.cos(a) * r)} ${f1(Math.sin(a) * r)}`;
  }).join("");
  defs.push(`<path id="sp" d="${rays(8, 3, (k) => k % 2 ? 6 : 8.5, 0.2)}" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>`);
  defs.push(`<path id="se" d="${rays(8, 2.5, () => 5.5, 0.2 + Math.PI / 8)}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`);
  defs.push(`<g id="bl"><circle r="4.2" fill="${ink}" opacity=".3"/><circle r="2.2" fill="${ink}"/></g>`);
  defs.push(`<path id="sh" d="M11.2 0L-8.4 -7L-4.8 0L-8.4 7Z"/>`);
  defs.push(`<path id="ufo" d="M-12 2L-5.5 -2.2H5.5L12 2ZM-12 2L-5.5 5.6H5.5L12 2ZM-4.4 -2.2L-2.4 -6H2.4L4.4 -2.2"/>`);
  const level = (cell) => levelColor(theme, cell);
  for (const hit of play.hits) {
    const c = hit.cell;
    const at = L(hit.t);
    const frames2 = [
      [0, `fill:${level(c)}`],
      [at, `fill:${level(c)}`],
      [at + eps, `fill:${ink}`],
      [at + 0.07, `fill:${ink}`],
      [at + 0.07 + eps, `fill:${theme.empty}`],
      [restore, `fill:${theme.empty}`],
      [restore + PACE.restore, `fill:${level(c)}`]
    ];
    body.push(cellRect(layout, c, level(c), `class="${tl.track(frames2)}"`));
  }
  const rest = [];
  for (const col of grid.cells) {
    for (const c of col) {
      if (c && c.level === 0) rest.push(cellRect(layout, c, theme.empty));
    }
  }
  body.unshift(...rest);
  const spark = (x, y, scale, at, color) => `<g transform="translate(${f1(x)} ${f1(y)})${scale === 1 ? "" : ` scale(${scale})`}"><g class="${tl.useKeyframes(burst, L(at))}"><use href="#sp"/><use href="#se" color="${color}"/></g><circle r="3.4" class="fl ${tl.useKeyframes(flash, L(at))}"/></g>`;
  const debris = [];
  const sparks = [];
  const rocksOut = [];
  const bulletsOut = [];
  for (const hit of play.hits) {
    const c = hit.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    if (!hit.split) {
      const count = c.level >= 4 ? 4 : c.level === 3 ? 3 : 2 + Math.floor(rng() * 2);
      for (const piece of shatter(rng, layout.cell, count)) {
        const outward = Math.atan2(piece.cy, piece.cx);
        const vx = Math.cos(outward) * 0.7 + Math.cos(hit.dir) * 0.9;
        const vy = Math.sin(outward) * 0.7 + Math.sin(hit.dir) * 0.9;
        const x = cx + piece.cx;
        const y = cy + piece.cy;
        debris.push(
          `<g transform="translate(${f1(x)} ${f1(y)})"><polygon class="r${c.level} ${driftClass(x, y, vx, vy, hit.t)}" points="${piece.points}"/></g>`
        );
      }
    }
    sparks.push(spark(hit.point.x, hit.point.y, hit.split ? 1.25 : 1, hit.t, theme.sprites[3]));
  }
  const hitOf = new Map(play.rockHits.map((h) => [h.rock, h]));
  for (const r of play.rocks) {
    const h = hitOf.get(r);
    const life = r.t1 - r.t0;
    const pose = (t, scale, opacity) => {
      const p = rockAt(r, t);
      return `opacity:${opacity};transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) scale(${scale})`;
    };
    const grow = Math.min(0.14, life);
    const frames2 = [
      [0, pose(r.t0, 0.5, 0)],
      [L(r.t0), pose(r.t0, 0.5, 0)],
      [L(r.t0) + eps, pose(r.t0, 0.5, 1)],
      [L(r.t0 + grow), pose(r.t0 + grow, 1, 1)],
      ...rockBounces(r, r.t1).filter((b) => b > r.t0 + grow).map((b) => [L(b), pose(b, 1, 1)]),
      [L(r.t1), pose(r.t1, 1, 1)],
      [L(r.t1) + eps, pose(r.t1, 1, 0)]
    ];
    const turn2 = tl.track([
      [L(r.t0), "transform:rotate(0deg)"],
      [L(r.t1), `transform:rotate(${fmt(r.spin * life)}deg)`]
    ]);
    const points = rockCorners(r, 0).map((p) => `${f1(p.x)},${f1(p.y)}`).join(" ");
    rocksOut.push(
      `<g class="${tl.track(frames2)}"><polygon class="rock ${turn2}" fill="${spriteColor(theme, r.cell)}" points="${points}"/></g>`
    );
    const end = rockAt(r, r.t1);
    sparks.push(spark(h.point.x, h.point.y, 1.1, r.t1, theme.sprites[3]));
    const heading = Math.atan2(r.vy, r.vx);
    for (const w of rockWedges(r, r.spin * life)) {
      const x = end.x + w.cx;
      const y = end.y + w.cy;
      const outward = Math.atan2(w.cy, w.cx);
      const vx = Math.cos(outward) + Math.cos(heading) * 0.5;
      const vy = Math.sin(outward) + Math.sin(heading) * 0.5;
      debris.push(
        `<g transform="translate(${f1(x)} ${f1(y)})"><polygon class="rock ${driftClass(x, y, vx, vy, r.t1)}" fill="${spriteColor(theme, r.cell)}" points="${w.points}"/></g>`
      );
    }
  }
  for (const b of play.bullets) {
    const from = `transform:translate(${fmt(b.from.x)}px,${fmt(b.from.y)}px)`;
    const to = `transform:translate(${fmt(b.to.x)}px,${fmt(b.to.y)}px)`;
    const cls = tl.track([
      [0, `opacity:0;${from}`],
      [L(b.t0), `opacity:0;${from}`],
      [L(b.t0) + eps, `opacity:1;${from}`],
      [L(b.t1), `opacity:1;${to}`],
      [L(b.t1) + eps, `opacity:0;${to}`]
    ]);
    bulletsOut.push(`<use href="#bl" class="${cls}"/>`);
  }
  let saucerOut = "";
  const ringAt = (p, kf, t, r = 15) => `<g transform="translate(${f1(p.x)} ${f1(p.y)})"><circle r="${r}" class="ring ${tl.useKeyframes(kf, t)}"/></g>`;
  const rings = [];
  if (play.saucer) {
    const s = play.saucer;
    const pos = (p) => `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px)`;
    const first2 = s.path[0];
    const last2 = s.path[s.path.length - 1];
    const frames2 = [
      [0, `opacity:0;${pos(first2)}`],
      [L(s.tIn), `opacity:0;${pos(first2)}`],
      [L(s.tIn) + eps, `opacity:1;${pos(first2)}`],
      ...s.path.map((p) => [L(p.t), `opacity:1;${pos(p)}`]),
      [L(s.tOut) + eps, `opacity:0;${pos(last2)}`]
    ];
    const cls = tl.track(frames2);
    saucerOut += `<g class="${cls}"><use href="#ufo" class="halo"/><use href="#ufo" class="line"/></g>`;
    saucerOut += spark(last2.x, last2.y, 1.7, s.tOut, accent);
    rings.push(ringAt(last2, explode, L(s.tOut), 9));
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * Math.PI * 2 + 0.3 + rng() * 0.4;
      const len = 3.5 + rng() * 3;
      const x = last2.x + Math.cos(a) * 3;
      const y = last2.y + Math.sin(a) * 3;
      const cls2 = driftClass(x, y, Math.cos(a), Math.sin(a), s.tOut);
      saucerOut += `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(a * 180 / Math.PI)})"><path class="${k % 2 ? "burn" : "line"} ${cls2}" d="M${f1(-len)} 0H${f1(len)}"/></g>`;
    }
  }
  const poseCss2 = (p, ease) => `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) rotate(${fmt(p.a * 180 / Math.PI)}deg)${ease ? `;animation-timing-function:${ease}` : ""}`;
  const poseFrames = play.poses.map((p) => [L(p.t), poseCss2(p, p.ease)]);
  const first = play.poses[0];
  const last = play.poses[play.poses.length - 1];
  const warpIn = 0.2;
  const bannerFrom = L(play.play) + 0.05;
  const bannerTo = restore - 0.3;
  const outAt = restore - 0.25;
  poseFrames.push([outAt + 0.38, poseCss2(last)], [outAt + 0.381, poseCss2(first)]);
  const move = tl.track(poseFrames);
  const flame = [[0, "opacity:0"]];
  for (const [a, b] of play.burns) {
    flame.push([L(a), "opacity:0"], [L(a) + 0.03, "opacity:1"], [L(b), "opacity:1"], [L(b) + 0.05, "opacity:0"]);
  }
  const flameCls = tl.track(flame);
  const shim = (t, op, sx, sy) => [t, `opacity:${op};transform:scale(${sx},${sy})`];
  const shimmer = tl.track([
    shim(0, 0, 3, 0.05),
    shim(warpIn, 0, 3, 0.05),
    shim(warpIn + 0.1, 1, 2.4, 0.1),
    shim(warpIn + 0.2, 0.3, 1.4, 0.5),
    shim(warpIn + 0.28, 1, 0.85, 1.2),
    shim(warpIn + 0.36, 0.35, 1.1, 0.9),
    shim(warpIn + 0.44, 1, 1, 1),
    shim(outAt, 1, 1, 1),
    shim(outAt + 0.08, 0.4, 1, 1),
    shim(outAt + 0.16, 1, 1.1, 0.9),
    shim(outAt + 0.26, 0.8, 1.8, 0.3),
    shim(outAt + 0.34, 0, 3, 0.05)
  ]);
  rings.push(ringAt(first, implode, warpIn), ringAt(last, explode, outAt + 0.04));
  const ship = `<g class="${move}"><g class="${shimmer}"><g transform="translate(-4.6 0)"><g class="flick"><path class="burn" opacity=".75" d="M0 -2.4L-5.5 0L0 2.4"/></g></g><g class="${flameCls}"><g transform="translate(-4.6 0)"><g class="flick"><path class="burn" d="M0 -3.4L-10 0L0 3.4"/><path class="burn" d="M0 -1.4L-5.5 0L0 1.4"/></g></g></g><use href="#sh" class="halo"/><use href="#sh" class="hull"/></g></g>`;
  const text = banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: layout.left + layout.gridWidth / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: bannerFrom,
    to: bannerTo
  });
  const score = hud(tl, grid, {
    theme,
    title: "ASTEROIDS",
    clears: play.clears.map((e) => ({ t: L(e.t), cell: e.cell })),
    resetAt: restore,
    width: play.width
  });
  const glow = glowAttr(theme);
  const css = [
    tl.css(),
    ...[1, 2, 3, 4].map((l) => `.r${l}{fill:${spriteColor(theme, { level: l })};fill-opacity:.55;stroke:${ink};stroke-width:1;stroke-linejoin:round;stroke-opacity:.9}`),
    `.rock{fill-opacity:.5;stroke:${ink};stroke-width:1.3;stroke-linejoin:round}`,
    `.fl{fill:${ink};opacity:0}`,
    `.halo{fill:none;stroke:${ink};stroke-width:4.4;stroke-opacity:.28;stroke-linejoin:round;stroke-linecap:round}`,
    `.hull{fill:${ink};fill-opacity:.22;stroke:${ink};stroke-width:1.7;stroke-linejoin:round}`,
    `.line{fill:none;stroke:${ink};stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}`,
    `.burn{fill:none;stroke:${accent};stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}`,
    `.ring{fill:none;stroke:${ink};stroke-width:1.2;opacity:0}`,
    `.flick{animation:flick .16s steps(1) infinite}`,
    `@keyframes flick{0%{transform:scale(1,1)}33%{transform:scale(.6,.75)}66%{transform:scale(1.25,1.1)}}`
  ].join("\n");
  return {
    width: play.width,
    height: play.height,
    css,
    defs: defs.join(""),
    body: [
      ...body,
      score,
      ...debris,
      `<g${glow}>${rocksOut.join("")}</g>`,
      `<g${glow}>${sparks.join("")}</g>`,
      `<g${glow}>${bulletsOut.join("")}</g>`,
      `<g${glow}>${saucerOut}${rings.join("")}</g>`,
      `<g${glow}>${ship}</g>`,
      text
    ].join("")
  };
}
var asteroids = {
  id: "asteroids",
  title: "Asteroids",
  render(ctx) {
    return renderAsteroids(ctx, playAsteroids(ctx));
  }
};

// src/sprite-kit.ts
function isDark(theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function mix(a, b, t = 0.5) {
  const parse = (hex2) => [1, 3, 5].map((i) => parseInt(hex2.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  const hex = (i) => Math.round(pa[i] + (pb[i] - pa[i]) * t).toString(16).padStart(2, "0");
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}
function pixelSprite(rows, palette, scale = 1, outline) {
  const parts = [];
  if (outline) {
    const silhouette = bitmapPath(
      rows.map((r) => r.replace(/[^.]/g, "#")),
      scale
    );
    parts.push(`<path d="${silhouette}" fill="${outline.color}" stroke="${outline.color}" stroke-width="${fmt(outline.width)}" stroke-linejoin="round"/>`);
  }
  for (const [key, fill] of Object.entries(palette)) {
    if (!rows.some((r) => r.includes(key))) continue;
    const mask = rows.map((r) => [...r].map((ch) => ch === key ? "#" : ".").join(""));
    parts.push(`<path d="${bitmapPath(mask, scale)}" fill="${fill}"/>`);
  }
  return parts.join("");
}

// src/games/bomberman-sim.ts
var FUSE = 7;
var FLAME = 4;
var START_RANGE = 2;
var MAX_RANGE = 4;
var MAX_LAYERS = 260;
var ITEM_VALUE = 100;
var SWEEP_WINDOW = 7;
function simulateBomberman(grid, rng) {
  const cols = grid.width + 2;
  const rows = grid.height + 2;
  const n = cols * rows;
  const block = new Uint8Array(n);
  const cellOf = /* @__PURE__ */ new Map();
  for (const c of activeCells(grid)) {
    const idx = (c.y + 1) * cols + c.x + 1;
    block[idx] = 1;
    cellOf.set(idx, c);
  }
  const nbrs = [];
  for (let i = 0; i < n; i++) {
    const x = i % cols;
    const y = (i - x) / cols;
    const list = [];
    if (y > 0) list.push(i - cols);
    if (y < rows - 1) list.push(i + cols);
    if (x > 0) list.push(i - 1);
    if (x < cols - 1) list.push(i + 1);
    nbrs.push(list);
  }
  const flameCells = (idx, range2) => {
    const out = [idx];
    const x = idx % cols;
    const y = (idx - x) / cols;
    for (let k = 1; k <= range2; k++) {
      if (y - k >= 0) out.push(idx - k * cols);
      if (y + k < rows) out.push(idx + k * cols);
      if (x - k >= 0) out.push(idx - k);
      if (x + k < cols) out.push(idx + k);
    }
    return out;
  };
  const inLine = (a, b, range2) => {
    const ax = a % cols;
    const ay = (a - ax) / cols;
    const bx = b % cols;
    const by = (b - bx) / cols;
    return ay === by && Math.abs(ax - bx) <= range2 || ax === bx && Math.abs(ay - by) <= range2;
  };
  const resolve = (bombs2) => {
    for (const b of bombs2) b.explode = b.plant + FUSE;
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of bombs2) {
        for (const b of bombs2) {
          if (a !== b && b.explode > a.explode && b.plant <= a.explode && inLine(a.cell, b.cell, a.range)) {
            b.explode = a.explode;
            changed = true;
          }
        }
      }
    }
  };
  const buildHazard = (bombs2) => {
    const spans = new Array(n);
    const last = new Int32Array(n);
    let end = 0;
    for (const b of bombs2) {
      for (const c of flameCells(b.cell, b.range)) {
        (spans[c] ??= []).push(b.explode, b.explode + FLAME);
        last[c] = Math.max(last[c], b.explode + FLAME);
      }
      end = Math.max(end, b.explode + FLAME);
    }
    return { spans, last, end };
  };
  const flamed = (h, cell, tick2) => {
    const s = h.spans[cell];
    if (!s) return false;
    for (let i = 0; i < s.length; i += 2) if (tick2 >= s[i] && tick2 < s[i + 1]) return true;
    return false;
  };
  const bombAt = (bombs2, cell, tick2) => bombs2.some((b) => b.cell === cell && b.plant <= tick2 && tick2 < b.explode);
  const search = (env, start, t0, goal) => {
    const first = new Int32Array(n).fill(-1);
    const l0 = new Int16Array(n).fill(-1);
    l0[start] = start;
    first[start] = t0;
    const layers = [l0];
    const result = { t0, layers, first, found: null };
    if (goal?.(start, t0)) {
      result.found = { cell: start, k: 0 };
      return result;
    }
    let cur = [start];
    for (let k = 0; k < MAX_LAYERS; k++) {
      const tau = t0 + k;
      const par = new Int16Array(n).fill(-1);
      const next = [];
      let fresh = 0;
      for (const u of cur) {
        const options = [u, ...nbrs[u]];
        for (const v of options) {
          if (par[v] !== -1) continue;
          if (v !== u && (env.block[v] || bombAt(env.bombs, v, tau + 1))) continue;
          if (flamed(env.haz, v, tau) || flamed(env.haz, v, tau + 1)) continue;
          par[v] = u;
          next.push(v);
          if (first[v] < 0) {
            first[v] = tau + 1;
            fresh++;
          }
          if (goal && !result.found && goal(v, tau + 1)) result.found = { cell: v, k: k + 1 };
        }
      }
      layers.push(par);
      if (result.found) return result;
      cur = next;
      if (next.length === 0) break;
      if (tau > env.haz.end + 2 && fresh === 0) break;
    }
    return result;
  };
  const trace = (r, cell, k) => {
    const out = new Array(k + 1);
    out[k] = cell;
    for (let i = k; i > 0; i--) {
      cell = r.layers[i][cell];
      out[i - 1] = cell;
    }
    return out;
  };
  let blocksLeft = cellOf.size;
  const total = blocksLeft;
  const drops = total >= 50 ? [
    { at: Math.round(total * 0.06), kind: "bomb" },
    { at: Math.round(total * 0.2), kind: "fire" },
    { at: Math.round(total * 0.4), kind: "bomb" },
    { at: Math.round(total * 0.6), kind: "fire" }
  ] : total >= 24 ? [
    { at: Math.round(total * 0.15), kind: "bomb" },
    { at: Math.round(total * 0.4), kind: "fire" }
  ] : total >= 10 ? [{ at: Math.round(total * 0.4), kind: "fire" }] : [];
  let tick = 0;
  let pos = 0;
  let range = START_RANGE;
  let maxBombs = 1;
  let broken = 0;
  let nextDrop = 0;
  let bombs = [];
  let spent = [];
  let plan = [];
  let idle = 0;
  let lastBlast = 0;
  const path = [pos];
  const plants = [];
  const blasts = [];
  const breaks = [];
  const itemEvents = [];
  const items = /* @__PURE__ */ new Map();
  const pendingBlocks = () => {
    const pending = new Uint8Array(n);
    for (const b of bombs) for (const c of flameCells(b.cell, b.range)) if (block[c]) pending[c] = 1;
    return pending;
  };
  const gainAt = (idx, r, pending) => {
    let g = 0;
    for (const c of flameCells(idx, r)) if (block[c] && !pending[c]) g++;
    return g;
  };
  const decide = (r) => {
    resolve(bombs);
    spent = spent.filter((b) => b.explode + FLAME > tick);
    const env = { block, bombs, haz: buildHazard([...bombs, ...spent]) };
    const reach = search(env, pos, tick);
    const pending = pendingBlocks();
    const cands = [];
    let frontier = cols;
    for (const idx of cellOf.keys()) if (block[idx]) frontier = Math.min(frontier, idx % cols);
    for (let idx = 0; idx < n; idx++) {
      const arrive = reach.first[idx];
      if (arrive < 0 || block[idx]) continue;
      const cost = arrive - tick;
      if (items.has(idx) && env.haz.last[idx] <= arrive) cands.push({ idx, score: ITEM_VALUE - cost * 0.01, item: true });
      if (blocksLeft > 0 && idx % cols <= frontier + SWEEP_WINDOW) {
        const g = gainAt(idx, r, pending);
        if (g > 0) cands.push({ idx, score: g / (cost + 4), item: false });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const cand of cands.slice(0, 40)) {
      const arrive = reach.first[cand.idx];
      const toCell = trace(reach, cand.idx, arrive - tick);
      const steps = toCell.slice(1).map((to) => ({ to }));
      if (cand.item) return steps;
      const alive = bombs.filter((b) => b.plant <= arrive && arrive < b.explode);
      let plantAt = arrive;
      if (alive.length >= maxBombs) {
        const times = alive.map((b) => b.explode).sort((a, b) => a - b);
        plantAt = times[alive.length - maxBombs];
      }
      let safe = true;
      for (let t = arrive; t <= plantAt && safe; t++) if (flamed(env.haz, cand.idx, t)) safe = false;
      if (!safe) continue;
      const hypo = bombs.map((b) => ({ ...b }));
      hypo.push({ cell: cand.idx, plant: plantAt, range: r, explode: plantAt + FUSE, event: null });
      resolve(hypo);
      const haz1 = buildHazard([...hypo, ...spent]);
      const escape = search({ block, bombs: hypo, haz: haz1 }, cand.idx, plantAt, (cell, t) => haz1.last[cell] <= t);
      if (!escape.found) continue;
      const out = trace(escape, escape.found.cell, escape.found.k);
      for (let t = arrive; t < plantAt; t++) steps.push({ to: cand.idx });
      out.slice(1).forEach((to, i) => steps.push(i === 0 ? { to, plant: true } : { to }));
      return steps;
    }
    return [];
  };
  const explodeDue = () => {
    const due = bombs.filter((b) => b.explode === tick);
    if (due.length === 0) return;
    const hit = /* @__PURE__ */ new Set();
    for (const b of due) {
      const x = b.cell % cols;
      const y = (b.cell - x) / cols;
      blasts.push({
        idx: b.cell,
        tick,
        range: b.range,
        arms: [Math.min(b.range, y), Math.min(b.range, rows - 1 - y), Math.min(b.range, x), Math.min(b.range, cols - 1 - x)]
      });
      b.event.explode = tick;
      for (const c of flameCells(b.cell, b.range)) if (block[c]) hit.add(c);
    }
    lastBlast = tick;
    spent.push(...due);
    bombs = bombs.filter((b) => b.explode !== tick);
    const batch = [...hit].sort((a, b) => a - b);
    for (const c of batch) {
      block[c] = 0;
      blocksLeft--;
      broken++;
      breaks.push({ cell: cellOf.get(c), idx: c, tick });
    }
    while (nextDrop < drops.length && broken >= drops[nextDrop].at && batch.length > 0) {
      const spot = batch[Math.floor(rng() * batch.length)];
      const item = { idx: spot, kind: drops[nextDrop].kind, revealed: tick, taken: null };
      items.set(spot, item);
      itemEvents.push(item);
      nextDrop++;
      break;
    }
  };
  for (; ; ) {
    explodeDue();
    if (blocksLeft === 0 && bombs.length === 0) plan = [];
    if (plan.length === 0) {
      plan = decide(range);
      if (plan.length === 0 && blocksLeft > 0 && bombs.length === 0) plan = decide(1);
      if (plan.length === 0) {
        if (blocksLeft === 0 && bombs.length === 0) break;
        if (++idle > 80) throw new Error("Bomberman cannot reach the remaining blocks");
      } else {
        idle = 0;
      }
    }
    const step = plan.shift() ?? { to: pos };
    if (step.plant) {
      const event = { idx: pos, tick, explode: tick + FUSE, range };
      plants.push(event);
      bombs.push({ cell: pos, plant: tick, range, explode: tick + FUSE, event });
      resolve(bombs);
    }
    pos = step.to;
    tick++;
    path.push(pos);
    const item = items.get(pos);
    if (item && item.taken === null) {
      item.taken = tick;
      items.delete(pos);
      if (item.kind === "fire") range = Math.min(MAX_RANGE, range + 1);
      else maxBombs = Math.min(3, maxBombs + 1);
    }
    if (tick > 6e3) throw new Error("Bomberman ran out of time");
  }
  return { cols, rows, path, plants, blasts, breaks, items: itemEvents, ticks: total === 0 ? 0 : Math.max(tick, lastBlast + FLAME) };
}

// src/games/bomberman.ts
var OUTLINE = "#1b1f3b";
var TARGET_PLAY = 58;
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function paletteFor(theme) {
  if (isDark(theme)) {
    return { flameOuter: "#ff7a1f", flameMid: "#ffd43b", flameCore: "#fffbe6", flameStroke: "none", bombBody: "#232842", bombRim: "#8f9bc4", fuse: "#d9b27a", spark: "#ffe14d" };
  }
  return { flameOuter: "#ff5f1f", flameMid: "#ffb21f", flameCore: "#fff6d0", flameStroke: "#b83c00", bombBody: "#161a2e", bombRim: "#0b0e1a", fuse: "#8a5a22", spark: "#ff9a1f" };
}
function render(ctx) {
  const { grid, theme } = ctx;
  const pal = paletteFor(theme);
  const layout = arcadeLayout(grid);
  const sim = simulateBomberman(grid, ctx.rng);
  const hasPlay = sim.breaks.length > 0;
  const dt = hasPlay ? Math.min(0.14, Math.max(0.085, TARGET_PLAY / sim.ticks)) : 0.14;
  const play = hasPlay ? Math.round(sim.ticks * dt * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (tick) => PACE.intro + tick * dt;
  const { cols, rows } = sim;
  const px = (idx) => cellCenter(layout, idx % cols - 1, Math.floor(idx / cols) - 1);
  const cellSet = /* @__PURE__ */ new Map();
  for (const b of sim.breaks) cellSet.set(b.cell, at(b.tick));
  const defs = [glowDefs(theme)];
  for (let level = 1; level <= 4; level++) {
    const fill = theme.levels[level - 1];
    const mortar = luminance(fill) < 0.3 ? mix(fill, "#ffffff", 0.22) : mix(fill, "#000000", 0.32);
    defs.push(`<path id="bk${level}" d="M0 4H12M0 8H12M6 0V4M3 4V8M9 4V8M6 8V12" stroke="${mortar}" stroke-width="1" fill="none"/>`);
  }
  defs.push(`<path id="deb" d="M-1-7h2v2h-2zM5-5h2v2h-2zM6-1h2v2h-2zM4 4h2v2h-2zM-1 5h2v2h-2zM-6 4h2v2h-2zM-8-1h2v2h-2zM-6-5h2v2h-2z"/>`);
  const burstKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.45) rotate(0deg)"],
    [0.4, "opacity:0;transform:scale(1.9) rotate(40deg)"],
    [duration, "opacity:0;transform:scale(1.9) rotate(40deg)"]
  ]);
  const flashKf = tl.keyframes([
    [0, "opacity:.95;transform:scale(.3)"],
    [0.22, "opacity:0;transform:scale(1.5)"],
    [duration, "opacity:0;transform:scale(1.5)"]
  ]);
  const ringKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.2)"],
    [0.55, "opacity:0;transform:scale(2.6)"],
    [duration, "opacity:0;transform:scale(2.6)"]
  ]);
  const bigRingKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.2)"],
    [0.8, "opacity:0;transform:scale(4.2)"],
    [duration, "opacity:0;transform:scale(4.2)"]
  ]);
  const popKf = tl.keyframes([
    [0, "opacity:0;transform:translateY(0px)"],
    [0.08, "opacity:1;transform:translateY(-2px)"],
    [0.9, "opacity:1;transform:translateY(-9px)"],
    [1.2, "opacity:0;transform:translateY(-11px)"],
    [duration, "opacity:0;transform:translateY(-11px)"]
  ]);
  const flame = FLAME * dt;
  const flameKf = tl.keyframes([
    [0, "opacity:1;transform:scale(1.18)"],
    [dt, "opacity:1;transform:scale(1)"],
    [flame - dt * 0.8, "opacity:1;transform:scale(1)"],
    [flame, "opacity:0;transform:scale(.92)"],
    [duration, "opacity:0;transform:scale(.92)"]
  ]);
  const flameMidKf = tl.keyframes([
    [0, "opacity:1"],
    [dt * 2.5, "opacity:1"],
    [flame - dt * 0.4, "opacity:0"],
    [duration, "opacity:0"]
  ]);
  const flameCoreKf = tl.keyframes([
    [0, "opacity:1"],
    [dt * 0.9, "opacity:1"],
    [dt * 1.3, "opacity:0"],
    [dt * 2, "opacity:0"],
    [dt * 2, "opacity:.9"],
    [dt * 2.6, "opacity:0"],
    [duration, "opacity:0"]
  ]);
  const bombLife = /* @__PURE__ */ new Map();
  const bombKf = (life) => {
    const key = Math.round(life * 1e3);
    let name = bombLife.get(key);
    if (!name) {
      name = tl.keyframes([
        [0, "opacity:0;transform:scale(.4)"],
        [1e-3, "opacity:1;transform:scale(.55)"],
        [0.12, "opacity:1;transform:scale(1)"],
        [life, "opacity:1;transform:scale(1)"],
        [life + 1e-3, "opacity:0;transform:scale(1)"],
        [duration, "opacity:0;transform:scale(1)"]
      ]);
      bombLife.set(key, name);
    }
    return name;
  };
  const floor = [];
  const tiles = [];
  for (let i = 0; i < cols * rows; i++) {
    const x = i % cols - 1;
    const y = Math.floor(i / cols) - 1;
    const lane = x < 0 || y < 0 || x >= grid.width || y >= grid.height;
    if (!lane) continue;
    const [cx, cy] = cellCenter(layout, x, y);
    floor.push(`<rect x="${fmt(cx - 6)}" y="${fmt(cy - 6)}" width="12" height="12" rx="2.4" fill="${theme.empty}" opacity=".5"/>`);
  }
  const blocks = [];
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      tiles.push(cellRect(layout, cell, theme.empty));
      if (cell.level === 0) continue;
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      const fill = levelColor(theme, cell);
      const te = cellSet.get(cell);
      const body2 = `<rect x="${fmt(cx - 6)}" y="${fmt(cy - 6)}" width="12" height="12" rx="${layout.radius}" fill="${fill}"/><use href="#bk${cell.level}" x="${fmt(cx - 6)}" y="${fmt(cy - 6)}"/>`;
      if (te === void 0) {
        blocks.push(`<g>${body2}</g>`);
        continue;
      }
      const rest = "opacity:1;transform:scale(1)";
      const cls = tl.track([
        [0, rest],
        [te, rest],
        [te + 0.03, "opacity:1;transform:scale(1.22)"],
        [te + 0.15, "opacity:0;transform:scale(.4)"],
        [restore, "opacity:0;transform:scale(1)"],
        [fadeEnd, rest]
      ]);
      blocks.push(`<g class="c ${cls}">${body2}</g>`);
    }
  }
  const debris = [];
  for (const b of sim.breaks) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    const color = spriteColor(theme, b.cell);
    debris.push(
      `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><use href="#deb" fill="${color}" class="${tl.useKeyframes(burstKf, t)}"/><circle r="7" fill="#fff" class="${tl.useKeyframes(flashKf, t)}"/></g>`
    );
  }
  const items = [];
  const popups = [];
  const itemRings = [];
  for (const item of sim.items) {
    const [cx, cy] = px(item.idx);
    const born = at(item.revealed);
    const taken = item.taken === null ? restore : at(item.taken);
    const cls = tl.track([
      [0, "opacity:0;transform:scale(.3)"],
      [born, "opacity:0;transform:scale(.3)"],
      [born + 0.12, "opacity:1;transform:scale(1.25)"],
      [born + 0.3, "opacity:1;transform:scale(1)"],
      [taken, "opacity:1;transform:scale(1)"],
      [taken + 0.18, "opacity:0;transform:scale(1.8)"],
      [duration, "opacity:0;transform:scale(1.8)"]
    ]);
    items.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="c ${cls}"><g class="bob">${powerIcon(item.kind, pal)}</g></g></g>`);
    if (item.taken !== null) {
      const label = pixelText(item.kind === "fire" ? "FIRE UP" : "BOMB UP", 1);
      const lx = Math.min(Math.max(cx - label.width / 2, 12), layout.width - 12 - label.width);
      const ly = cy < 60 ? cy + 12 : cy - 24;
      popups.push(
        `<g transform="translate(${fmt(lx)} ${fmt(ly)})"><path d="${label.d}" fill="#ffffff" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round" paint-order="stroke" class="${tl.useKeyframes(popKf, taken)}"/></g>`
      );
      itemRings.push(
        `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><circle r="8" fill="none" stroke="${item.kind === "fire" ? pal.flameMid : theme.accent}" stroke-width="2" class="${tl.useKeyframes(ringKf, taken)}"/></g>`
      );
    }
  }
  const bombs = [];
  for (const p of sim.plants) {
    const [cx, cy] = px(p.idx);
    const life = (p.explode - p.tick) * dt;
    const cls = tl.useKeyframes(bombKf(life), at(p.tick));
    bombs.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="c ${cls}"><g class="pulse">${bombShape(pal)}</g></g></g>`);
  }
  const lastBlastTick = Math.max(...sim.blasts.map((b) => b.tick), 0);
  const blasts = [];
  const bigRings = [];
  for (const b of sim.blasts) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    const outer = crossShape(b.arms, 6, layout.pitch, pal.flameOuter, pal.flameStroke === "none" ? "" : ` stroke="${pal.flameStroke}" stroke-width="1"`);
    const mid = crossShape(b.arms, 3.8, layout.pitch, pal.flameMid, "");
    const core = crossShape(b.arms, 1.7, layout.pitch, pal.flameCore, "");
    blasts.push(
      `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="${tl.useKeyframes(flameKf, t)}">${outer}<g class="${tl.useKeyframes(flameMidKf, t)}">${mid}</g><g class="${tl.useKeyframes(flameCoreKf, t)}">${core}</g></g></g>`
    );
    if (b.tick === lastBlastTick) {
      bigRings.push(
        `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><circle r="9" fill="none" stroke="${theme.accent}" stroke-width="2.4" class="${tl.useKeyframes(bigRingKf, t)}"/></g>`
      );
    }
  }
  const start = px(0);
  const path = sim.path.slice();
  while (path.length < sim.ticks + 1) path.push(path[path.length - 1]);
  const pts = path.map((idx) => px(idx));
  const posFrames = [[0, translate(pts[0][0], pts[0][1])]];
  const walkRuns = [];
  const faceFrames = [[0, face(0, 1)]];
  let facing = "d";
  let runStart = -1;
  for (let k = 0; k < path.length - 1; k++) {
    const dx = pts[k + 1][0] - pts[k][0];
    const dy = pts[k + 1][1] - pts[k][1];
    const moving = dx !== 0 || dy !== 0;
    if (moving && runStart < 0) runStart = k;
    if (!moving && runStart >= 0) {
      walkRuns.push([runStart, k]);
      runStart = -1;
    }
    if (moving) {
      const dir = dx > 0 ? "r" : dx < 0 ? "l" : dy > 0 ? "d" : "u";
      if (dir !== facing) {
        const prev = faceFrames[faceFrames.length - 1][1];
        faceFrames.push([at(k), prev], [at(k), faceCss(dir)]);
        facing = dir;
      }
    }
    if (k > 0) {
      const vx = pts[k][0] - pts[k - 1][0];
      const vy = pts[k][1] - pts[k - 1][1];
      if (vx !== dx || vy !== dy) posFrames.push([at(k), translate(pts[k][0], pts[k][1])]);
    }
  }
  if (runStart >= 0) walkRuns.push([runStart, path.length - 1]);
  const endTick = path.length - 1;
  posFrames.push([at(endTick), translate(pts[endTick][0], pts[endTick][1])]);
  const hide = fadeEnd - 0.2;
  posFrames.push([hide, translate(pts[endTick][0], pts[endTick][1])], [hide, translate(start[0], start[1])], [duration, translate(start[0], start[1])]);
  const posCls = tl.track(posFrames);
  const faceCls = tl.track([...faceFrames, [hide, faceFrames[faceFrames.length - 1][1]], [hide, face(0, 1)]]);
  const walkFrames = [[0, "opacity:0"]];
  const standFrames = [[0, "opacity:1"]];
  for (const [a, b] of walkRuns) {
    walkFrames.push([at(a), "opacity:0"], [at(a), "opacity:1"], [at(b), "opacity:1"], [at(b), "opacity:0"]);
    standFrames.push([at(a), "opacity:1"], [at(a), "opacity:0"], [at(b), "opacity:0"], [at(b), "opacity:1"]);
  }
  const walkCls = tl.track(walkFrames);
  const standCls = tl.track(standFrames);
  const fadeCls = tl.track([
    [0, "opacity:1"],
    [restore + 0.1, "opacity:1"],
    [hide, "opacity:0"],
    [duration - 0.45, "opacity:0"],
    [duration - 0.1, "opacity:1"]
  ]);
  const cheer = PACE.intro + play + 0.1;
  const hop = [[0, "transform:translateY(0px)"], [cheer, "transform:translateY(0px)"]];
  for (let k = 0; k < 3; k++) {
    const t = cheer + k * 0.4;
    hop.push([t + 0.2, "transform:translateY(-6px)"], [t + 0.4, "transform:translateY(0px)"]);
  }
  const hopCls = tl.track(hasPlay ? hop : [[0, "transform:translateY(0px)"]]);
  const armsUp = tl.track(hasPlay ? [[0, "opacity:0"], [cheer, "opacity:0"], [cheer, "opacity:1"], [restore, "opacity:1"], [restore + 0.05, "opacity:0"]] : [[0, "opacity:0"]]);
  const armsDown = tl.track(hasPlay ? [[0, "opacity:1"], [cheer, "opacity:1"], [cheer, "opacity:0"], [restore, "opacity:0"], [restore + 0.05, "opacity:1"]] : [[0, "opacity:1"]]);
  const clears = sim.breaks.map((b) => ({ t: at(b.tick), cell: b.cell }));
  const hudMarkup = hud(tl, grid, { theme, title: "BOMBERMAN", clears, resetAt: restore, width: layout.width });
  const gridCy = layout.top + layout.gridHeight / 2;
  const endCard = banner(tl, { theme, lines: stageClearLines(grid), cx: layout.width / 2, cy: gridCy, from: PACE.intro + play + 0.2, to: restore });
  const walkPeriod = fmt(dt * 2);
  const css = [
    ".c{transform-box:fill-box;transform-origin:center}",
    ".pulse{transform-box:fill-box;transform-origin:center;animation:pulse .4s ease-in-out infinite}",
    "@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}",
    ".spark{transform-box:fill-box;transform-origin:center;animation:spark .22s steps(1) infinite}",
    "@keyframes spark{0%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}",
    ".bob{animation:bob 1s ease-in-out infinite}",
    "@keyframes bob{0%,100%{transform:translateY(-1.2px)}50%{transform:translateY(1.2px)}}",
    `.fa{animation:fa ${walkPeriod}s steps(1) infinite}.fb{animation:fb ${walkPeriod}s steps(1) infinite}`,
    "@keyframes fa{0%{transform:translateY(-1.6px)}50%{transform:translateY(0)}}",
    "@keyframes fb{0%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}",
    ".nod{animation:nod .9s ease-in-out infinite}",
    "@keyframes nod{0%,100%{transform:translate(0,0)}50%{transform:translate(.8px,-.6px)}}",
    tl.css()
  ].join("\n");
  const sprite2 = bomberSprite(theme, { standCls, walkCls, faceCls, armsUp, armsDown });
  const body = [
    `<g>${floor.join("")}</g>`,
    `<g>${tiles.join("")}</g>`,
    `<g>${blocks.join("")}</g>`,
    `<g${glowAttr(theme)}>${items.join("")}</g>`,
    `<g${glowAttr(theme)}>${bombs.join("")}</g>`,
    `<g${glowAttr(theme)}>${blasts.join("")}</g>`,
    `<g>${debris.join("")}</g>`,
    `<g${glowAttr(theme)}>${bigRings.join("")}${itemRings.join("")}</g>`,
    `<g class="${posCls}"><g class="${fadeCls}"><g class="${hopCls}"${glowAttr(theme)}>${sprite2}</g></g></g>`,
    popups.join(""),
    hudMarkup,
    endCard
  ].join("\n");
  return { width: layout.width, height: layout.height, css, defs: defs.join(""), body };
}
function faceCss(dir) {
  switch (dir) {
    case "l":
      return face(-2.2, 1);
    case "r":
      return face(2.2, 1);
    case "u":
      return face(0, 0);
    default:
      return face(0, 1);
  }
}
function face(x, visible) {
  return `transform:translate(${fmt(x)}px,0px);opacity:${visible}`;
}
function crossShape(arms, half, pitch, fill, extra) {
  const [u, d, l, r] = arms;
  const h = `<rect x="${fmt(-(l * pitch + half))}" y="${fmt(-half)}" width="${fmt((l + r) * pitch + 2 * half)}" height="${fmt(2 * half)}" rx="${fmt(half * 0.85)}" fill="${fill}"${extra}/>`;
  const v = `<rect x="${fmt(-half)}" y="${fmt(-(u * pitch + half))}" width="${fmt(2 * half)}" height="${fmt((u + d) * pitch + 2 * half)}" ry="${fmt(half * 0.85)}" rx="${fmt(half * 0.85)}" fill="${fill}"${extra}/>`;
  const c = `<circle r="${fmt(half * 1.45)}" fill="${fill}"${extra}/>`;
  return h + v + c;
}
function bombShape(pal) {
  return `<circle cx="0" cy="1.2" r="5.8" fill="${pal.bombBody}" stroke="${pal.bombRim}" stroke-width="1"/><ellipse cx="-2" cy="-.6" rx="1.7" ry="1.1" fill="#fff" opacity=".75" transform="rotate(-30 -2 -.6)"/><rect x="-1.5" y="-6.1" width="3" height="2.2" rx=".6" fill="${pal.bombRim}"/><path d="M0-6.1Q1.6-8.4 3.4-8" stroke="${pal.fuse}" stroke-width="1.3" fill="none" stroke-linecap="round"/><g class="spark"><circle cx="4" cy="-8.2" r="2" fill="${pal.spark}"/><circle cx="4" cy="-8.2" r="0.9" fill="#fff"/></g>`;
}
function powerIcon(kind, pal) {
  const panel = kind === "fire" ? "#e8461e" : "#2f6bff";
  const icon = kind === "fire" ? `<path d="M0-4.4C1.2-2.6 3.2-1.6 3.2 1A3.2 3.2 0 0 1-3.2 1C-3.2-.4-2.4-1.4-1.6-2.2 -1.4-1-.8-.6-.4-.6-.8-2.2-.6-3.4 0-4.4Z" fill="${pal.flameMid}"/><path d="M0-.6C.8 0 1.6.8 1.6 1.8A1.6 1.6 0 0 1-1.6 1.8C-1.6 1-.9.4 0-.6Z" fill="#fff"/>` : `<circle cx="-.4" cy="1" r="3" fill="#10142a"/><circle cx="-1.4" cy="0" r=".9" fill="#fff" opacity=".8"/><path d="M.8-1.6Q2.2-3.4 3.6-3" stroke="#fff" stroke-width="1" fill="none" stroke-linecap="round"/><circle cx="3.9" cy="-3.1" r="1" fill="${pal.spark}"/>`;
  return `<rect x="-7" y="-7" width="14" height="14" rx="3" fill="${panel}" stroke="#fff" stroke-width="1.4"/>${icon}`;
}
function bomberSprite(theme, t) {
  const o = OUTLINE;
  const dark = isDark(theme);
  const shadow = `<ellipse cx="0" cy="8.6" rx="6.4" ry="1.9" fill="#000" opacity="${dark ? 0.45 : 0.22}"/>`;
  const foot = (x, cls) => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="5.6" width="4.4" height="3" rx="1.2" fill="#f4f7ff" stroke="${o}" stroke-width=".9"/>`;
  const hand = (x, y, cls) => `<circle${cls ? ` class="${cls}"` : ""} cx="${x}" cy="${y}" r="1.9" fill="#ff8fc0" stroke="${o}" stroke-width=".9"/>`;
  const feetStand = `<g class="${t.standCls}">${foot(-5)}${foot(0.6)}</g>`;
  const feetWalk = `<g class="${t.walkCls}">${foot(-5, "fa")}${foot(0.6, "fb")}</g>`;
  const handsDown = `<g class="${t.armsDown}"><g class="${t.standCls}">${hand(-6.5, 3)}${hand(6.5, 3)}</g><g class="${t.walkCls}">${hand(-6.5, 3, "fb")}${hand(6.5, 3, "fa")}</g></g>`;
  const handsUp = `<g class="${t.armsUp}">${hand(-7, -3.5)}${hand(7, -3.5)}</g>`;
  const body = `<rect x="-4.7" y=".4" width="9.4" height="6.4" rx="2.2" fill="#3b6cff" stroke="${o}" stroke-width="1.1"/><rect x="-2" y="2" width="4" height="1.5" rx=".7" fill="#9db8ff"/>`;
  const helmet = `<circle cx="0" cy="-5.6" r="6.9" fill="#fafcff" stroke="${o}" stroke-width="1.3"/><path d="M-4.6-9.6A6 6 0 0 1 .6-11.6" stroke="#c8d3ee" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  const faceParts = `<g class="${t.faceCls}"><ellipse cx="0" cy="-4.8" rx="4.4" ry="3.5" fill="#ffd9bd" stroke="${o}" stroke-width=".8"/><rect x="-2.6" y="-6.2" width="1.4" height="2.6" rx=".6" fill="${o}"/><rect x="1.2" y="-6.2" width="1.4" height="2.6" rx=".6" fill="${o}"/></g>`;
  const antenna = `<path d="M0-12.2V-10.6" stroke="${o}" stroke-width="1.3"/><g class="nod"><circle cx="0" cy="-13" r="2" fill="#ff6fae" stroke="${o}" stroke-width=".9"/></g>`;
  return `${shadow}${feetStand}${feetWalk}${body}${handsDown}${handsUp}${helmet}${faceParts}${antenna}`;
}
var bomberman = { id: "bomberman", title: "Bomberman", render };

// src/games/breakout.ts
var BALL_R = 4;
var PADDLE_HALF = 30;
var PADDLE_H = 8;
var VOID = 40;
var MAX_TILT = 56 * Math.PI / 180;
var MIN_VERTICAL = 0.5;
var FIRE_SHARE = 0.35;
var SIM_SPEED = 600;
var SIM_DT = 1 / 720;
var TARGET_PLAY2 = 36;
var MIN_SPEED = 330;
var MAX_SPEED = 800;
var RAMP_FROM = 0.8;
var RAMP_TO = 1.3;
var RUSH_FROM = 0.7;
var RUSH_EXTRA = 1.6;
var RUSH_CAP = 1250;
var WALL = 1;
var PADDLE = 2;
function makeCourt(grid, layout) {
  const fieldL = layout.left - 8;
  const fieldR = layout.left + layout.gridWidth + 8;
  return {
    cols: grid.width,
    rows: grid.height,
    left: layout.left,
    top: layout.top,
    pitch: layout.pitch,
    cell: layout.cell,
    fieldL,
    fieldR,
    fieldT: layout.top - 8,
    padTop: layout.top + layout.gridHeight + VOID,
    startX: Math.round((fieldL + fieldR) / 2)
  };
}
function simulateBreakout(grid, layout, rng) {
  const court = makeCourt(grid, layout);
  const { rows, left, top, pitch, cell, fieldL, fieldR, fieldT, padTop } = court;
  const cells = activeCells(grid);
  const hp = new Uint8Array(grid.width * rows);
  const ghost = new Int32Array(grid.width * rows);
  for (const c of cells) hp[c.x * rows + c.y] = c.level >= 3 ? 2 : 1;
  const byIndex = new Map(cells.map((c) => [c.x * rows + c.y, c]));
  const play = { court, hits: [], ball: [], contacts: [], fire: null, length: 0 };
  const startY = padTop - BALL_R;
  if (cells.length === 0) {
    play.ball.push([0, court.startX, startY]);
    return play;
  }
  let alive = cells.length;
  const fireBelow = alive >= 2 ? Math.max(1, Math.floor(alive * FIRE_SHARE)) : 0;
  let flame = false;
  let stamp = -1;
  const touched = [];
  function advance(b, burning, virtual) {
    touched.length = 0;
    let flags = 0;
    const px = b.x;
    const py = b.y;
    b.x += b.vx * SIM_DT;
    b.y += b.vy * SIM_DT;
    if (b.x < fieldL + BALL_R) {
      b.x = fieldL + BALL_R;
      b.vx = Math.abs(b.vx);
      flags |= WALL;
    } else if (b.x > fieldR - BALL_R) {
      b.x = fieldR - BALL_R;
      b.vx = -Math.abs(b.vx);
      flags |= WALL;
    }
    if (b.y < fieldT + BALL_R) {
      b.y = fieldT + BALL_R;
      b.vy = Math.abs(b.vy);
      flags |= WALL;
    }
    const c0 = Math.max(0, Math.floor((b.x - BALL_R - left) / pitch));
    const c1 = Math.min(court.cols - 1, Math.floor((b.x + BALL_R - left) / pitch));
    const r0 = Math.max(0, Math.floor((b.y - BALL_R - top) / pitch));
    const r1 = Math.min(rows - 1, Math.floor((b.y + BALL_R - top) / pitch));
    let signX = 0;
    let signY = 0;
    let conflict = false;
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const idx = c * rows + r;
        if (hp[idx] === 0 || ghost[idx] === stamp) continue;
        const bx0 = left + c * pitch;
        const by0 = top + r * pitch;
        const dx = b.x - Math.min(Math.max(b.x, bx0), bx0 + cell);
        const dy = b.y - Math.min(Math.max(b.y, by0), by0 + cell);
        if (dx * dx + dy * dy >= BALL_R * BALL_R) continue;
        touched.push(idx);
        if (burning) {
          if (virtual) ghost[idx] = stamp;
          continue;
        }
        const outX = px < bx0 || px > bx0 + cell;
        const outY = py < by0 || py > by0 + cell;
        const sideHit = outX && !outY ? true : outY && !outX ? false : Math.abs(dx) > Math.abs(dy);
        if (sideHit) {
          const s = px < bx0 ? -1 : px > bx0 + cell ? 1 : dx >= 0 ? 1 : -1;
          if (signX !== 0 && signX !== s) conflict = true;
          signX = s;
          b.x = s < 0 ? bx0 - BALL_R : bx0 + cell + BALL_R;
        } else {
          const s = py < by0 ? -1 : py > by0 + cell ? 1 : dy >= 0 ? 1 : -1;
          if (signY !== 0 && signY !== s) conflict = true;
          signY = s;
          b.y = s < 0 ? by0 - BALL_R : by0 + cell + BALL_R;
        }
      }
    }
    if (touched.length > 0 && !burning) {
      if (conflict) {
        b.x = px;
        b.y = py;
        b.vx = -b.vx;
        b.vy = -b.vy;
      } else {
        if (signX !== 0) b.vx = signX * Math.abs(b.vx);
        if (signY !== 0) b.vy = signY * Math.abs(b.vy);
      }
    }
    if (flags !== 0 || touched.length > 0 && !burning) keepSteep(b);
    if (b.vy > 0 && b.y + BALL_R >= padTop) flags |= PADDLE;
    return flags;
  }
  function keepSteep(b) {
    if (Math.abs(b.vy) >= MIN_VERTICAL * SIM_SPEED) return;
    b.vy = (b.vy < 0 ? -1 : 1) * MIN_VERTICAL * SIM_SPEED;
    b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(SIM_SPEED * SIM_SPEED - b.vy * b.vy);
  }
  function launch(b, off) {
    const angle = off * MAX_TILT;
    b.vx = SIM_SPEED * Math.sin(angle);
    b.vy = -SIM_SPEED * Math.cos(angle);
  }
  function evaluate(bx, off) {
    stamp++;
    const b = { x: bx, y: startY, vx: 0, vy: 0 };
    launch(b, off);
    let destroyed = 0;
    let hits = 0;
    const limit = Math.round(14 / SIM_DT);
    for (let n = 1; n <= limit; n++) {
      const flags = advance(b, flame, true);
      if (touched.length > 0) {
        if (flame) destroyed += touched.length;
        else hits += touched.length;
      }
      if (flags & PADDLE) {
        return { progress: flame ? destroyed > 0 : hits > 0, time: n * SIM_DT, nextX: b.x, destroyed, hits };
      }
    }
    return { progress: false, time: 14, nextX: b.x, destroyed, hits };
  }
  const coarse = Array.from({ length: 81 }, (_, i) => -0.85 + i * 0.02125);
  const fine = Array.from({ length: 161 }, (_, i) => -0.85 + i * 0.010625);
  let paddleX = court.startX;
  let lastContact = 0;
  const excess = (speed) => Math.max(0, speed / SIM_SPEED - 0.6);
  function plan(t, bx, first) {
    for (const offsets of [coarse, fine]) {
      let best = null;
      let bestScore = Infinity;
      for (const off2 of offsets) {
        const px = first ? court.startX : bx - off2 * PADDLE_HALF;
        if (px < fieldL + PADDLE_HALF || px > fieldR - PADDLE_HALF) continue;
        const o = evaluate(bx, off2);
        if (!o.progress) continue;
        const now = first ? 0 : Math.abs(px - paddleX) / Math.max(t - lastContact - 0.06, 0.04);
        const next = Math.max(0, Math.abs(o.nextX - px) - 0.7 * PADDLE_HALF) / Math.max(o.time - 0.06, 0.05);
        let score = 3 * excess(now) + 3 * excess(next) + rng() * 0.1;
        score += o.time / Math.max(1, flame ? o.destroyed : o.hits);
        if (Math.abs(off2) < 0.12) score += 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = { off: off2, px };
        }
      }
      if (best) return best;
    }
    const off = (rng() - 0.5) * 1.4;
    return { off, px: Math.min(Math.max(first ? court.startX : bx - off * PADDLE_HALF, fieldL + PADDLE_HALF), fieldR - PADDLE_HALF) };
  }
  const ball = { x: court.startX, y: startY, vx: 0, vy: 0 };
  play.ball.push([0, ball.x, ball.y]);
  const serve = plan(0, ball.x, true);
  play.contacts.push({ t: 0, x: court.startX });
  launch(ball, serve.off);
  const maxSteps = Math.round(900 / SIM_DT);
  for (let step = 1; step <= maxSteps; step++) {
    const t = step * SIM_DT;
    const flags = advance(ball, flame, false);
    let event = (flags & WALL) !== 0;
    if (touched.length > 0) {
      for (const idx of touched) {
        const cellHit = byIndex.get(idx);
        const final = flame || hp[idx] === 1;
        hp[idx] = flame ? 0 : hp[idx] - 1;
        if (final) alive--;
        play.hits.push({ cell: cellHit, t, final });
      }
      if (!flame) event = true;
      if (!flame && alive > 0 && alive <= fireBelow) {
        flame = true;
        play.fire = { t, x: ball.x, y: ball.y };
      }
    }
    if (flags & PADDLE) {
      ball.y = startY;
      play.ball.push([t, ball.x, ball.y]);
      if (alive === 0) {
        const px = Math.min(Math.max(paddleX, ball.x - 0.6 * PADDLE_HALF), ball.x + 0.6 * PADDLE_HALF);
        play.contacts.push({ t, x: Math.min(Math.max(px, fieldL + PADDLE_HALF), fieldR - PADDLE_HALF) });
        play.length = t;
        return play;
      }
      const next = plan(t, ball.x, false);
      play.contacts.push({ t, x: next.px });
      paddleX = next.px;
      lastContact = t;
      launch(ball, next.off);
    } else if (event) {
      play.ball.push([t, ball.x, ball.y]);
    }
  }
  throw new Error("Breakout did not finish");
}
function pacePlay(sim) {
  if (sim.hits.length === 0) return { at: (t) => t, length: 2, speeds: [SIM_SPEED, SIM_SPEED] };
  const total = sim.hits.filter((h) => h.final).length;
  const breaks = sim.contacts.map((c) => c.t);
  const raw = breaks.map((t) => {
    const done = sim.hits.filter((h) => h.final && h.t <= t).length / total;
    const rush = Math.max(0, (done - RUSH_FROM) / (1 - RUSH_FROM)) ** 1.5;
    return RAMP_FROM + (RAMP_TO - RAMP_FROM) * done + RUSH_EXTRA * rush;
  });
  let base = SIM_SPEED;
  let factors = raw;
  for (let pass = 0; pass < 3; pass++) {
    factors = raw.map((f) => Math.min(f, RUSH_CAP / base));
    const sum = [0];
    for (let i = 1; i < breaks.length; i++) sum.push(sum[i - 1] + (breaks[i] - breaks[i - 1]) / factors[i - 1]);
    base = Math.min(MAX_SPEED, Math.max(MIN_SPEED, SIM_SPEED * sum[sum.length - 1] / TARGET_PLAY2));
  }
  factors = raw.map((f) => Math.min(f, RUSH_CAP / base));
  const unscaled = [0];
  for (let i = 1; i < breaks.length; i++) unscaled.push(unscaled[i - 1] + (breaks[i] - breaks[i - 1]) / factors[i - 1]);
  const stretch = SIM_SPEED / base;
  const at = (t) => {
    let lo = 0;
    let hi = breaks.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (breaks[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const f = factors[Math.min(lo, factors.length - 1)];
    return (unscaled[lo] + (t - breaks[lo]) / f) * stretch;
  };
  return { at, length: at(sim.length), speeds: [base * factors[0], base * factors[factors.length - 1]] };
}
var FLASH_TIME = 0.08;
var CHIP_LIFE = 0.6;
var CHIP_GRAVITY = 300;
var EMBERS = ["#ffd23f", "#ff9a2a"];
var CHIPS = [
  { vx: -34, vy: -66, size: 4.8, spin: -260, spark: false },
  { vx: 38, vy: -72, size: 4.8, spin: 300, spark: false },
  { vx: -56, vy: -24, size: 5, spin: -180, spark: false },
  { vx: 58, vy: -28, size: 5, spin: 220, spark: false },
  { vx: -16, vy: -90, size: 4.2, spin: 340, spark: false },
  { vx: 20, vy: -84, size: 4.2, spin: -320, spark: false },
  { vx: -44, vy: -48, size: 2.8, spin: 0, spark: true },
  { vx: 46, vy: -54, size: 2.8, spin: 0, spark: true }
];
function chipFrames(c) {
  const steps = 7;
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const u = k / steps * CHIP_LIFE;
    const fade = Math.min(1, (CHIP_LIFE - u) / (CHIP_LIFE * 0.5));
    const x = c.vx * u;
    const y = c.vy * u + 0.5 * CHIP_GRAVITY * u * u;
    out.push([u, `opacity:${fmt(fade)};transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(c.spin * u)}deg) scale(${fmt(0.55 + 0.45 * fade)})`]);
  }
  return out;
}
var CRACKS = [
  [[7, 0], [4.5, 4], [7.5, 6.5], [4, 9], [6, 12]],
  [[3, 0], [6, 3.5], [4, 6], [8, 8.5], [7, 12]],
  [[9, 0], [6, 3], [8.5, 6], [5, 8.5], [3.5, 12]]
];
function smoothGlide(t0, x0, t1, x1) {
  const out = [[t0, x0]];
  if (t1 - t0 > 0.22 && x0 !== x1) {
    for (const f of [0.25, 0.5, 0.75]) {
      const e = f * f * (3 - 2 * f);
      out.push([t0 + (t1 - t0) * f, x0 + (x1 - x0) * e]);
    }
  }
  out.push([t1, x1]);
  return out;
}
var state = (fill, opacity, scale) => `fill:${fill};opacity:${opacity};transform:scale(${scale})`;
function flashColor(theme) {
  return theme.glow > 0 ? "#ffffff" : theme.accent;
}
function render2(ctx) {
  const { grid, theme, rng } = ctx;
  const layout = arcadeLayout(grid);
  const sim = simulateBreakout(grid, layout, rng);
  const { court } = sim;
  const pace = pacePlay(sim);
  const play = pace.length;
  const duration = loopDuration(play);
  const back = restoreAt(play);
  const intro = PACE.intro;
  const at = (t) => intro + pace.at(t);
  const tl = new Timeline(duration, "b");
  const startY = court.padTop - BALL_R;
  const empty = sim.hits.length === 0;
  const glow = glowAttr(theme);
  const flash = flashColor(theme);
  const gridCx = layout.left + layout.gridWidth / 2;
  const gridCy = layout.top + layout.gridHeight / 2;
  const wallBottom = court.padTop + PADDLE_H + 4;
  const parts = [];
  parts.push(
    `<path d="M${court.fieldL - 1.5} ${wallBottom}V${court.fieldT - 1.5}H${court.fieldR + 1.5}V${wallBottom}" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linejoin="round"${glow}/>`,
    `<path d="M${court.fieldL + 1.5} ${wallBottom}V${court.fieldT + 1.5}H${court.fieldR - 1.5}V${wallBottom}" fill="none" stroke="${theme.ink}" stroke-opacity=".28" stroke-width="1"/>`
  );
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));
  const hitsByCell = /* @__PURE__ */ new Map();
  for (const h of sim.hits) {
    const list = hitsByCell.get(h.cell) ?? [];
    list.push(h);
    hitsByCell.set(h.cell, list);
  }
  const chipNames = CHIPS.map((c) => tl.keyframes(chipFrames(c)));
  const chipCss = chipNames.map((name, i) => `.c${i}{animation:${name} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`);
  const ringName = tl.keyframes([
    [0, "opacity:.9;transform:scale(.4)"],
    [0.35, "opacity:0;transform:scale(2.8)"]
  ]);
  const bigRingName = tl.keyframes([
    [0, "opacity:1;transform:scale(.3)"],
    [0.7, "opacity:0;transform:scale(9)"]
  ]);
  const delayFor = (t) => `--d:${fmt(-(duration - t))}s`;
  const cracks = [];
  const pops = [];
  const clears = [];
  for (const cell of activeCells(grid)) {
    const hits = hitsByCell.get(cell) ?? [];
    const top = levelColor(theme, cell);
    const worn = levelColor(theme, { ...cell, level: cell.level - 1 });
    const frames2 = [[0, state(top, 1, 1)]];
    let last = top;
    let crackAt = -1;
    for (const h of hits) {
      const t = at(h.t);
      if (!h.final) {
        frames2.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + FLASH_TIME, state(worn, 1, 1)]);
        last = worn;
        crackAt = t;
      } else {
        frames2.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + 0.06, state(flash, 1, 1.25)], [t + 0.061, state(flash, 0, 1.25)]);
        clears.push({ t, cell });
        const cx = layout.left + cell.x * layout.pitch + layout.cell / 2;
        const cy = layout.top + cell.y * layout.pitch + layout.cell / 2;
        const burning = sim.fire !== null && h.t >= sim.fire.t;
        const base = burning ? EMBERS[1] : spriteColor(theme, { level: Math.min(4, cell.level + 1) });
        const spark = burning ? EMBERS[0] : flash;
        const chips = CHIPS.map((c, i) => {
          const s = c.size;
          return `<rect class="p c${i}"${c.spark ? ` fill="${spark}"` : ""} x="${fmt(-s / 2)}" y="${fmt(-s / 2)}" width="${s}" height="${s}"/>`;
        }).join("");
        pops.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})" fill="${base}" style="${delayFor(t + 0.06)}">${chips}</g>`);
        if (crackAt >= 0 && t > crackAt + FLASH_TIME + 0.02) {
          const [ox, oy] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
          const d = CRACKS[(cell.x + cell.y * 2) % CRACKS.length].map(([x, y], i) => `${i ? "L" : "M"}${fmt(ox + x)} ${fmt(oy + y)}`).join("");
          const cls = tl.track([[0, "opacity:0"], [crackAt + FLASH_TIME, "opacity:0"], [crackAt + FLASH_TIME + 1e-3, "opacity:1"], [t, "opacity:1"], [t + 1e-3, "opacity:0"]]);
          cracks.push(`<path class="${cls}" d="${d}" fill="none" stroke="${theme.surface}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
      }
    }
    frames2.push([back, state(top, 0, 1)], [back + PACE.restore, state(top, 1, 1)]);
    parts.push(cellRect(layout, cell, top, `class="b ${tl.track(frames2)}"`));
  }
  parts.push(...cracks, ...pops);
  const lastHit = sim.hits.length ? sim.hits[sim.hits.length - 1] : null;
  if (lastHit) {
    const t = at(lastHit.t);
    const cx = layout.left + lastHit.cell.x * layout.pitch + layout.cell / 2;
    const cy = layout.top + lastHit.cell.y * layout.pitch + layout.cell / 2;
    parts.push(`<circle class="p bring" cx="${fmt(cx)}" cy="${fmt(cy)}" r="6" fill="none" stroke="${flash}" stroke-width="2" style="${delayFor(t)}"/>`);
    const surge = tl.track([[0, "opacity:0"], [t, "opacity:0"], [t + 1e-3, "opacity:.16"], [t + 0.28, "opacity:0"]]);
    parts.push(
      `<rect class="${surge}" x="${fmt(layout.left)}" y="${fmt(layout.top)}" width="${fmt(layout.gridWidth)}" height="${fmt(layout.gridHeight)}" fill="${flash}"/>`
    );
  }
  const ringCss = [
    `.pr{animation:${ringName} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`,
    `.bring{animation:${bigRingName} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`
  ];
  const padRings = [];
  for (const [t, x, y] of sim.ball.slice(1)) {
    if (y !== startY) continue;
    padRings.push(`<ellipse class="p pr" cx="${fmt(x)}" cy="${fmt(court.padTop)}" rx="7" ry="1.6" fill="none" stroke="${theme.accent}" stroke-width="1.5" style="${delayFor(at(t))}"/>`);
  }
  const paddleFrames = [];
  const pos = (x) => translate(x, court.padTop);
  let cur = { t: 0, x: court.startX };
  paddleFrames.push([0, pos(cur.x)]);
  const squash = [[0, "transform:scale(1,1)"]];
  let lastSquashEnd = 0;
  sim.contacts.forEach((c, i) => {
    const t = i === 0 ? intro : at(c.t);
    const arrive = Math.max(cur.t, t - 0.015);
    const hold = Math.min(0.1, (arrive - cur.t) * 0.35);
    paddleFrames.push([cur.t + hold, pos(cur.x)]);
    for (const [gt, gx] of smoothGlide(cur.t + hold, cur.x, arrive, c.x)) paddleFrames.push([gt, pos(gx)]);
    paddleFrames.push([t, pos(c.x)]);
    cur = { t, x: c.x };
    if (i > 0) {
      const next = sim.contacts[i + 1] ? at(sim.contacts[i + 1].t) : t + 0.2;
      const start = Math.max(t - 0.012, lastSquashEnd + 1e-3);
      const end = Math.min(t + 0.14, next - 0.015);
      if (end > t) {
        squash.push([start, "transform:scale(1,1)"], [t, "transform:scale(1.07,.6)"], [end, "transform:scale(1,1)"]);
        lastSquashEnd = end;
      }
    }
  });
  const parkT = empty ? intro : at(sim.length);
  const returnEnd = duration - 0.1;
  paddleFrames.push([back, pos(cur.x)]);
  const ballPos = (x, y) => translate(x, y);
  const ballFrames = [[0, ballPos(court.startX, startY)], [intro, ballPos(court.startX, startY)]];
  for (const [t, x, y] of sim.ball.slice(1)) ballFrames.push([at(t), ballPos(x, y)]);
  const ballEnd = sim.ball[sim.ball.length - 1];
  ballFrames.push([back, ballPos(ballEnd[1], ballEnd[2])]);
  for (const [gt, gx] of smoothGlide(back, cur.x, returnEnd, court.startX)) paddleFrames.push([gt, pos(gx)]);
  for (const [gt, gx] of smoothGlide(back, empty ? court.startX : ballEnd[1], returnEnd, court.startX)) {
    ballFrames.push([gt, ballPos(gx, startY)]);
  }
  paddleFrames.push([duration, pos(court.startX)]);
  ballFrames.push([duration, ballPos(court.startX, startY)]);
  parts.push(...padRings);
  const padRaw = tl.track(paddleFrames);
  const padSquash = tl.track(squash, "linear");
  const padW = PADDLE_HALF * 2;
  parts.push(
    `<g class="${padRaw}"><g class="sq ${padSquash}"><g${glow}><rect x="${-PADDLE_HALF - 3}" y="-3" width="${padW + 6}" height="${PADDLE_H + 6}" rx="${PADDLE_H / 2 + 3}" fill="${theme.accent}" opacity=".24"/><rect x="${-PADDLE_HALF}" y="0" width="${padW}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.ink}"/><rect x="${-PADDLE_HALF}" y="0" width="9" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.accent}"/><rect x="${PADDLE_HALF - 9}" y="0" width="9" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.accent}"/><rect x="${-PADDLE_HALF + 10}" y="1.5" width="${padW - 20}" height="1.8" rx=".9" fill="${theme.surface}" opacity=".45"/></g></g></g>`
  );
  const ballKeys = tl.keyframes(ballFrames);
  const ghosts = (sizes, lags, colors, opacities) => sizes.map((s, i) => {
    const cls = tl.useKeyframes(ballKeys, lags[i]);
    return `<circle class="${cls}" r="${fmt(s / 2)}" fill="${colors[i]}" opacity="${opacities[i]}"/>`;
  }).join("");
  const bare = (inner) => `<g class="${tl.useKeyframes(ballKeys, 0)}"><g${glow}>${inner}</g></g>`;
  const trailOff = tl.track([[0, "opacity:1"], [back, "opacity:1"], [back + 1e-3, "opacity:0"], [duration - 1e-3, "opacity:0"]]);
  const plain = `<g class="${trailOff}">${ghosts([7.2, 6.4, 5.6, 4.6, 3.6], [0.011, 0.022, 0.034, 0.048, 0.064], Array(5).fill(theme.accent), [0.6, 0.45, 0.32, 0.2, 0.1])}</g>` + bare(
    `<circle r="8" fill="${theme.accent}" opacity=".3"/><circle r="${BALL_R}" fill="${theme.ink}"/>`
  );
  if (sim.fire) {
    const f = sim.fire;
    const ft = at(f.t);
    parts.push(`<g class="${tl.track([[0, "opacity:1"], [ft, "opacity:1"], [ft + 1e-3, "opacity:0"], [parkT, "opacity:0"], [parkT + 1e-3, "opacity:1"]])}">${plain}</g>`);
    const embers = ["#ffd23f", "#ffa51f", "#ff7a1a", "#ff5a1a", "#e8321a", "#c2241a"];
    const flameGhosts = ghosts(
      [9, 8.2, 7.4, 6.4, 5.2, 4],
      [0.01, 0.02, 0.032, 0.046, 0.062, 0.08],
      embers,
      [0.95, 0.85, 0.7, 0.55, 0.4, 0.25]
    );
    const core = `<circle r="9" fill="#ff7a1a" opacity=".3"/><circle r="4.6" fill="#ff6a1a"/><circle r="2.4" fill="#fff0a8"/>`;
    parts.push(
      `<g class="${tl.track([[0, "opacity:0"], [ft, "opacity:0"], [ft + 1e-3, "opacity:1"], [parkT, "opacity:1"], [parkT + 1e-3, "opacity:0"]])}"><g class="${trailOff}">${flameGhosts}</g>${bare(core)}</g>`
    );
    const ring = tl.track([
      [ft, "opacity:0;transform:scale(.4)"],
      [ft + 1e-3, "opacity:1;transform:scale(.6)"],
      [ft + 0.45, "opacity:0;transform:scale(5.5)"]
    ]);
    parts.push(`<circle class="p ring ${ring}" cx="${fmt(f.x)}" cy="${fmt(f.y)}" r="4" fill="none" stroke="#ff7a1a" stroke-width="2"/>`);
  } else {
    parts.push(plain);
  }
  if (!empty) {
    parts.push(banner(tl, { theme, lines: stageClearLines(grid), cx: gridCx, cy: gridCy, from: parkT + 0.1, to: back - 0.05 }));
  }
  parts.push(hud(tl, grid, { theme, title: "BREAKOUT", clears, resetAt: back, width: layout.width }));
  const css = [
    ".b,.p,.sq,.ring{transform-box:fill-box;transform-origin:center}",
    ".sq{transform-origin:50% 100%}",
    ...chipCss,
    ...ringCss,
    tl.css()
  ].join("\n");
  return { width: layout.width, height: layout.height, css, defs: glowDefs(theme), body: parts.join("\n") };
}
var breakout = { id: "breakout", title: "Breakout", render: render2 };

// src/fx.ts
var Bursts = class {
  duration;
  prefix;
  rules = [];
  shapes = [];
  constructor(duration, prefix = "fx") {
    this.duration = duration;
    this.prefix = prefix;
  }
  define(id, shape) {
    const d = this.duration;
    const pct = (s) => Math.round(Math.min(s, d) / d * 1e6) / 1e4;
    const name = `${this.prefix}-${id}`;
    const rest = "opacity:0;transform:scale(1.12)";
    this.rules.push(
      `@keyframes ${name}{0%{opacity:1;transform:scale(.25);animation-timing-function:cubic-bezier(.1,.8,.3,1)}${pct(shape.life * 0.55)}%{opacity:1;transform:scale(.9);animation-timing-function:ease-in}${pct(shape.life)}%{${rest}}100%{${rest}}}.${name}{animation:${name} ${fmt(d)}s linear infinite}`
    );
    const parts = [];
    if (shape.flash) parts.push(`<circle r="${fmt(shape.flash)}" fill="${shape.flashColor ?? "#fff"}"/>`);
    if (shape.ring) {
      parts.push(`<circle r="${fmt(shape.ring)}" fill="none" stroke="currentColor" stroke-width="${shape.ringWidth ?? 1.6}"/>`);
    }
    for (const s of shape.sparks) {
      const fill = s.fill ?? "currentColor";
      parts.push(
        s.round ? `<circle cx="${fmt(s.dx)}" cy="${fmt(s.dy)}" r="${fmt(s.size / 2)}" fill="${fill}"/>` : `<rect x="${fmt(s.dx - s.size / 2)}" y="${fmt(s.dy - s.size / 2)}" width="${fmt(s.size)}" height="${fmt(s.size)}" fill="${fill}"/>`
      );
    }
    this.shapes.push(`<g id="${name}">${parts.join("")}</g>`);
  }
  /** Places a burst centred on (x, y) that fires at loop time `t`. */
  use(id, x, y, t, color) {
    const shift = (t % this.duration + this.duration) % this.duration;
    const delay = shift === 0 ? "0s" : `-${fmt(Math.round((this.duration - shift) * 1e3) / 1e3)}s`;
    const name = `${this.prefix}-${id}`;
    return `<use class="${name}" href="#${name}" x="${fmt(x)}" y="${fmt(y)}" style="animation-delay:${delay};transform-origin:${fmt(x)}px ${fmt(y)}px;color:${color}"/>`;
  }
  defs() {
    return this.shapes.join("");
  }
  css() {
    return this.rules.join("\n");
  }
};
function radialSparks(count, reach, size, turn2 = 0) {
  return Array.from({ length: count }, (_, i) => {
    const a = turn2 + i / count * Math.PI * 2;
    const r = reach * (0.7 + 0.3 * (i * 7 % 5) / 4);
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, size: size * (i % 2 ? 0.8 : 1.1) };
  });
}

// src/games/centipede.ts
var TICK = 1 / 200;
var BULLET_SPEED2 = 1500;
var FIRE_GAP = 0.065;
var PLAYER_SPEED = 640;
var DECIDE_GAP = 0.05;
var STEP = 0.07;
var LANE_ROW = -1;
var BAND_TOP = 7;
var BAND_BOTTOM = 8;
var PLAYER_ROW = 9;
var MAX_HITS = [0, 1, 2, 3, 3];
var GONE = 3;
var BITE = [0, 3, 7];
var WAVES = [12, 8];
var GIVE_UP = 600;
function simplify(points) {
  const out = [];
  for (const p of points) {
    const n = out.length;
    if (n >= 1 && out[n - 1][0] === p[0] && out[n - 1][1] === p[1] && out[n - 1][2] === p[2]) continue;
    if (n >= 2) {
      const [a, b] = [out[n - 2], out[n - 1]];
      const dt1 = b[0] - a[0];
      const dt2 = p[0] - b[0];
      if (dt1 > 1e-9 && dt2 > 1e-9 && Math.abs((b[1] - a[1]) / dt1 - (p[1] - b[1]) / dt2) < 1e-3 && Math.abs((b[2] - a[2]) / dt1 - (p[2] - b[2]) / dt2) < 1e-3) {
        out[n - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}
function stateAfter(maxHits, hits) {
  if (hits >= maxHits) return GONE;
  return maxHits === 2 ? 2 : hits;
}
function simulateCentipede(grid, layout, rng) {
  const cols = grid.width;
  const xOf = (col) => layout.left + col * layout.pitch + layout.cell / 2;
  const yOf = (row) => layout.top + row * layout.pitch + layout.cell / 2;
  const half = layout.cell / 2;
  const fieldLeft = xOf(0);
  const fieldRight = xOf(cols - 1);
  const tipStart = yOf(PLAYER_ROW) - 9;
  const bulletTop = yOf(LANE_ROW) - 8;
  const colOf2 = (x) => Math.round((x - fieldLeft) / layout.pitch);
  const mushrooms = [];
  const at = /* @__PURE__ */ new Map();
  const keyOf = (col, row) => (col + 8) * 32 + row + 2;
  const mushAt = (col, row) => at.get(keyOf(col, row));
  const addMushroom = (col, row, level, day, t2) => {
    const m = {
      id: mushrooms.length,
      col,
      row,
      level,
      maxHits: MAX_HITS[level],
      hits: 0,
      born: t2,
      day,
      states: [],
      died: null
    };
    mushrooms.push(m);
    at.set(keyOf(col, row), m);
    return m;
  };
  for (const cell of activeCells(grid)) addMushroom(cell.x, cell.y, cell.level, cell, 0);
  const initialHits = Math.max(1, mushrooms.reduce((n, m) => n + m.maxHits, 0));
  let remainingDayHits = initialHits;
  const segments2 = [];
  let centipedes = [];
  const clears = [];
  const effects = [];
  const popups = [];
  const pests = [];
  const bullets = [];
  const finished = [];
  const player = [];
  const spawnCentipede = (length, fromLeft, t2) => {
    const h = fromLeft ? 1 : -1;
    const startCol = fromLeft ? -3 : cols + 2;
    const segs = [];
    for (let i = 0; i < length; i++) {
      const col = startCol - h * i;
      const seg = {
        id: segments2.length,
        rec: { col, row: LANE_ROW, h, dy: 1 },
        prev: { col, row: LANE_ROW },
        spawn: t2,
        died: null,
        way: [[t2, xOf(col), yOf(LANE_ROW)]],
        heads: i === 0 ? [{ t: t2, on: true, face: h }] : []
      };
      segments2.push(seg);
      segs.push(seg);
    }
    centipedes.push({ segs, stepT: STEP, stepStart: t2, nextStep: t2 + STEP });
  };
  const visual = (c, s, t2) => {
    const f = Math.min(1, Math.max(0, (t2 - c.stepStart) / c.stepT));
    const x0 = xOf(s.prev.col);
    const y0 = yOf(s.prev.row);
    return [x0 + (xOf(s.rec.col) - x0) * f, y0 + (yOf(s.rec.row) - y0) * f];
  };
  const insideX = (col) => col >= 0 && col < cols;
  const occupiedBySegment = (col, row) => centipedes.some((c) => c.segs.some((s) => s.died === null && s.rec.col === col && s.rec.row === row));
  const stepCentipede = (c, t2) => {
    const head = c.segs[0];
    const r = head.rec;
    const nc = r.col + r.h;
    let next = null;
    if (!insideX(r.col)) {
      if (!insideX(nc) || !mushAt(nc, r.row)) next = { ...r, col: nc };
    } else if (insideX(nc) && !mushAt(nc, r.row)) {
      next = { ...r, col: nc };
    } else {
      let dy = r.dy;
      if (dy > 0 && r.row >= BAND_BOTTOM) dy = -1;
      else if (dy < 0 && r.row <= BAND_TOP) dy = 1;
      const flipped = r.h * -1;
      if (!mushAt(r.col, r.row + dy)) next = { col: r.col, row: r.row + dy, h: flipped, dy };
      else if (insideX(r.col + flipped) && !mushAt(r.col + flipped, r.row)) next = { col: r.col + flipped, row: r.row, h: flipped, dy };
      else next = { col: r.col, row: r.row + dy, h: flipped, dy };
    }
    c.nextStep = t2 + c.stepT;
    if (!next) return;
    const old = c.segs.map((s) => ({ ...s.rec }));
    c.segs.forEach((s, i) => {
      s.prev = { col: s.rec.col, row: s.rec.row };
      s.rec = i === 0 ? next : { ...old[i - 1] };
      s.way.push([t2, xOf(s.prev.col), yOf(s.prev.row)], [t2 + c.stepT, xOf(s.rec.col), yOf(s.rec.row)]);
    });
    if (next.h !== r.h) head.heads.push({ t: t2 + c.stepT * 0.5, on: true, face: next.h });
    c.stepStart = t2;
  };
  let flea = null;
  let spider = null;
  const spiderY = (ts, t2) => yOf(BAND_BOTTOM) + Math.sin((t2 - ts) / 0.7 * Math.PI * 2) * 14;
  const SPIDER_SPEED = 240;
  const FLEA_SPEED = 250;
  const progress = () => 1 - remainingDayHits / initialHits;
  const pending = [
    { kind: "flea", at: 0.15 },
    { kind: "wave", at: 0.45 },
    { kind: "spider", at: 0.5 },
    { kind: "flea", at: 0.78 }
  ];
  let spiderDir = 1;
  let waveIndex = 0;
  let waveFromLeft = true;
  const spawnWave = (t2) => {
    spawnCentipede(WAVES[Math.min(waveIndex, WAVES.length - 1)], waveFromLeft, t2);
    waveIndex++;
    waveFromLeft = !waveFromLeft;
  };
  spawnWave(0);
  const killSegment = (c, i, t2) => {
    const s = c.segs[i];
    const [sx, sy] = visual(c, s, t2);
    s.died = t2;
    while (s.way.length && s.way[s.way.length - 1][0] > t2) s.way.pop();
    s.way.push([t2, sx, sy]);
    const rear = c.segs.slice(i + 1);
    c.segs = c.segs.slice(0, i);
    if (rear.length) {
      const r = rear[0].rec;
      rear[0].heads.push({ t: t2, on: true, face: r.h });
      centipedes.push({ segs: rear, stepT: c.stepT, stepStart: c.stepStart, nextStep: c.nextStep });
    }
    if (insideX(s.rec.col) && !mushAt(s.rec.col, s.rec.row)) {
      const m = addMushroom(s.rec.col, s.rec.row, 2 + Math.floor(rng() * 2), null, t2);
      m.states.push({ t: t2, state: 0 });
    }
    const last = rear.length === 0 && c.segs.length === 0 && centipedes.length === 1;
    effects.push({ t: t2, x: sx, y: sy, kind: last ? "big" : "segment", level: 0 });
  };
  const hitMushroom = (m, t2, y) => {
    m.hits++;
    const state2 = stateAfter(m.maxHits, m.hits);
    m.states.push({ t: t2, state: state2 });
    const x = xOf(m.col);
    if (m.day) remainingDayHits--;
    if (m.hits >= m.maxHits) {
      m.died = t2;
      at.delete(keyOf(m.col, m.row));
      if (m.day) clears.push({ t: t2, cell: m.day });
      effects.push({ t: t2, x, y: yOf(m.row), kind: "crumble", level: m.level });
    } else {
      effects.push({ t: t2, x, y, kind: "chip", level: m.level });
    }
  };
  const columnLoad = (col) => {
    let load = 0;
    for (let r = LANE_ROW; r <= PLAYER_ROW; r++) {
      const m = mushAt(col, r);
      if (m) load += m.maxHits - m.hits;
    }
    for (const c of centipedes) for (const s of c.segs) if (s.rec.col === col) load++;
    if (flea && colOf2(flea.x) === col) load++;
    for (const b of bullets) if (b.t1 === null && colOf2(b.x) === col) load--;
    return load;
  };
  let t = 0;
  let px = (fieldLeft + fieldRight) / 2;
  let sweep = 1;
  let target = null;
  let nextDecide = 0;
  let nextFire = 0.3;
  let end = 0;
  for (; ; ) {
    t += TICK;
    if (t > GIVE_UP) throw new Error("centipede did not finish");
    const rush = 1 + Math.max(0, t - 150) / 12;
    const alive = centipedes.filter((c) => c.segs.length > 0);
    centipedes = alive;
    const mushAlive = mushrooms.some((m) => m.died === null);
    const idle = alive.length === 0 && !mushAlive;
    const pestBusy = flea !== null || spider !== null;
    if (pending.length && (progress() >= pending[0].at || idle || alive.length === 0 && pending[0].kind === "wave")) {
      const next = pending[0];
      if (next.kind === "wave") {
        pending.shift();
        spawnWave(t);
      } else if (!pestBusy) {
        pending.shift();
        if (next.kind === "flea") {
          const col = Math.floor(rng() * cols);
          const pest = { kind: "flea", way: [], from: t, to: t, shot: false };
          pests.push(pest);
          flea = { x: xOf(col), y: yOf(LANE_ROW) - 12, pest, lastRow: LANE_ROW - 1 };
          pest.way.push([t, flea.x, flea.y]);
        } else {
          spiderDir = spiderDir * -1;
          const dir = spiderDir;
          const x0 = dir > 0 ? fieldLeft - 24 : fieldRight + 24;
          const pest = { kind: "spider", way: [], from: t, to: t, shot: false };
          pests.push(pest);
          spider = { ts: t, dir, x0, pest, x: x0, y: spiderY(t, t) };
          pest.way.push([t, x0, spider.y]);
        }
      }
    }
    for (const c of centipedes) {
      if (t >= c.nextStep) {
        const few = c.segs.length <= 3 || progress() > 0.85;
        c.stepT = few ? STEP * 0.78 : STEP;
        stepCentipede(c, t);
      }
    }
    if (flea) {
      flea.y += FLEA_SPEED * TICK;
      const row = Math.floor((flea.y - layout.top) / layout.pitch);
      if (row > flea.lastRow) {
        flea.lastRow = row;
        const col = colOf2(flea.x);
        if (row >= 0 && row < 7 && rng() < 0.32 && !mushAt(col, row) && !occupiedBySegment(col, row)) {
          const m = addMushroom(col, row, 2 + Math.floor(rng() * 2), null, t);
          m.states.push({ t, state: 0 });
          effects.push({ t, x: xOf(col), y: yOf(row), kind: "chip", level: m.level });
        }
      }
      if (flea.y > yOf(PLAYER_ROW) + 16) {
        flea.pest.way.push([t, flea.x, flea.y]);
        flea.pest.to = t;
        flea = null;
      }
    }
    if (spider) {
      spider.x = spider.x0 + spider.dir * SPIDER_SPEED * (t - spider.ts);
      spider.y = spiderY(spider.ts, t);
      const gone = spider.dir > 0 ? spider.x > fieldRight + 26 : spider.x < fieldLeft - 26;
      if (Math.round((t - spider.ts) * 200) % 6 === 0) spider.pest.way.push([t, spider.x, spider.y]);
      if (gone) {
        spider.pest.way.push([t, spider.x, spider.y]);
        spider.pest.to = t;
        spider = null;
      }
    }
    for (const b of bullets) {
      if (b.t1 !== null) continue;
      const before = b.y;
      b.y -= BULLET_SPEED2 * TICK;
      let contact = -Infinity;
      let hit = null;
      const col = colOf2(b.x);
      if (insideX(col) && Math.abs(b.x - xOf(col)) <= 7) {
        for (let r = PLAYER_ROW - 1; r >= LANE_ROW; r--) {
          const m = mushAt(col, r);
          if (!m) continue;
          const bottom = yOf(r) + half - BITE[Math.min(m.maxHits === 2 && m.hits === 1 ? 2 : m.hits, 2)];
          if (b.y <= bottom && before >= yOf(r) - half) {
            contact = bottom;
            hit = () => hitMushroom(m, t, bottom);
            break;
          }
        }
      }
      for (const c of centipedes) {
        c.segs.forEach((s, i) => {
          const [sx, sy] = visual(c, s, t);
          if (Math.abs(b.x - sx) <= 7.5 && b.y <= sy + 6.5 && before >= sy - 7 && sy + 6.5 > contact) {
            contact = sy + 6.5;
            hit = () => killSegment(c, i, t);
          }
        });
      }
      if (flea && Math.abs(b.x - flea.x) <= 8 && b.y <= flea.y + 6 && before >= flea.y - 6 && flea.y + 6 > contact) {
        const f = flea;
        contact = f.y + 6;
        hit = () => {
          f.pest.way.push([t, f.x, f.y]);
          f.pest.to = t;
          f.pest.shot = true;
          effects.push({ t, x: f.x, y: f.y, kind: "big", level: 0 });
          popups.push({ t, x: f.x, y: f.y, text: "200" });
          flea = null;
        };
      }
      if (spider && Math.abs(b.x - spider.x) <= 9 && b.y <= spider.y + 6 && before >= spider.y - 6 && spider.y + 6 > contact) {
        const sp = spider;
        contact = sp.y + 6;
        hit = () => {
          sp.pest.way.push([t, sp.x, sp.y]);
          sp.pest.to = t;
          sp.pest.shot = true;
          const dist = Math.abs(px - sp.x);
          effects.push({ t, x: sp.x, y: sp.y, kind: "big", level: 0 });
          popups.push({ t, x: sp.x, y: sp.y, text: dist < 60 ? "900" : dist < 140 ? "600" : "300" });
          spider = null;
        };
      }
      if (hit) {
        hit();
        b.t1 = t;
        b.y1 = contact;
      } else if (b.y < bulletTop) {
        b.t1 = t;
        b.y1 = bulletTop;
      }
      if (b.t1 !== null) finished.push({ t0: b.t0, t1: b.t1, x: b.x, y0: tipStart, y1: b.y1 });
    }
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].t1 !== null) bullets.splice(i, 1);
    if (t >= nextDecide) {
      nextDecide = t + DECIDE_GAP;
      let best = -Infinity;
      let aim = null;
      const consider = (x, y, bonus = 0) => {
        const score = y + bonus - 0.05 * Math.abs(x - px);
        if (score > best) {
          best = score;
          aim = x;
        }
      };
      const flight = (y) => (tipStart - y) / BULLET_SPEED2 + 0.04;
      for (const c of centipedes) {
        for (const s of c.segs) {
          const [sx, sy] = visual(c, s, t);
          if (sy < yOf(6) || sx < fieldLeft - 8 || sx > fieldRight + 8) continue;
          const moving = s.rec.row === s.prev.row && s.rec.col !== s.prev.col;
          const vx = moving ? s.rec.h * layout.pitch / c.stepT : 0;
          consider(Math.min(fieldRight, Math.max(fieldLeft, sx + vx * flight(sy))), sy);
        }
      }
      if (spider) {
        const lead = flight(spider.y);
        consider(Math.min(fieldRight, Math.max(fieldLeft, spider.x + spider.dir * SPIDER_SPEED * lead)), spider.y, 4);
      }
      if (flea && flea.y < yOf(6)) consider(flea.x, flea.y, 40);
      if (aim !== null) {
        target = { x: aim, threat: true };
      } else if (!target || target.threat || columnLoad(colOf2(target.x)) <= 0) {
        target = null;
        const here = colOf2(px);
        if (insideX(here) && Math.abs(px - xOf(here)) < 1 && columnLoad(here) > 0) {
          target = { x: xOf(here), threat: false };
        } else {
          for (const dir of [sweep, -sweep]) {
            for (let d = 0; d < cols && !target; d++) {
              const col = here + dir * d;
              if (insideX(col) && columnLoad(col) > 0) target = { x: xOf(col), threat: false };
            }
            if (target) {
              sweep = dir;
              break;
            }
          }
        }
      }
      player.push({ t, x: px });
    }
    const speed = PLAYER_SPEED * (1 + 0.6 * progress() ** 2) * rush;
    if (target) {
      const dx = target.x - px;
      px += Math.sign(dx) * Math.min(Math.abs(dx), speed * TICK);
    }
    if (t >= nextFire && target) {
      const aligned = target.threat ? Math.abs(px - target.x) < 10 : Math.abs(px - target.x) < 1;
      const col = colOf2(px);
      const loaded = target.threat || insideX(col) && columnLoad(col) > 0;
      if (aligned && loaded) {
        bullets.push({ t0: t, x: px, y: tipStart, t1: null, y1: 0 });
        nextFire = t + FIRE_GAP * (1 - 0.3 * progress()) / rush;
      }
    }
    if (!mushrooms.some((m) => m.died === null) && centipedes.length === 0 && pending.length === 0 && !flea && !spider) {
      end = t;
      break;
    }
  }
  player.push({ t: end, x: px });
  return { mushrooms, segments: segments2, bullets: finished, player, effects, popups, pests, clears, end };
}
var MUSHROOM_ROWS = {
  full: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "CCCCCCSC", "CCCCCCCC", "..TTTT..", "..TTTT..", ".TTTTTT."],
  nibbled: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "CCCCCCSC", "CCCCCCCC", "..TTTT..", "..T.TT..", "........"],
  bitten: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "C.CC.CSC", "........", "........", "........", "........"]
};
var MUSHROOM_SCALE = 1.5;
var STRIP_PITCH = 20;
var GNOME_ROWS = [
  "....H....",
  "...HHH...",
  "..HHHHH..",
  "..HHHHH..",
  ".HHHHHHH.",
  "..FEFEF..",
  "..FFFFF..",
  ".BBBBBBB.",
  "..BBBBB..",
  "...BBB..."
];
var GNOME_SCALE = 1.9;
var FLEA_FRAMES = [
  ["..L..L..", "..FFFF..", ".FFEFEF.", "FFFFFFFF", ".FFFFFF.", "..F..F..", ".L....L."],
  ["L.L..L.L", "..FFFF..", ".FFEFEF.", "FFFFFFFF", ".FFFFFF.", "..F..F..", "..L..L.."]
];
var SPIDER_FRAMES = [
  [".L......L.", "L.SSSSSS.L", "..SESSES..", ".LSSSSSSL.", "L..L..L..L"],
  ["L......L..", ".LSSSSSS.L", "..SESSES..", "L.SSSSSS.L", "..L.L..L.."]
];
function isDark2(theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function mix2(a, b, k) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}
function paletteFor2(theme) {
  if (theme.name === "neon") {
    return { body: "#b9ff3c", head: "#fff24d", hat: "#23f0ff", skin: "#ffe0c2", bullet: "#ffffff", flea: "#ff9d2e", spider: "#4dffb2", popup: "#23f0ff", rim: theme.surface, rimOpacity: 1 };
  }
  if (isDark2(theme)) {
    return { body: "#ff5aa5", head: "#ffd24a", hat: "#4dd8ff", skin: "#ffe0c2", bullet: "#ffffff", flea: "#ff9a4a", spider: "#c792ff", popup: "#4dd8ff", rim: theme.surface, rimOpacity: 1 };
  }
  return { body: "#d6246e", head: "#f08a00", hat: theme.accent, skin: "#ffd9b0", bullet: theme.accent, flea: "#c4570a", spider: "#6639ba", popup: theme.accent, rim: theme.ink, rimOpacity: 0.75 };
}
function dilate(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== ".";
  const out = [];
  for (let y = -1; y <= h; y++) {
    let line = "";
    for (let x = -1; x <= w; x++) {
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) on = filled(x + dx, y + dy);
      line += on ? "#" : ".";
    }
    out.push(line);
  }
  return out;
}
function sprite(rows, colors, scale, p, ox = 0, oy = 0) {
  const outline = `<path d="${bitmapPath(dilate(rows), scale, ox - scale, oy - scale)}" fill="${p.rim}" fill-opacity="${p.rimOpacity}"/>`;
  const layers = Object.entries(colors).map(([letter, fill]) => {
    const mask = rows.map((r) => r.replace(new RegExp(`[^${letter}]`, "g"), ".").replace(new RegExp(letter, "g"), "#"));
    return `<path d="${bitmapPath(mask, scale, ox, oy)}" fill="${fill}"/>`;
  });
  return outline + layers.join("");
}
function mushroomStrip(theme, level, p, dark) {
  const cap = spriteColor(theme, { level });
  const colors = { C: cap, S: mix2(cap, "#ffffff", 0.7), T: mix2(cap, "#ffffff", dark ? 0.55 : 0.3) };
  return [MUSHROOM_ROWS.full, MUSHROOM_ROWS.nibbled, MUSHROOM_ROWS.bitten].map((rows, i) => `<g transform="translate(${i * STRIP_PITCH} 0)">${sprite(rows, colors, MUSHROOM_SCALE, p)}</g>`).join("");
}
function flicker(frames2, period) {
  return frames2.map(
    (f, i) => `<g opacity="${i === 0 ? 1 : 0}">${f}<animate attributeName="opacity" values="${i === 0 ? "1;0" : "0;1"}" calcMode="discrete" dur="${period}s" repeatCount="indefinite"/></g>`
  ).join("");
}
function render3(ctx) {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark2(theme);
  const pal = paletteFor2(theme);
  const hasPlay = activeCells(grid).length > 0;
  const sim = hasPlay ? simulateCentipede(grid, layout, ctx.rng) : null;
  const activeCount = activeCells(grid).length;
  const wanted = Math.min(62, 20 + activeCount * 0.11);
  const scale = sim ? Math.min(1.7, Math.max(0.6, wanted / sim.end)) : 1;
  const play = sim ? Math.round(sim.end * scale * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const tl = new Timeline(duration);
  const T = (t) => PACE.intro + t * scale;
  const tEnd = PACE.intro + play;
  const xOf = (col) => layout.left + col * layout.pitch + layout.cell / 2;
  const yOf = (row) => layout.top + row * layout.pitch + layout.cell / 2;
  const cellX = (col) => layout.left + col * layout.pitch;
  const cellY = (row) => layout.top + row * layout.pitch;
  const midX = (xOf(0) + xOf(grid.width - 1)) / 2;
  const gnomeW = 9 * GNOME_SCALE;
  const gnomeY = yOf(PLAYER_ROW) - 9;
  const bursts = new Bursts(duration);
  const flashColor2 = dark ? "#ffffff" : pal.bullet;
  bursts.define("chip", { life: 0.34, sparks: radialSparks(6, 13, 3.2, 0.4), flash: dark ? 4.6 : 2.6, flashColor: flashColor2 });
  bursts.define("crumble", { life: 0.45, sparks: radialSparks(10, 19, 3.6, 0.2), ring: 11, flash: dark ? 6.5 : 3.5, flashColor: flashColor2 });
  bursts.define("segment", { life: 0.55, sparks: radialSparks(12, 22, 3.8, 0.1), ring: 18, ringWidth: 2, flash: dark ? 8 : 4, flashColor: flashColor2 });
  bursts.define("big", { life: 0.75, sparks: radialSparks(16, 30, 4, 0.3), ring: 28, ringWidth: 2.6, flash: dark ? 11 : 5, flashColor: flashColor2 });
  const cells = [];
  for (const column of grid.cells) for (const cell of column) if (cell) cells.push(cellRect(layout, cell, theme.empty));
  const strips = [1, 2, 3, 4].map((level) => `<g id="st${level}">${mushroomStrip(theme, level, pal, dark)}</g>`).join("");
  const clip = `<clipPath id="mclip"><rect x="-3" y="-3" width="17" height="17"/></clipPath>`;
  const legs = (a) => `<path d="${a}" stroke="${pal.body}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
  const segmentDef = `<g id="cseg">${flicker([legs("M-3 5.2v3M3 5.2v3M-3 -5.2v-3M3 -5.2v-3"), legs("M-1.2 5.4v3M4.8 5.2v3M-1.2 -5.4v-3M4.8 -5.2v-3")], 0.24)}<circle r="6.5" fill="${pal.body}" stroke="${pal.rim}" stroke-opacity="${pal.rimOpacity}" stroke-width="1.4"/><circle cx="-1.9" cy="-2" r="2" fill="#fff" fill-opacity=".38"/></g>`;
  const headDef = `<g id="chead"><path d="M4 -6.6l3.4 -3.4M4 6.6l3.4 3.4" stroke="${pal.head}" stroke-width="1.5" stroke-linecap="round"/><circle r="7.7" fill="${pal.head}" stroke="${pal.rim}" stroke-opacity="${pal.rimOpacity}" stroke-width="1.4"/><circle cx="2.6" cy="-3" r="2.4" fill="#fff"/><circle cx="2.6" cy="3" r="2.4" fill="#fff"/><circle cx="3.5" cy="-3" r="1.15" fill="#14141f"/><circle cx="3.5" cy="3" r="1.15" fill="#14141f"/><path d="M6.8 -1.4l2.6 -1.4M6.8 1.4l2.6 1.4" stroke="${pal.rim}" stroke-width="1.2" stroke-linecap="round"/></g>`;
  const gnomeDef = `<g id="gnome">${sprite(GNOME_ROWS, { H: pal.hat, F: pal.skin, E: "#1b1b2f", B: "#ffffff" }, GNOME_SCALE, pal)}</g>`;
  const fleaDef = `<g id="flea">${flicker(FLEA_FRAMES.map((f) => sprite(f, { F: pal.flea, E: "#ffffff", L: mix2(pal.flea, "#ffffff", 0.35) }, 1.5, pal, -6, -5.25)), 0.2)}</g>`;
  const spiderDef = `<g id="spider">${flicker(SPIDER_FRAMES.map((f) => sprite(f, { S: pal.spider, E: "#ffffff", L: mix2(pal.spider, "#ffffff", 0.3) }, 1.5, pal, -7.5, -3.75)), 0.18)}</g>`;
  const bulletDef = `<g id="bl"><rect x="-2.4" y="-1" width="4.8" height="11" rx="2.4" fill="${pal.bullet}" fill-opacity="${dark ? 0.28 : 0.22}"/><rect x="-1" y="0" width="2" height="9" rx="1" fill="${pal.bullet}"/></g>`;
  const body = [];
  const clears = [];
  const css = [];
  const mushroomMarkup = [];
  const bulletMarkup = [];
  const segmentMarkup = [];
  const pestMarkup = [];
  const burstMarkup = [];
  const popupMarkup = [];
  let playerMarkup = "";
  const shift = (t) => {
    const s = (t % duration + duration) % duration;
    return s === 0 ? "0s" : `-${fmt(Math.round((duration - s) * 1e3) / 1e3)}s`;
  };
  if (sim) {
    const stripCss = (state2, opacity) => `opacity:${opacity};transform:translate(${-state2 * STRIP_PITCH}px,0)`;
    for (const m of sim.mushrooms) {
      const frames2 = [];
      const first = m.day ? 0 : GONE;
      frames2.push([0, stripCss(first, 1)]);
      let state2 = first;
      if (!m.day) frames2.push([T(m.born), stripCss(GONE, 1)]);
      for (const ev of m.states) {
        const at = T(ev.t);
        frames2.push([at, stripCss(state2, 1)], [at, stripCss(ev.state, 1)]);
        state2 = ev.state;
      }
      if (m.day) {
        frames2.push([restore, stripCss(GONE, 0)], [restore, stripCss(0, 0)], [restore + PACE.restore, stripCss(0, 1)]);
      }
      const cls = tl.track(frames2);
      mushroomMarkup.push(
        `<g transform="translate(${fmt(cellX(m.col))} ${fmt(cellY(m.row))})" clip-path="url(#mclip)"><use class="${cls}" href="#st${m.level}"/></g>`
      );
      if (m.day) clears.push({ t: T(m.states[m.states.length - 1].t), cell: m.day });
    }
    const flights = /* @__PURE__ */ new Map();
    const flightClass = (d, flight) => {
      const key = `${Math.round(d * 2)}:${Math.round(flight * 500)}`;
      let cls = flights.get(key);
      if (!cls) {
        const rest = `opacity:0;transform:translateY(${fmt(-d)}px)`;
        const name = tl.keyframes([
          [0, "opacity:1;transform:translateY(0)"],
          [flight, `opacity:1;transform:translateY(${fmt(-d)}px)`],
          [flight + 1e-3, rest]
        ]);
        cls = `bf${flights.size}`;
        css.push(`.${cls}{animation:${name} ${fmt(duration)}s linear infinite}`);
        flights.set(key, cls);
      }
      return cls;
    };
    for (const b of sim.bullets) {
      const cls = flightClass(b.y0 - b.y1, (b.t1 - b.t0) * scale);
      bulletMarkup.push(`<use class="${cls}" href="#bl" x="${fmt(b.x)}" y="${fmt(b.y0)}" style="animation-delay:${shift(T(b.t0))}"/>`);
    }
    for (const s of sim.segments) {
      if (s.died === null) throw new Error("segment survived");
      const pts2 = simplify(s.way.map(([t, x, y]) => [T(t), x, y]));
      const start = pts2[0];
      const stop = pts2[pts2.length - 1];
      const frames2 = [[0, `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:1;${translate(start[1], start[2])}`]];
      for (const [t, x, y] of pts2) frames2.push([t, `opacity:1;${translate(x, y)}`]);
      frames2.push([stop[0], `opacity:0;${translate(stop[1], stop[2])}`]);
      const pos = tl.track(frames2);
      let headLayer = "";
      if (s.heads.length) {
        const hf = [[0, "opacity:0"]];
        let on = false;
        let face2 = 1;
        for (const ev of s.heads) {
          const t = T(ev.t);
          hf.push([t, `opacity:${on ? 1 : 0};transform:scaleX(${face2})`], [t, `opacity:1;transform:scaleX(${ev.face})`]);
          on = true;
          face2 = ev.face;
        }
        hf.push([stop[0], `opacity:1;transform:scaleX(${face2})`], [stop[0], "opacity:0"]);
        headLayer = `<g class="${tl.track(hf)}"><use href="#chead"/></g>`;
      }
      segmentMarkup.push(`<g class="${pos}"><use href="#cseg"/>${headLayer}</g>`);
    }
    for (const p of sim.pests) {
      const pts2 = simplify(p.way.map(([t, x, y]) => [T(t), x, y]));
      const start = pts2[0];
      const stop = pts2[pts2.length - 1];
      const frames2 = [[0, `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:1;${translate(start[1], start[2])}`]];
      for (const [t, x, y] of pts2) frames2.push([t, `opacity:1;${translate(x, y)}`]);
      frames2.push([stop[0], `opacity:0;${translate(stop[1], stop[2])}`]);
      pestMarkup.push(`<g class="${tl.track(frames2)}"><use href="#${p.kind}"/></g>`);
    }
    for (const e of sim.effects) {
      const color = e.kind === "chip" || e.kind === "crumble" ? spriteColor(theme, { level: e.level }) : e.kind === "big" ? pal.head : pal.body;
      burstMarkup.push(bursts.use(e.kind, e.x, e.y, T(e.t), color));
    }
    for (const p of sim.popups) {
      const text = pixelText(p.text, 1.6);
      const te = T(p.t);
      const cls = tl.track([
        [0, `opacity:0;${translate(p.x, p.y - 8)}`],
        [te, `opacity:0;${translate(p.x, p.y - 8)}`],
        [te, `opacity:1;${translate(p.x, p.y - 8)}`],
        [te + 0.8, `opacity:1;${translate(p.x, p.y - 20)}`],
        [te + 0.82, `opacity:0;${translate(p.x, p.y - 20)}`]
      ]);
      popupMarkup.push(`<g class="${cls}"><path d="${text.d}" transform="translate(${fmt(-text.width / 2)} ${fmt(-text.height / 2)})" fill="${pal.popup}"/></g>`);
    }
    const stand = translate(midX - gnomeW / 2, gnomeY);
    const pf = [[0, stand]];
    const pts = simplify([[0, midX, 0], ...sim.player.map(({ t, x }) => [T(t), x, 0]), [Math.min(restore - 0.05, tEnd + 0.9), midX, 0], [duration, midX, 0]]);
    for (const [t, x] of pts) pf.push([t, translate(x - gnomeW / 2, gnomeY)]);
    playerMarkup = `<g class="${tl.track(pf)}"><use href="#gnome"/></g>`;
  } else {
    playerMarkup = `<g transform="translate(${fmt(midX - gnomeW / 2)} ${fmt(gnomeY)})"><use href="#gnome"/></g>`;
  }
  const bar = hud(tl, grid, { theme, title: "CENTIPEDE", clears, resetAt: restore, width });
  const end = sim ? banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: width / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: tEnd + 0.15,
    to: restore
  }) : "";
  const defs = glowDefs(theme) + strips + clip + segmentDef + headDef + gnomeDef + fleaDef + spiderDef + bulletDef + bursts.defs();
  body.push(
    `<g>${cells.join("")}</g>`,
    `<g>${mushroomMarkup.join("")}</g>`,
    `<g>${bulletMarkup.join("")}</g>`,
    `<g${glowAttr(theme)}>${segmentMarkup.join("")}${pestMarkup.join("")}${playerMarkup}</g>`,
    `<g>${burstMarkup.join("")}</g>`,
    `<g>${popupMarkup.join("")}</g>`,
    bar,
    end
  );
  return { width, height, css: `${tl.css()}
${bursts.css()}
${css.join("\n")}`, defs, body: body.join("\n") };
}
var centipede = { id: "centipede", title: "Centipede", render: render3 };

// src/games/galaga-path.ts
var DEG = Math.PI / 180;
var Turtle = class {
  x;
  y;
  /** Heading in radians, unwrapped so loops keep counting instead of snapping back. */
  h;
  time = 0;
  ts = [0];
  xs;
  ys;
  hs;
  constructor(x, y, headingDeg) {
    this.x = x;
    this.y = y;
    this.h = headingDeg * DEG;
    this.xs = [x];
    this.ys = [y];
    this.hs = [this.h];
  }
  push(dt) {
    this.time += dt;
    this.ts.push(this.time);
    this.xs.push(this.x);
    this.ys.push(this.y);
    this.hs.push(this.h);
  }
  line(length, speed) {
    this.x += Math.cos(this.h) * length;
    this.y += Math.sin(this.h) * length;
    this.push(Math.abs(length) / speed);
    return this;
  }
  /** Positive degrees turn clockwise on screen. */
  arc(deg, radius, speed) {
    const sign = Math.sign(deg) || 1;
    const steps = Math.max(1, Math.ceil(Math.abs(deg) / 22.5));
    const step = deg * DEG / steps;
    const cx = this.x + radius * Math.cos(this.h + sign * Math.PI / 2);
    const cy = this.y + radius * Math.sin(this.h + sign * Math.PI / 2);
    for (let i = 0; i < steps; i++) {
      this.h += step;
      this.x = cx + radius * Math.cos(this.h - sign * Math.PI / 2);
      this.y = cy + radius * Math.sin(this.h - sign * Math.PI / 2);
      this.push(radius * Math.abs(step) / speed);
    }
    return this;
  }
  curveTo(c1x, c1y, c2x, c2y, ex, ey, speed) {
    const x0 = this.x;
    const y0 = this.y;
    const approx = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(ex - c2x, ey - c2y);
    const steps = Math.max(4, Math.ceil(approx / 16));
    let px = x0;
    let py = y0;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const v = 1 - u;
      const x = v * v * v * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ex;
      const y = v * v * v * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ey;
      const dx = 3 * v * v * (c1x - x0) + 6 * v * u * (c2x - c1x) + 3 * u * u * (ex - c2x);
      const dy = 3 * v * v * (c1y - y0) + 6 * v * u * (c2y - c1y) + 3 * u * u * (ey - c2y);
      let h = Math.atan2(dy, dx);
      while (h - this.h > Math.PI) h -= 2 * Math.PI;
      while (h - this.h < -Math.PI) h += 2 * Math.PI;
      this.h = h;
      this.x = x;
      this.y = y;
      this.push(Math.hypot(x - px, y - py) / speed);
      px = x;
      py = y;
    }
    return this;
  }
  /** Finishes the route; `finalRotation` overrides the heading at the last vertex (the pivot into formation). */
  done(finalRotation) {
    const r = this.hs.map((h) => h * 180 / Math.PI - 90);
    if (finalRotation !== void 0) r[r.length - 1] = finalRotation;
    return { t: this.ts.slice(), x: this.xs.slice(), y: this.ys.slice(), r, dur: this.time };
  }
};
function routeAt(route, t) {
  const n = route.t.length;
  if (t <= 0) return { x: route.x[0], y: route.y[0], r: route.r[0] };
  if (t >= route.dur) return { x: route.x[n - 1], y: route.y[n - 1], r: route.r[n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (route.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = route.t[hi] - route.t[lo] || 1;
  const u = (t - route.t[lo]) / span;
  return {
    x: route.x[lo] + (route.x[hi] - route.x[lo]) * u,
    y: route.y[lo] + (route.y[hi] - route.y[lo]) * u,
    r: route.r[lo] + (route.r[hi] - route.r[lo]) * u
  };
}

// src/games/galaga-sim.ts
var FIGHTER_Y = 192;
var SEP = 16;
var BREATH_AMP = 0.016;
var BREATH_PERIOD = 4;
var BREATH_STEP = 0.25;
var DT = 1 / 60;
var VF = 430;
var VB = 470;
var BULLET_Y0 = FIGHTER_Y - 12;
var HIT_X = 8.8;
var RESCUE_AT = 0.25;
var SPIN = 1.1;
var DOCK = 1.3;
var SAFE_GAP = 16;
var breathTable = [];
function breathSample(k) {
  let v = breathTable[k];
  if (v === void 0) {
    const t = k * BREATH_STEP;
    v = BREATH_AMP * Math.sin(2 * Math.PI * t / BREATH_PERIOD) * Math.min(1, t);
    breathTable[k] = v;
  }
  return v;
}
function breathAt(t) {
  if (t <= 0) return 0;
  const k = Math.floor(t / BREATH_STEP);
  const u = t / BREATH_STEP - k;
  return breathSample(k) * (1 - u) + breathSample(k + 1) * u;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function diveRoute(sx, sy, side, aimX, width) {
  const t = new Turtle(sx, sy, 90);
  t.line(6, 150).arc(-360 * side, 11, 170);
  const qx = clamp(aimX + side * 26, 26, width - 26);
  t.curveTo(sx, t.y + 55, qx - side * 44, 150, qx, 184, 215);
  t.arc(-side * 180, 15, 215);
  t.curveTo(t.x + Math.cos(t.h) * 45, t.y + Math.sin(t.h) * 45, sx, sy + 70, sx, sy + 18, 225);
  t.line(18, 120);
  return t.done(Math.round((t.h * 180 / Math.PI - 90) / 360) * 360);
}
function captureRoute(sx, sy, side, hoverY) {
  const t = new Turtle(sx, sy, 90);
  t.line(6, 130).arc(-360 * side, 11, 150);
  t.line(hoverY - t.y, 140);
  return t.done(Math.round((t.h * 180 / Math.PI - 90) / 360) * 360);
}
function straightRoute(x0, y0, x1, y1, speed) {
  const dur = Math.hypot(x1 - x0, y1 - y0) / speed;
  return { t: [0, dur], x: [x0, x1], y: [y0, y1], r: [0, 0], dur };
}
function simulateGalaga(grid, rng, geo) {
  let best = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const run2 = playOnce(grid, createRng(`${Math.floor(rng() * 2 ** 31)}`), geo);
    if (!best || run2.minClearance > best.minClearance) best = run2;
    if (best.minClearance >= SAFE_GAP) break;
  }
  return best;
}
function playOnce(grid, rng, geo) {
  const cells = activeCells(grid);
  const total = cells.length;
  const enemies = cells.map((cell, id) => ({
    rec: {
      id,
      cell,
      kind: cell.level >= 4 ? "boss" : cell.level === 3 ? "butterfly" : "bee",
      slot: geo.slot(cell),
      dives: [],
      hit: null,
      death: null,
      deathAt: null
    },
    state: "form",
    hp: cell.level >= 4 ? 2 : 1,
    start: 0,
    route: null,
    captor: false,
    rescuing: false,
    doomed: true
  }));
  const shots = [];
  const booms = [];
  const fighter = [];
  const fade = [{ t: 0, opacity: 1 }];
  const out = { enemies: enemies.map((e) => e.rec), shots, booms, fighter, fade, capture: null, rescue: null, end: 0, minClearance: Infinity };
  if (total === 0) return out;
  const byCol = /* @__PURE__ */ new Map();
  for (const e of enemies) {
    const list = byCol.get(e.rec.cell.x) ?? [];
    list.push(e);
    byCol.set(e.rec.cell.x, list);
  }
  for (const list of byCol.values()) list.sort((a, b) => a.rec.slot[1] - b.rec.slot[1]);
  const columns = [...byCol.keys()].sort((a, b) => a - b);
  const colSlotX = /* @__PURE__ */ new Map();
  for (const [c, list] of byCol) colSlotX.set(c, list[0].rec.slot[0]);
  const rate = clamp(total / 30, 3.5, 8);
  let tau = 0;
  let killed = 0;
  let fx = geo.centerX;
  let dual = false;
  let mode = "play";
  let cooldown = 0.4;
  let moving = false;
  let moveTick = 0;
  let nextDive = 1.4;
  let bullets = [];
  let plan = null;
  let sweep = -1;
  let dockX = 0;
  let dualAt = -1;
  let lastDeath = 0;
  let phase = total >= 14 && enemies.some((e) => e.rec.kind === "boss") ? "wait" : "off";
  let capBoss = null;
  let cap = null;
  let nextRescue = 0;
  const ships = (x = fx) => dual ? [x, x + SEP] : [x];
  const xMax = () => geo.width - 16 - (dual ? SEP : 0);
  const unscale = (v, c, t) => c + (v - c) / (1 + breathAt(t));
  const scrX = (x, t) => geo.centerX + (x - geo.centerX) * (1 + breathAt(t));
  const scrY = (y, t) => geo.centerY + (y - geo.centerY) * (1 + breathAt(t));
  const posOf = (e, t) => {
    if (e.state === "dive" || e.state === "capture") {
      const p = routeAt(e.route, t - e.start);
      return [scrX(p.x, t), scrY(p.y, t)];
    }
    return [scrX(e.rec.slot[0], t), scrY(e.rec.slot[1], t)];
  };
  const frontline = (e) => {
    const list = byCol.get(e.rec.cell.x);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].state === "form") return list[i] === e;
    }
    return false;
  };
  const alive = () => enemies.filter((e) => e.state !== "dead");
  const divers = () => enemies.filter((e) => e.state === "dive" || e.state === "capture");
  const pushKey = (t, x, y = FIGHTER_Y, rot = 0, scale = 1) => fighter.push({ t, x, y, rot, scale });
  pushKey(0, fx);
  const startDive = (e, route, state2) => {
    e.doomed = e.rescuing || rng() < 0.62;
    e.state = state2;
    e.start = tau;
    e.route = route;
    e.rec.dives.push({ start: tau, route, end: tau + route.dur, killed: false });
  };
  const hazards = (t) => {
    const xs = [];
    for (const e of divers()) {
      for (let k = 0; k <= 9; k++) {
        const [ex, ey] = posOf(e, t + k * 0.09);
        if (ey >= FIGHTER_Y - 30 && ey <= FIGHTER_Y + 22) xs.push(ex);
      }
    }
    return xs;
  };
  const gap = (xs, haz) => {
    let best = Infinity;
    for (const h of haz) for (const sx of xs) best = Math.min(best, Math.abs(h - sx));
    return best;
  };
  const HORIZON = 9;
  const STEP2 = 0.09;
  const hazardSamples = (t) => {
    const out2 = Array.from({ length: HORIZON + 1 }, () => []);
    for (const e of divers()) {
      for (let k = 0; k <= HORIZON; k++) {
        const [ex, ey] = posOf(e, t + k * STEP2);
        if (ey >= FIGHTER_Y - 30 && ey <= FIGHTER_Y + 22) out2[k].push(ex);
      }
    }
    return out2;
  };
  const routeGap = (x, samples) => {
    let best = Infinity;
    for (let k = 0; k <= HORIZON; k++) {
      if (samples[k].length === 0) continue;
      const p = fx + clamp(x - fx, -VF * k * STEP2, VF * k * STEP2);
      for (const ex of samples[k]) for (const sx of ships(p)) best = Math.min(best, Math.abs(ex - sx));
    }
    return best;
  };
  const findIntercept = () => {
    const ready = Math.max(0, cooldown);
    const order = divers().sort((a, b) => Number(b.rescuing) - Number(a.rescuing));
    for (const e of order) {
      if (e.state !== "dive" || !e.doomed) continue;
      const endT = e.start + e.route.dur;
      for (let th = Math.max(tau + 0.12, e.start + 0.9); th < Math.min(endT, tau + 1.5); th += 0.05) {
        const [px, py] = posOf(e, th);
        if (py < 62 || py > FIGHTER_Y - 22) continue;
        const tf = th - (BULLET_Y0 - py) / VB;
        const options = dual ? [px, px - SEP] : [px];
        for (const ax of options) {
          if (ax < 16 || ax > xMax()) continue;
          const need = Math.max(Math.abs(ax - fx) / VF, ready);
          if (tf - tau >= need) return { ax, fire: tf, id: e.rec.id };
        }
      }
    }
    return null;
  };
  const killEnemy = (e, x, y) => {
    const wasDive = e.state === "dive";
    e.state = "dead";
    e.rec.death = tau;
    e.rec.deathAt = [x, y];
    killed++;
    lastDeath = tau;
    const last = alive().length === 0;
    booms.push({ t: tau, x, y, size: last ? "l" : e.rec.kind === "boss" ? "m" : "s" });
    if (wasDive) {
      const d = e.rec.dives[e.rec.dives.length - 1];
      d.end = tau;
      d.killed = true;
    }
    if (e.captor && cap && out.capture) {
      const to = [clamp(fx, 16, geo.width - 16 - SEP) + SEP, FIGHTER_Y];
      dockX = to[0] - SEP;
      out.rescue = { t: tau, from: [x, y + 16], to, dockAt: tau + DOCK };
      phase = "release";
      mode = "dock";
      plan = null;
    }
  };
  const fire = () => {
    for (const sx of ships()) {
      const shot = { t: tau, x: sx, y0: BULLET_Y0, tEnd: tau, yEnd: BULLET_Y0, hit: false };
      shots.push(shot);
      bullets.push({ shot, x: sx, y: BULLET_Y0 });
    }
    cooldown = 1 / rate;
    plan = null;
  };
  const avail = (col) => {
    const list = byCol.get(col);
    if (!list) return 0;
    const forms = list.filter((e) => e.state === "form");
    if (forms.length === 0) return 0;
    const bottom = forms[forms.length - 1];
    const onlyOne = alive().every((e) => e === bottom || e.captor);
    if (bottom.captor && !bottom.rescuing && !(onlyOne && divers().length === 0)) return 0;
    return forms.length;
  };
  const pending = (col) => {
    const cx = colSlotX.get(col) ?? 0;
    let n = 0;
    for (const b of bullets) if (Math.abs(unscale(b.x, geo.centerX, tau) - cx) < HIT_X) n++;
    return n;
  };
  const colX = (col) => scrX(colSlotX.get(col) ?? geo.centerX, tau);
  const targets = (c) => [avail(c) - pending(c), dual ? avail(c + 1) - pending(c + 1) : 0];
  const pickSweep = (haz, samples) => {
    let best = -1;
    let bestCost = Infinity;
    for (const c of columns) {
      const [here, next] = targets(c);
      if (here <= 0 && next <= 0) continue;
      const cxs = clamp(colX(c), 16, xMax());
      if (gap(ships(cxs), haz) < 34 || routeGap(cxs, samples) < 28) continue;
      const cost = Math.abs(colX(c) - fx) - (here > 0 && next > 0 ? 9 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    return best;
  };
  const steps = Math.ceil(240 / DT);
  for (let step = 0; step < steps; step++) {
    tau = step * DT;
    const remaining = alive().length;
    for (const e of enemies) {
      if (e.state === "dive" && tau - e.start >= e.route.dur) {
        e.state = "form";
        e.route = null;
        e.rescuing = false;
        if (e.captor) nextRescue = tau + 2.4;
      }
    }
    const bossOptions = phase === "wait" && killed >= total * 0.07 && tau > 4 ? enemies.filter((e) => e.rec.kind === "boss" && e.state === "form" && frontline(e) && e.rec.slot[1] <= 120) : [];
    if (bossOptions.length > 0 && divers().length === 0) {
      const options = bossOptions;
      {
        const boss = options[Math.floor(rng() * options.length)];
        const [sx, sy] = boss.rec.slot;
        const hy = Math.max(160, sy + 34);
        const route = captureRoute(sx, sy, sx < geo.centerX ? 1 : -1, hy);
        startDive(boss, route, "capture");
        capBoss = boss;
        cap = {
          boss: boss.rec.id,
          diveStart: tau,
          hoverAt: tau + route.dur,
          beamOn: tau + route.dur + 0.2,
          beamOff: 0,
          abductEnd: 0,
          returnStart: 0,
          returnEnd: 0,
          hover: [sx, hy],
          returnRoute: straightRoute(sx, hy, sx, sy, 105),
          respawn: 0,
          respawnX: geo.centerX
        };
        phase = "dive";
        mode = "bait";
        plan = null;
      }
    }
    if (phase === "dive" && cap && tau >= cap.hoverAt) phase = "beam";
    if (phase === "beam" && cap && capBoss && mode === "bait") {
      const [bx] = posOf(capBoss, tau);
      if (tau >= cap.beamOn + 1 && Math.abs(fx - bx) < 3) {
        mode = "spin";
        phase = "abduct";
        cap.beamOff = tau + SPIN + 0.3;
        cap.abductEnd = tau + SPIN;
        cap.returnStart = tau + SPIN + 0.35;
        cap.returnEnd = cap.returnStart + cap.returnRoute.dur;
        cap.respawn = cap.abductEnd + 0.9;
        const hy = scrY(cap.hover[1], tau) + 24;
        pushKey(tau, fx);
        pushKey(tau + SPIN, bx, hy, 1080, 0.75);
        pushKey(cap.respawn - 0.01, geo.centerX, FIGHTER_Y);
        fade.push({ t: tau + SPIN, opacity: 1 }, { t: tau + SPIN + 0.01, opacity: 0 }, { t: cap.respawn - 0.01, opacity: 0 }, { t: cap.respawn + 0.3, opacity: 1 });
        moving = false;
      }
    }
    if (phase === "abduct" && cap && tau >= cap.abductEnd) {
      mode = "gone";
      phase = "return";
      out.capture = cap;
    }
    if (phase === "return" && cap && capBoss && tau >= cap.returnStart && capBoss.state === "capture") {
      capBoss.start = cap.returnStart;
      capBoss.route = cap.returnRoute;
    }
    if (phase === "return" && cap && capBoss && tau >= cap.returnEnd) {
      capBoss.state = "form";
      capBoss.route = null;
      capBoss.captor = true;
      capBoss.hp = 2;
      phase = "held";
      nextRescue = tau + 1.5;
    }
    if (cap && mode === "gone" && tau >= cap.respawn) {
      mode = "play";
      fx = cap.respawnX;
      cooldown = 0.5;
      moving = false;
    }
    if (phase === "held" && capBoss && killed >= total * RESCUE_AT && tau >= nextRescue && divers().length === 0 && capBoss.state === "form") {
      const [sx, sy] = capBoss.rec.slot;
      capBoss.rescuing = true;
      startDive(capBoss, diveRoute(sx, sy, sx < geo.centerX ? 1 : -1, fx, geo.width), "dive");
    }
    if (phase === "release" && out.rescue && tau >= out.rescue.dockAt) {
      dual = true;
      dualAt = tau;
      phase = "done";
      mode = "play";
      cooldown = 0.3;
      nextDive = tau + 0.8;
    }
    const paused = bossOptions.length > 0;
    const busy = phase === "dive" || phase === "beam" || phase === "abduct" || phase === "return" || phase === "release";
    const endgame = remaining < total * 0.25;
    if (!paused && !busy && tau >= nextDive && remaining > 3) {
      const maxDivers = endgame ? 3 : 2;
      const live = divers().length;
      if (live < maxDivers) {
        const options = enemies.filter((e) => e.state === "form" && frontline(e) && !e.captor);
        if (options.length > 0) {
          const e = options[Math.floor(rng() * options.length)];
          const [sx, sy] = e.rec.slot;
          const side = (sx < geo.centerX ? 1 : -1) * (rng() < 0.2 ? -1 : 1);
          startDive(e, diveRoute(sx, sy, side, fx + (rng() < 0.5 ? -1 : 1) * (50 + rng() * 50), geo.width), "dive");
        }
      }
      nextDive = tau + (endgame ? 0.7 + rng() * 1.1 : 1 + rng() * 2);
    }
    cooldown -= DT;
    const prevX = fx;
    if (mode === "play" || mode === "dock" || mode === "bait") {
      let tx = fx;
      let canFire = false;
      if (mode === "bait" && capBoss) {
        tx = posOf(capBoss, tau)[0];
      } else if (mode === "dock") {
        tx = dockX;
      } else {
        const haz = hazards(tau);
        const samples = hazardSamples(tau);
        const clear = (x, margin) => gap(ships(x), haz) >= margin;
        if (routeGap(fx, samples) < 24) {
          plan = null;
          let bestCost = Infinity;
          for (const c of columns) {
            const [a, b] = targets(c);
            if (a <= 0 && b <= 0) continue;
            const cxs = clamp(colX(c), 16, xMax());
            if (!clear(cxs, 34) || routeGap(cxs, samples) < 28) continue;
            const cost = Math.abs(cxs - fx);
            if (cost < bestCost) {
              bestCost = cost;
              tx = cxs;
              sweep = c;
            }
          }
          if (bestCost === Infinity || bestCost > 260) {
            let bestScore = -Infinity;
            for (let off = 0; off <= 300; off += 8) {
              for (const sgn of off === 0 ? [1] : [1, -1]) {
                const cx = fx + sgn * off;
                if (cx < 16 || cx > xMax()) continue;
                const score = Math.min(routeGap(cx, samples), 50) * 2 - off * 0.05;
                if (score > bestScore) {
                  bestScore = score;
                  tx = cx;
                }
              }
            }
          } else {
            canFire = Math.abs(fx - tx) < 2.5;
          }
        } else {
          if (!plan || tau > plan.fire + 0.3 || enemies[plan.id].state !== "dive") plan = findIntercept();
          if (plan && (!clear(plan.ax, 24) || routeGap(plan.ax, samples) < 26)) plan = null;
          if (plan) {
            tx = plan.ax;
            canFire = tau >= plan.fire - 0.025 && Math.abs(fx - tx) < 3;
          } else {
            if (sweep < 0 || targets(sweep).every((n) => n <= 0) || !clear(clamp(colX(sweep), 16, xMax()), 30) || routeGap(clamp(colX(sweep), 16, xMax()), samples) < 26) sweep = pickSweep(haz, samples);
            if (sweep >= 0) {
              tx = colX(sweep);
              canFire = Math.abs(fx - tx) < 2.5 && targets(sweep).some((n) => n > 0);
            }
          }
        }
      }
      tx = clamp(tx, 16, xMax());
      fx += clamp(tx - fx, -VF * DT, VF * DT);
      if (!canFire && mode === "play" && (!plan || tau < plan.fire - 0.3)) {
        for (const c of columns) {
          if (Math.abs(colX(c) - fx) > 2.5) continue;
          if (targets(c)[0] > 0 || dual && Math.abs(colX(c + 1) - fx - SEP) < 2.5 && targets(c)[1] > 0) canFire = true;
        }
      }
      const maxBullets = dual ? 8 : 5;
      if (canFire && cooldown <= 0 && bullets.length < maxBullets && mode === "play") fire();
    }
    if (mode === "play" || mode === "dock" || mode === "bait") {
      const moved = fx !== prevX;
      if (moved && !moving) pushKey(tau, prevX);
      if (moved && moving && ++moveTick % 3 === 0) pushKey(tau + DT, fx);
      if (!moved && moving) pushKey(tau, prevX);
      moving = moved;
    }
    if (mode === "play" || mode === "dock") {
      for (const e of divers()) {
        if (e.state !== "dive") continue;
        const [ex, ey] = posOf(e, tau);
        for (const sx of ships()) {
          const d = Math.hypot(ex - sx, ey - FIGHTER_Y);
          out.minClearance = Math.min(out.minClearance, d);
        }
      }
    }
    const keep = [];
    for (const b of bullets) {
      const yOld = b.y;
      b.y -= VB * DT;
      let target = null;
      let targetY = -Infinity;
      const sc = 1 + breathAt(tau);
      for (const e of enemies) {
        if (e.state === "dead" || e.state === "capture") continue;
        if (e.state === "form" && Math.abs(b.x - (geo.centerX + (e.rec.slot[0] - geo.centerX) * sc)) > HIT_X) continue;
        const [ex, ey] = posOf(e, tau);
        if (Math.abs(b.x - ex) > HIT_X) continue;
        if (e.state === "form" && !frontline(e)) continue;
        const tip = b.y - 5;
        if (tip <= ey + 8 && yOld - 5 >= ey - 10 && ey > targetY) {
          target = e;
          targetY = ey;
        }
      }
      if (target) {
        b.shot.tEnd = tau;
        b.shot.yEnd = Math.max(b.y, targetY + 6);
        b.shot.hit = true;
        const [ex, ey] = posOf(target, tau);
        target.hp--;
        if (target.hp <= 0) killEnemy(target, ex, ey);
        else {
          target.rec.hit = tau;
          booms.push({ t: tau, x: ex, y: ey, size: "s" });
        }
        continue;
      }
      if (b.y < 34) {
        b.shot.tEnd = tau;
        b.shot.yEnd = 34;
        continue;
      }
      keep.push(b);
    }
    bullets = keep;
    if (remaining === 0 && bullets.length === 0 && phase !== "release" && mode !== "dock") {
      out.end = Math.max(tau, lastDeath + 0.8);
      break;
    }
    if (step === steps - 1) {
      throw new Error("Galaga did not finish");
    }
  }
  if (dualAt >= 0 && out.rescue) out.rescue.dockAt = dualAt;
  pushKey(out.end, fx);
  return out;
}

// src/games/galaga.ts
var TARGET_PLAY3 = 58;
var MIN_SCALE = 0.6;
var SPRITE_SCALE = 1.1;
var SHIP_SCALE = 1.25;
var BEE_BODY = [
  ".....R.R.....",
  "....PPPPP....",
  "...PPPPPPP...",
  "...PWPPPWP...",
  "...PPPPPPP...",
  "....DPDPD....",
  ".....PPP.....",
  "......P......"
];
var BEE_WINGS_A = ["BB.........BB", "BBB.......BBB", ".BBB.....BBB.", "..BB.....BB.."];
var BEE_WINGS_B = ["..BB.....BB..", ".BBB.....BBB.", "BBB.......BBB", "BB.........BB"];
var FLY_A = [
  "P.....R.....P",
  "PP....D....PP",
  "PPP..DWD..PPP",
  "PPRP.DDD.PRPP",
  "PPPP.DDD.PPPP",
  ".PPP.DDD.PPP.",
  "..PP..D..PP..",
  "...P..D..P...",
  "......D......"
];
var FLY_B = [
  "......R......",
  ".....DDD.....",
  "..PP.DWD.PP..",
  ".PPPPDDDPPPP.",
  ".PRPPDDDPPRP.",
  ".PPPPDDDPPPP.",
  "..PP..D..PP..",
  "......D......",
  "......D......"
];
var BOSS_A = [
  "Y....YYY....Y",
  "YY..PPPPP..YY",
  ".YYPPPPPPPYY.",
  "..PPWPPPWPP..",
  "VVPPPPPPPPPVV",
  "VVVPDPPPDPVVV",
  ".VV.PDDDP.VV.",
  "..V..PPP..V..",
  ".....P.P.....",
  "....PP.PP...."
];
var BOSS_B = [
  "Y....YYY....Y",
  "YY..PPPPP..YY",
  ".YYPPPPPPPYY.",
  "..PPWPPPWPP..",
  "..VPPPPPPPV..",
  ".VVVPDPPPDVVV",
  "VV..PDDDP..VV",
  "V....PPP....V",
  ".....P.P.....",
  "....PP.PP...."
];
var SHIP = [
  "......W......",
  "......W......",
  ".....WWW.....",
  ".....WBW.....",
  "R....WBW....R",
  "R...WWBWW...R",
  "RR..WWWWW..RR",
  "RR.WWWRWWW.RR",
  "RRRWWWWWWWRRR",
  "RRRWW.W.WWRRR",
  "RRR.W.W.W.RRR",
  "R.R.......R.R"
];
function mergeRows(body, wings, wingsAt) {
  const out = Array.from({ length: body.length }, () => Array(13).fill("."));
  wings.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && (out[y + wingsAt][x] = ch)));
  body.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && (out[y][x] = ch)));
  return out.map((r) => r.join(""));
}
function enemyPalette(theme, level, damaged = false) {
  const base = spriteColor(theme, { level });
  const P = damaged ? "#6f8cff" : base;
  return {
    D: mix(P, "#000000", 0.42),
    P,
    W: "#ffffff",
    R: "#ff4b5c",
    B: "#4d8dff",
    Y: "#ffd23a",
    V: damaged ? "#c9a0ff" : "#a05cff"
  };
}
function lookFor(kind) {
  if (kind === "bee") return { a: mergeRows(BEE_BODY, BEE_WINGS_A, 0), b: mergeRows(BEE_BODY, BEE_WINGS_B, 3) };
  if (kind === "butterfly") return { a: FLY_A, b: FLY_B };
  return { a: BOSS_A, b: BOSS_B };
}
function frames(rows, pal, outline) {
  const w = 13 * SPRITE_SCALE;
  const h = rows.length * SPRITE_SCALE;
  return `<g transform="translate(${fmt(-w / 2)} ${fmt(-h / 2)})">${pixelSprite(rows, pal, SPRITE_SCALE, outline)}</g>`;
}
function shipArt(white, theme) {
  const pal = white ? { W: "#f4f7ff", R: "#ff3b3b", B: "#3b7bff" } : { W: "#ff8a8a", R: "#b3202c", B: "#ffd0d0" };
  const w = 13 * SHIP_SCALE;
  const h = SHIP.length * SHIP_SCALE;
  const outline = { color: isDark(theme) ? "#0a0d1a" : "#1b1f3b", width: 1.2 };
  return `<g transform="translate(${fmt(-w / 2)} ${fmt(-h / 2)})">${pixelSprite(SHIP, pal, SHIP_SCALE, outline)}</g>`;
}
function starPoints(r, inner, points) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = Math.PI * i / points - Math.PI / 2;
    pts.push(`${fmt(Math.cos(a) * rad)} ${fmt(Math.sin(a) * rad)}`);
  }
  return pts.join(" ");
}
function render4(ctx) {
  const { grid, theme, rng } = ctx;
  const dark = isDark(theme);
  const layout = arcadeLayout(grid);
  const cx = layout.width / 2;
  const cy = layout.top + layout.gridHeight / 2;
  const sim = simulateGalaga(grid, rng, {
    width: layout.width,
    centerX: cx,
    centerY: cy,
    slot: (c) => cellCenter(layout, c.x, c.y)
  });
  const hasPlay = sim.enemies.length > 0;
  const scale = hasPlay ? Math.min(1, Math.max(MIN_SCALE, TARGET_PLAY3 / sim.end)) : 1;
  const play = hasPlay ? Math.round(sim.end * scale * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (tau) => PACE.intro + tau * scale;
  const playEnd = PACE.intro + play;
  const defs = [glowDefs(theme)];
  const outline = dark ? void 0 : { color: "#1b1f3b", width: 0.7 };
  const kindsUsed = new Set(sim.enemies.map((e) => `${e.kind}:${e.kind === "bee" ? e.cell.level : e.kind === "butterfly" ? 3 : 4}`));
  for (const key of kindsUsed) {
    const [kind, lv] = key.split(":");
    const level = Number(lv);
    const look = lookFor(kind);
    defs.push(`<g id="e-${kind}${level}-a">${frames(look.a, enemyPalette(theme, level), outline)}</g>`);
    defs.push(`<g id="e-${kind}${level}-b">${frames(look.b, enemyPalette(theme, level), outline)}</g>`);
    if (kind === "boss") {
      defs.push(`<g id="e-${kind}${level}-c">${frames(look.a, enemyPalette(theme, level, true), outline)}</g>`);
      defs.push(`<g id="e-${kind}${level}-d">${frames(look.b, enemyPalette(theme, level, true), outline)}</g>`);
    }
  }
  defs.push(`<g id="shipw">${shipArt(true, theme)}</g><g id="shipr">${shipArt(false, theme)}</g>`);
  const boomStroke = dark ? "" : ` stroke="#7a1f10" stroke-width="1" stroke-linejoin="round"`;
  defs.push(
    `<g id="bs"><polygon points="${starPoints(12, 5.2, 8)}" fill="#ff5a3c"${boomStroke}/><polygon points="${starPoints(8.4, 3.6, 8)}" fill="#ffd23a"/><circle r="3.6" fill="#fff"/></g>`,
    `<circle id="br" r="6" fill="none" stroke="#7fe3ff" stroke-width="2"/>`,
    `<path id="bp" d="M-1-12h2v3h-2zM9-9l2 2-2 2-2-2zM11 0h3v2h-3zM8 8l2 2-2 2-2-2zM-1 9h2v3h-2zM-9 8l2 2-2 2-2-2zM-14 0h3v2h-3zM-9-9l2 2-2 2-2-2z"/>`
  );
  const starKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.3)"],
    [0.1, "opacity:1;transform:scale(1)"],
    [0.4, "opacity:0;transform:scale(1.45)"],
    [duration, "opacity:0;transform:scale(1.45)"]
  ]);
  const ringKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.4)"],
    [0.4, "opacity:0;transform:scale(3.2)"],
    [duration, "opacity:0;transform:scale(3.2)"]
  ]);
  const sparkKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.5) rotate(0deg)"],
    [0.55, "opacity:0;transform:scale(2.1) rotate(35deg)"],
    [duration, "opacity:0;transform:scale(2.1) rotate(35deg)"]
  ]);
  const bulletKfs = /* @__PURE__ */ new Map();
  const starColors = dark ? ["#ff7a7a", "#7ad0ff", "#ffe27a", "#ffffff", "#8dffa8", "#cfa0ff"] : ["#d9534f", "#2f8fd4", "#c79a00", "#6a6f85", "#2fa05a", "#8250df"];
  const layers = [];
  const speeds = [26, 44, 70];
  const sizes = [1, 1.3, 1.7];
  for (let li = 0; li < 3; li++) {
    const dots = [];
    for (let i = 0; i < 22; i++) {
      const x = fmt(rng() * layout.width);
      const y = rng() * layout.height;
      const color = starColors[Math.floor(rng() * starColors.length)];
      const tw = `tw${Math.floor(rng() * 3)}`;
      const delay = fmt(-rng() * 3);
      const s = sizes[li];
      for (const dy of [0, -layout.height]) {
        dots.push(`<rect class="${tw}" style="animation-delay:${delay}s" x="${x}" y="${fmt(y + dy)}" width="${s}" height="${s}" fill="${color}"/>`);
      }
    }
    layers.push(`<g class="sc" style="animation-duration:${fmt(layout.height / speeds[li])}s">${dots.join("")}</g>`);
  }
  const tiles = [];
  for (const column of grid.cells) for (const cell of column) if (cell) tiles.push(cellRect(layout, cell, theme.empty));
  const css = (x, y, r, op = 1) => `opacity:${op};transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(r)}deg)`;
  const capture = sim.capture;
  const rescue = sim.rescue;
  const lookId = (e) => `e-${e.kind}${e.kind === "bee" ? e.cell.level : e.kind === "butterfly" ? 3 : 4}`;
  const enemyEls = [];
  const clears = [];
  const routeRaw = (route, start, upTo, raw) => {
    for (let i = 0; i < route.t.length; i++) {
      if (upTo !== null && route.t[i] >= upTo) break;
      raw.push({ t: at(start + route.t[i]), x: route.x[i], y: route.y[i], r: route.r[i], op: 1 });
    }
    if (upTo !== null) {
      const p = routeAt(route, upTo);
      raw.push({ t: at(start + upTo), x: p.x, y: p.y, r: p.r, op: 1 });
    }
  };
  for (const e of sim.enemies) {
    const [sx, sy] = e.slot;
    const raw = [{ t: 0, x: sx, y: sy, r: 0, op: 1 }];
    const rest = (t, op = 1) => raw.push({ t, x: sx, y: sy, r: 0, op });
    const isCaptor = capture !== null && capture.boss === e.id;
    let dives = e.dives;
    if (isCaptor) {
      const c = dives[0];
      rest(at(c.start));
      routeRaw(c.route, c.start, null, raw);
      const last = c.route.t.length - 1;
      raw.push({ t: at(capture.returnStart), x: c.route.x[last], y: c.route.y[last], r: c.route.r[last], op: 1 });
      raw.push({ t: at(capture.returnStart), x: capture.hover[0], y: capture.hover[1], r: 0, op: 1 });
      rest(at(capture.returnEnd));
      dives = dives.slice(1);
    }
    for (const d of dives) {
      rest(at(d.start));
      if (d.killed) {
        routeRaw(d.route, d.start, d.end - d.start, raw);
      } else {
        routeRaw(d.route, d.start, null, raw);
        rest(at(d.end));
      }
    }
    if (e.death !== null) {
      const td = at(e.death);
      if (!e.dives.some((d) => d.killed)) rest(td);
      const last = raw[raw.length - 1];
      raw.push({ ...last, t: td + 1e-3, op: 0 });
      clears.push({ t: td, cell: e.cell });
    }
    rest(restore, 0);
    rest(fadeEnd);
    const id = lookId(e);
    const flap = (suffix) => `<use href="#${id}-${suffix[0]}" class="fa"/><use href="#${id}-${suffix[1]}" class="fb"/>`;
    if (e.kind !== "boss") {
      const cls = tl.track(raw.map((q) => [q.t, `opacity:${q.op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px) rotate(${fmt(q.r)}deg)`]));
      enemyEls.push(`<g class="${cls}">${flap(["a", "b"])}</g>`);
      continue;
    }
    const hit = e.hit === null ? null : at(e.hit);
    const healthy = tl.track(hit === null ? [[0, "opacity:1"]] : [[0, "opacity:1"], [hit, "opacity:1"], [hit, "opacity:0"], [restore, "opacity:0"], [restore, "opacity:1"]]);
    const hurt = tl.track(hit === null ? [[0, "opacity:0"]] : [[0, "opacity:0"], [hit, "opacity:0"], [hit, "opacity:1"], [restore, "opacity:1"], [restore, "opacity:0"]]);
    const look = `<g class="${healthy}">${flap(["a", "b"])}</g><g class="${hurt}">${flap(["c", "d"])}</g>`;
    const pos = tl.track(raw.map((q) => [q.t, `opacity:${q.op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px)`]));
    const rot = tl.track(raw.map((q) => [q.t, `transform:rotate(${fmt(q.r)}deg)`]));
    let captive = "";
    if (isCaptor && capture) {
      const shown = at(capture.abductEnd);
      const gone = rescue ? at(rescue.t) : restore;
      const capTrack = tl.track([[0, "opacity:0"], [shown, "opacity:0"], [shown, "opacity:1"], [gone, "opacity:1"], [gone, "opacity:0"]]);
      captive = `<use href="#shipr" class="${capTrack}" y="19"/>`;
    }
    enemyEls.push(`<g class="${pos}"><g class="${rot}">${look}</g>${captive}</g>`);
  }
  let beam = "";
  if (capture) {
    const [hx, hy] = capture.hover;
    const top = hy + 9;
    const height = FIGHTER_Y + 16 - top;
    const w0 = 5;
    const w1 = 22;
    const lines = [];
    for (let i = 0; i < 6; i++) {
      const y = height / 6 * (i + 0.5);
      const half = w0 + (w1 - w0) * y / height;
      lines.push(`<path class="bl" style="animation-delay:${fmt(-i * 0.09)}s" d="M${fmt(-half)} ${fmt(y)}Q0 ${fmt(y + 5)} ${fmt(half)} ${fmt(y)}" fill="none" stroke="#bfeaff" stroke-width="1.6"/>`);
    }
    const on = at(capture.beamOn);
    const off = at(capture.beamOff);
    const grow = tl.track([
      [0, "opacity:0;transform:scaleY(.05)"],
      [on, "opacity:0;transform:scaleY(.05)"],
      [on + 0.12, "opacity:1;transform:scaleY(.2)"],
      [on + 0.55, "opacity:1;transform:scaleY(1)"],
      [off, "opacity:1;transform:scaleY(1)"],
      [off + 0.3, "opacity:0;transform:scaleY(1)"]
    ]);
    beam = `<g transform="translate(${fmt(hx)} ${fmt(top)})"><g class="${grow}" style="transform-origin:0 0"><polygon points="${fmt(-w0)} 0 ${fmt(w0)} 0 ${fmt(w1)} ${fmt(height)} ${fmt(-w1)} ${fmt(height)}" fill="#4db8ff" opacity=".28"/>${lines.join("")}</g></g>`;
  }
  const breath = [[0, "transform:scale(1)"]];
  for (let k = 0; k * BREATH_STEP <= sim.end + 1e-6; k++) breath.push([at(k * BREATH_STEP), `transform:scale(${(1 + breathAt(k * BREATH_STEP)).toFixed(4)})`]);
  breath.push([at(sim.end) + 0.01, "transform:scale(1)"], [duration, "transform:scale(1)"]);
  const breathCls = hasPlay ? tl.track(breath) : tl.track([[0, "transform:scale(1)"]]);
  const shotEls = [];
  for (const s of sim.shots) {
    const dist = s.y0 - s.yEnd;
    const dur = Math.round((s.tEnd - s.t) * scale * 200) / 200;
    if (dist < 1 || dur <= 0) continue;
    const key = `${Math.round(dist * 2)}:${dur}`;
    let name = bulletKfs.get(key);
    if (!name) {
      name = tl.keyframes([
        [0, "opacity:1;transform:translateY(0px)"],
        [dur, "opacity:1;transform:translateY(" + fmt(-dist) + "px)"],
        [dur + 1e-3, "opacity:0;transform:translateY(" + fmt(-dist) + "px)"],
        [duration, "opacity:0;transform:translateY(" + fmt(-dist) + "px)"]
      ]);
      bulletKfs.set(key, name);
    }
    const cls = tl.useKeyframes(name, at(s.t));
    shotEls.push(`<g transform="translate(${fmt(s.x)} ${fmt(s.y0)})"><g class="${cls}"><rect x="-1.4" y="-5" width="2.8" height="10" rx="1" fill="${theme.accent}"/><rect x="-.5" y="-5" width="1" height="8" fill="#fff"/></g></g>`);
  }
  const boomEls = [];
  for (const b of sim.booms) {
    const t = at(b.t);
    const k = b.size === "l" ? 1.9 : b.size === "m" ? 1.35 : 1;
    const parts = [
      `<use href="#bs" class="${tl.useKeyframes(starKf, t)}"/>`,
      `<use href="#br" class="${tl.useKeyframes(ringKf, t)}"/>`,
      `<use href="#bp" fill="${theme.accent}" class="${tl.useKeyframes(sparkKf, t)}"/>`
    ];
    if (b.size === "l") parts.push(`<use href="#br" class="${tl.useKeyframes(ringKf, t + 0.12)}" stroke="${theme.accent}"/>`);
    boomEls.push(`<g transform="translate(${fmt(b.x)} ${fmt(b.y)}) scale(${k})">${parts.join("")}</g>`);
  }
  const keyCss = (k) => `transform:translate(${fmt(k.x)}px,${fmt(k.y)}px) rotate(${fmt(k.rot)}deg) scale(${fmt(k.scale)})`;
  const fighterFrames = [];
  for (const k of sim.fighter) fighterFrames.push([at(k.t), keyCss(k)]);
  const startKey = sim.fighter[0] ?? { x: cx, y: FIGHTER_Y, rot: 0, scale: 1, t: 0 };
  const endKey = sim.fighter[sim.fighter.length - 1] ?? startKey;
  const hideAt = restore + 0.3;
  fighterFrames.push([hideAt, keyCss(endKey)], [hideAt, keyCss(startKey)], [duration, keyCss(startKey)]);
  const fighterCls = tl.track(hasPlay ? fighterFrames : [[0, keyCss(startKey)]]);
  const fadeFrames = sim.fade.map((k) => [at(k.t), `opacity:${k.opacity}`]);
  fadeFrames.push([restore, "opacity:1"], [hideAt, "opacity:0"], [duration - 0.45, "opacity:0"], [duration - 0.1, "opacity:1"]);
  const fadeCls = tl.track(hasPlay ? fadeFrames : [[0, "opacity:1"]]);
  const dualAt = rescue ? at(rescue.dockAt) : -1;
  const shipB = tl.track(rescue ? [[0, "opacity:0"], [dualAt, "opacity:0"], [dualAt, "opacity:1"], [restore, "opacity:1"], [hideAt, "opacity:0"]] : [[0, "opacity:0"]]);
  let flyer = "";
  if (rescue) {
    const t0 = at(rescue.t);
    const t1 = at(rescue.dockAt);
    const ff = [[0, "opacity:0"], [t0, "opacity:0"]];
    const [fx0, fy0] = rescue.from;
    const [fx1, fy1] = rescue.to;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const ease = u * u * (3 - 2 * u);
      const x = fx0 + (fx1 - fx0) * ease;
      const y = fy0 + (fy1 - fy0) * ease - Math.sin(Math.PI * u) * 26;
      ff.push([t0 + (t1 - t0) * u, `opacity:1;transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(720 * (1 - ease))}deg)`]);
    }
    ff.push([t1 + 1e-3, `opacity:0;transform:translate(${fmt(fx1)}px,${fmt(fy1)}px) rotate(0deg)`], [duration, `opacity:0;transform:translate(${fmt(fx1)}px,${fmt(fy1)}px) rotate(0deg)`]);
    flyer = `<g${glowAttr(theme)}><use href="#shipw" class="${tl.track(ff)}"/></g>`;
  }
  const stageCss = [
    ".sc{animation:scroll linear infinite}",
    `@keyframes scroll{from{transform:translateY(0)}to{transform:translateY(${layout.height}px)}}`,
    ".tw0{animation:tw .9s ease-in-out infinite}.tw1{animation:tw 1.4s ease-in-out infinite}.tw2{animation:tw 2.1s ease-in-out infinite}",
    "@keyframes tw{0%,100%{opacity:.95}50%{opacity:.25}}",
    ".fa{animation:flapa .7s steps(1) infinite}.fb{animation:flapb .7s steps(1) infinite}",
    "@keyframes flapa{0%{opacity:1}50%{opacity:0}}@keyframes flapb{0%{opacity:0}50%{opacity:1}}",
    ".bl{animation:beam .6s linear infinite}",
    "@keyframes beam{0%{opacity:0}30%{opacity:1}100%{opacity:0}}",
    `.breath{transform-origin:${fmt(cx)}px ${fmt(cy)}px}`
  ].join("\n");
  const hudMarkup = hud(tl, grid, { theme, title: "GALAGA", clears, resetAt: restore, width: layout.width });
  const endCard = banner(tl, { theme, lines: stageClearLines(grid), cx, cy, from: playEnd + 0.2, to: restore });
  const body = [
    `<g>${layers.join("")}</g>`,
    `<g>${tiles.join("")}</g>`,
    `<g class="breath ${breathCls}"${glowAttr(theme)}>${beam}${enemyEls.join("")}</g>`,
    `<g${glowAttr(theme)}>${shotEls.join("")}</g>`,
    `<g${glowAttr(theme)}>${boomEls.join("")}</g>`,
    flyer,
    `<g class="${fighterCls}"><g class="${fadeCls}"${glowAttr(theme)}><use href="#shipw"/><use href="#shipw" x="${SEP}" class="${shipB}"/></g></g>`,
    hudMarkup,
    endCard
  ].join("\n");
  return { width: layout.width, height: layout.height, css: `${stageCss}
${tl.css()}`, defs: defs.join(""), body };
}
var galaga = { id: "galaga", title: "Galaga", render: render4 };

// src/games/invaders.ts
var OCTOPUS = [
  [
    "....####....",
    ".##########.",
    "############",
    "###..##..###",
    "############",
    "...##..##...",
    "..##.##.##..",
    "##........##"
  ],
  [
    "....####....",
    ".##########.",
    "############",
    "###..##..###",
    "############",
    "..###..###..",
    ".##..##..##.",
    "..##....##.."
  ]
];
var CRAB = [
  [
    "..#.....#..",
    "...#...#...",
    "..#######..",
    ".##.###.##.",
    "###########",
    "#.#######.#",
    "#.#.....#.#",
    "...##.##..."
  ],
  [
    "..#.....#..",
    "#..#...#..#",
    "#.#######.#",
    "###.###.###",
    "###########",
    ".#########.",
    "..#.....#..",
    ".#.......#."
  ]
];
var SQUID = [
  [
    "...##...",
    "..####..",
    ".######.",
    "##.##.##",
    "########",
    "..#..#..",
    ".#.##.#.",
    "#.#..#.#"
  ],
  [
    "...##...",
    "..####..",
    ".######.",
    "##.##.##",
    "########",
    ".#.##.#.",
    "#......#",
    ".#....#."
  ]
];
var SPRITE_ID = ["o", "o", "c", "s"];
var BLAST = [
  "..#...#...#..",
  "...#..#..#...",
  "....#.#.#....",
  "###.......###",
  "....#.#.#....",
  "...#..#..#...",
  "..#...#...#.."
];
var UFO = [
  ".....######.....",
  "...##########...",
  "..############..",
  ".##.##.##.##.##.",
  "################",
  "..###..##..###..",
  "...#........#..."
];
var CANNON = [
  "......#......",
  ".....###.....",
  ".....###.....",
  ".###########.",
  "#############",
  "#############",
  "#############",
  "#############"
];
var SPLAT = [".#..#.", "#.##.#", ".####.", "#.##.#", ".#..#."];
var BUNKER = [
  "..#########..",
  ".###########.",
  "#############",
  "#############",
  "#############",
  "#############",
  "####.....####",
  "###.......###"
];
var ZIGZAG = [1, 2, 1, 0];
var bombRows = (phase) => Array.from({ length: 7 }, (_, y) => ".".repeat(ZIGZAG[(y + phase) % 4]) + "#" + ".".repeat(2 - ZIGZAG[(y + phase) % 4]));
var SPRITE_SCALE2 = [1, 1, 12 / 11, 1.5];
var BLAST_SCALE = 1.25;
var CANNON_SCALE = 2;
var UFO_SCALE = 1.5;
var CANNON_HALF = 13;
var SHOT_SPEED = 620;
var BOMB_SPEED = 170;
var UFO_SPEED = 190;
var CANNON_SPEED = 650;
var HOLD = 0.04;
var SWAY = [0, 2, 4, 6, 8, 6, 4, 2, 0, -2, -4, -6, -8, -6, -4, -2];
var TARGET_PLAY4 = 38;
var BUNKER_TILE = 2;
var BUNKER_COLS = 13;
var BUNKER_ROWS = 8;
var UFO_AFTER = [0.15, 0.55];
var RUSH_SHARE = 0.3;
var SHOT_CHIPS_PER_BUNKER = 2;
var BUNKER_LANE_COST = 70;
var SHOT_H = 10;
var SHOT_LEAD = 6;
function makeField(grid) {
  const layout = arcadeLayout(grid);
  const bottom = layout.top + layout.gridHeight;
  const bunkerWidth = BUNKER_COLS * BUNKER_TILE;
  const slot = (layout.gridWidth + 4) / 4;
  return {
    layout,
    width: layout.width,
    height: layout.height,
    ufoY: 33,
    bunkerTop: bottom + 12,
    cannonY: bottom + 34,
    groundY: bottom + 54,
    bunkerX: [0, 1, 2, 3].map((i) => Math.round(layout.left + slot * (i + 0.5) - bunkerWidth / 2 - 2)),
    startX: Math.round(layout.width / 2)
  };
}
var species = (cell) => cell.level - 1;
var columnX = (layout, col) => layout.left + col * layout.pitch + layout.cell / 2;
var spriteHeight = (cell) => 8 * SPRITE_SCALE2[species(cell)];
var spriteTop = (layout, cell) => layout.top + cell.y * layout.pitch + (layout.cell - spriteHeight(cell)) / 2;
var spriteBottom = (layout, cell) => spriteTop(layout, cell) + spriteHeight(cell);
function buildMarch(aliveAt, total, end) {
  const times = [];
  const offsets = [];
  let t = 0;
  for (let k = 1; ; k++) {
    const alive = Math.max(1, aliveAt(t));
    t += 0.1 + 0.42 * Math.pow(alive / total, 0.7);
    if (t > end) break;
    times.push(t);
    offsets.push(SWAY[k % SWAY.length]);
  }
  return { times, offsets };
}
function offsetAt(m, t) {
  let lo = -1;
  let hi = m.times.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (m.times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo < 0 ? 0 : m.offsets[lo];
}
function planShots(field, grid, cells, march, fireGap, rng) {
  const { layout, cannonY, ufoY } = field;
  const cols = grid.width;
  const columns = Array.from({ length: cols }, () => []);
  for (const c of cells) columns[c.x].push(c);
  for (const col of columns) col.sort((a, b) => b.y - a.y);
  const total = cells.length;
  const lock = new Array(cols).fill(-Infinity);
  const plan = { shots: [], ufos: [], kills: /* @__PURE__ */ new Map(), killX: /* @__PURE__ */ new Map() };
  let remaining = total;
  let lastFire = -fireGap;
  let cannonX = field.startX;
  let lastDir = 0;
  let pending = null;
  const ufoFlight = (cannonY - SHOT_LEAD - (ufoY + 7 * UFO_SCALE)) / SHOT_SPEED;
  const lanes = field.bunkerX.map((x) => [x - 3, x + BUNKER_COLS * BUNKER_TILE + 3]);
  const underBunker = (x) => lanes.some(([a, b]) => x > a && x < b);
  const tryPlanUfo = () => {
    const clear = [];
    for (let c = 0; c < cols; c++) if (columns[c].length === 0) clear.push(c);
    if (clear.length === 0) return;
    clear.sort((a, b) => Math.abs(columnX(layout, a) - cannonX) - Math.abs(columnX(layout, b) - cannonX));
    const col = clear[0];
    let lastKill = lastFire;
    for (const c of cells) if (c.x === col) lastKill = Math.max(lastKill, plan.kills.get(c) ?? 0);
    let best = null;
    for (const dir of [1, -1]) {
      const startX = dir > 0 ? -10 : field.width + 10;
      let hit = lastFire + 1;
      let x = columnX(layout, col);
      for (let i = 0; i < 3; i++) {
        x = columnX(layout, col) + offsetAt(march, hit);
        const cross = Math.abs(x - startX) / UFO_SPEED;
        hit = Math.max(
          lastFire + 0.2 + cross,
          lastFire + fireGap + HOLD + Math.abs(x - cannonX) / CANNON_SPEED + 0.1 + ufoFlight,
          lastKill + ufoFlight + 0.1
        );
      }
      x = columnX(layout, col) + offsetAt(march, hit);
      if (!best || hit < best.hit) best = { hit, x, dir };
    }
    if (!best) return;
    const scores = [50, 100, 150, 300];
    const ufo = {
      start: best.hit - Math.abs(best.x - (best.dir > 0 ? -10 : field.width + 10)) / UFO_SPEED,
      dir: best.dir,
      hit: best.hit,
      hitX: best.x,
      score: scores[Math.floor(rng() * scores.length)]
    };
    plan.ufos.push(ufo);
    pending = { fire: best.hit - ufoFlight, hit: best.hit, x: best.x, ufo };
  };
  const fireUfo = () => {
    const p = pending;
    plan.shots.push({ fire: p.fire, hit: p.hit, x: p.x, y: ufoY + 7 * UFO_SCALE, cell: null });
    lastDir = Math.sign(p.x - cannonX) || lastDir;
    lastFire = p.fire;
    cannonX = p.x;
    pending = null;
  };
  while (remaining > 0 || pending) {
    if (!pending && plan.ufos.length < UFO_AFTER.length && (total - remaining) / total >= UFO_AFTER[plan.ufos.length]) tryPlanUfo();
    if (remaining === 0) {
      fireUfo();
      continue;
    }
    const rush = Math.max(0, 1 - remaining / (total * RUSH_SHARE));
    const gap = fireGap * (1 - 0.65 * rush);
    const speed = CANNON_SPEED * (1 + 1.6 * rush);
    let best = null;
    for (let col = 0; col < cols; col++) {
      const cell2 = columns[col][0];
      if (!cell2) continue;
      const bottom = spriteBottom(layout, cell2);
      const flight = (cannonY - SHOT_LEAD - bottom) / SHOT_SPEED;
      let fire = lastFire + gap;
      let hit = fire + flight;
      let x = columnX(layout, col) + offsetAt(march, hit);
      for (let i = 0; i < 3; i++) {
        fire = Math.max(lastFire + gap, lastFire + HOLD + Math.abs(x - cannonX) / speed);
        hit = fire + flight;
        x = columnX(layout, col) + offsetAt(march, hit);
      }
      if (fire < lock[col]) continue;
      const dx = x - cannonX;
      const dir = Math.sign(dx);
      const cost = Math.abs(dx) + (dir !== 0 && dir !== lastDir && Math.abs(dx) > 3 ? 22 : 0) + 2.5 * columns[col].length + (underBunker(x) ? BUNKER_LANE_COST : 0) + rng() * 5;
      if (!best || cost < best.cost) best = { col, fire, hit, x, cost };
    }
    if (!best) {
      lastFire += gap;
      continue;
    }
    if (pending && best.fire + HOLD + Math.abs(pending.x - best.x) / speed > pending.fire) {
      fireUfo();
      continue;
    }
    const cell = columns[best.col].shift();
    plan.shots.push({ fire: best.fire, hit: best.hit, x: best.x, y: spriteBottom(layout, cell), cell });
    plan.kills.set(cell, best.hit);
    plan.killX.set(cell, best.x);
    lock[best.col] = best.hit;
    lastDir = Math.sign(best.x - cannonX) || lastDir;
    lastFire = best.fire;
    cannonX = best.x;
    remaining--;
  }
  return plan;
}
function simulateInvaders(grid, rng) {
  const field = makeField(grid);
  const { layout } = field;
  const cells = activeCells(grid);
  const total = cells.length;
  const play = {
    field,
    march: { times: [], offsets: [] },
    shots: [],
    kills: [],
    ufos: [],
    bombs: [],
    chips: [],
    length: 5.6,
    cannonPath: [{ t: 0, x: field.startX }]
  };
  const fireGap = Math.min(0.5, Math.max(0.1, TARGET_PLAY4 / Math.max(total, 1)));
  if (total === 0) {
    play.march = buildMarch(() => 1, 1, 0);
    play.ufos.push({ start: 0.3, dir: 1, hit: null, hitX: 0, score: 0 });
    play.cannonPath.push({ t: 1.4, x: field.startX - 36 }, { t: 3.2, x: field.startX + 36 }, { t: 4.6, x: field.startX });
    return play;
  }
  let aliveAt = (t) => total * (1 - t / (total * fireGap * 1.4));
  let march = buildMarch(aliveAt, total, total * fireGap * 1.6 + 8);
  let plan = planShots(field, grid, cells, march, fireGap, rng);
  for (let pass = 0; pass < 2; pass++) {
    const times = [...plan.kills.values()].sort((a, b) => a - b);
    const end = (times[times.length - 1] ?? 0) + 2;
    aliveAt = (t) => {
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (times[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      return total - lo;
    };
    march = buildMarch(aliveAt, total, end);
    plan = planShots(field, grid, cells, march, fireGap, rng);
  }
  play.march = march;
  play.shots = plan.shots;
  play.ufos = plan.ufos;
  play.kills = cells.map((cell) => ({ cell, t: plan.kills.get(cell), x: plan.killX.get(cell) })).sort((a, b) => a.t - b.t);
  for (const s of plan.shots) {
    play.cannonPath.push({ t: s.fire, x: s.x }, { t: s.fire + HOLD, x: s.x });
  }
  const lastHit = Math.max(...plan.shots.map((s) => s.hit));
  const cannonAt = (t) => {
    const p = play.cannonPath;
    let i = 0;
    while (i < p.length - 1 && p[i + 1].t <= t) i++;
    if (i >= p.length - 1) return p[p.length - 1].x;
    const f = (t - p[i].t) / Math.max(p[i + 1].t - p[i].t, 1e-6);
    return p[i].x + (p[i + 1].x - p[i].x) * Math.min(Math.max(f, 0), 1);
  };
  const killTime = plan.kills;
  const aliveBelow = (col, t) => {
    let found = null;
    for (const c of cells) {
      if (c.x === col && (killTime.get(c) ?? 0) > t && (!found || c.y > found.y)) found = c;
    }
    return found;
  };
  const bombs = [];
  const bunkerSpan = field.bunkerX.map((x) => [x, x + BUNKER_COLS * BUNKER_TILE]);
  const colsList = Array.from({ length: grid.width }, (_, i) => i);
  for (let t = 1.1 + rng() * 0.6; t < lastHit - 0.8; t += 0.8 + rng() * 0.9) {
    const offset = offsetAt(march, t);
    const options = colsList.map((col) => ({ col, cell: aliveBelow(col, t) })).filter((o) => o.cell !== null);
    if (options.length === 0) break;
    const over = options.filter((o) => {
      const x = columnX(layout, o.col) + offset;
      return bunkerSpan.some(([a, b]) => x > a && x < b);
    });
    const pool = over.length > 0 && rng() < 0.5 ? over : options;
    for (let tries = 0; tries < 8; tries++) {
      const pick = pool[Math.floor(rng() * pool.length)];
      const x = columnX(layout, pick.col) + offset;
      const y0 = spriteBottom(layout, pick.cell);
      const reaches = t + (field.cannonY - 7 - y0) / BOMB_SPEED;
      if (Math.abs(cannonAt(reaches) - x) < CANNON_HALF + 6 || Math.abs(cannonAt(reaches + 0.12) - x) < CANNON_HALF + 6) continue;
      bombs.push({ t, x, y0 });
      break;
    }
  }
  const tiles = field.bunkerX.map(() => BUNKER.map((row) => [...row].map((ch) => ch === "#")));
  const bunkerAt = (x) => bunkerSpan.findIndex(([a, b]) => x >= a && x < b);
  const events = [];
  bombs.forEach((b, index) => events.push({ t: b.t + (field.bunkerTop - 7 - b.y0) / BOMB_SPEED, kind: "bomb", index }));
  for (const s of plan.shots) {
    events.push({ t: s.fire + (field.cannonY - SHOT_LEAD - (field.bunkerTop + BUNKER_ROWS * BUNKER_TILE)) / SHOT_SPEED, kind: "shot", x: s.x });
  }
  events.sort((a, b) => a.t - b.t);
  const resolved = new Array(bombs.length);
  const shotChips = field.bunkerX.map(() => 0);
  for (const ev of events) {
    if (ev.kind === "shot") {
      const b2 = bunkerAt(ev.x);
      if (b2 < 0 || shotChips[b2] >= SHOT_CHIPS_PER_BUNKER) continue;
      shotChips[b2]++;
      const col2 = Math.floor((ev.x - field.bunkerX[b2]) / BUNKER_TILE);
      const removed2 = [];
      for (let row2 = BUNKER_ROWS - 1, taken = 0; row2 >= 0 && taken < 2; row2--) {
        if (!tiles[b2][row2][col2]) continue;
        tiles[b2][row2][col2] = false;
        removed2.push([b2, col2, row2]);
        taken++;
        if (rng() < 0.55) break;
      }
      if (removed2.length) play.chips.push({ t: ev.t, tiles: removed2 });
      continue;
    }
    const bomb = bombs[ev.index];
    const b = bunkerAt(bomb.x);
    let row = -1;
    let col = 0;
    if (b >= 0) {
      col = Math.floor((bomb.x - field.bunkerX[b]) / BUNKER_TILE);
      for (let r = 0; r < BUNKER_ROWS; r++) {
        if (tiles[b][r][col]) {
          row = r;
          break;
        }
      }
    }
    if (row < 0) {
      const y12 = field.groundY - 7;
      resolved[ev.index] = { ...bomb, y1: y12, end: bomb.t + (y12 - bomb.y0) / BOMB_SPEED, kind: "ground" };
      continue;
    }
    const y1 = field.bunkerTop + row * BUNKER_TILE - 7;
    const end = bomb.t + (y1 - bomb.y0) / BOMB_SPEED;
    resolved[ev.index] = { ...bomb, y1, end, kind: "bunker" };
    const radius = 1.6 + rng() * 0.9;
    const removed = [];
    for (let r = 0; r < BUNKER_ROWS; r++) {
      for (let c = 0; c < BUNKER_COLS; c++) {
        if (!tiles[b][r][c]) continue;
        const dist = Math.hypot(c - col, (r - (row + 1)) * 0.9);
        if (dist <= radius - 0.6 || dist <= radius && rng() < 0.55) {
          tiles[b][r][c] = false;
          removed.push([b, c, r]);
        }
      }
    }
    if (removed.length) play.chips.push({ t: end, tiles: removed });
  }
  play.bombs = resolved.filter(Boolean);
  if (play.ufos.length === 0) {
    play.ufos.push({ start: Math.max(1, lastHit * 0.3), dir: rng() < 0.5 ? 1 : -1, hit: null, hitX: 0, score: 0 });
  }
  const ufoEnd = Math.max(...play.ufos.map((u) => u.hit ?? u.start + (field.width + 16) / UFO_SPEED));
  play.length = Math.max(lastHit + 0.3, ufoEnd + 0.1, ...play.bombs.map((b) => b.end + 0.25));
  return play;
}
var tri = (t, ...css) => css.map((c) => [t, c]);
function render5(ctx) {
  const { grid, theme, rng } = ctx;
  const sim = simulateInvaders(grid, rng);
  const { field } = sim;
  const { layout } = field;
  const play = sim.length;
  const duration = loopDuration(play);
  const back = restoreAt(play);
  const intro = PACE.intro;
  const at = (t) => intro + t;
  const tl = new Timeline(duration, "i");
  const light = parseInt(theme.ink.slice(1, 3), 16) < 128;
  const green = theme.name === "github-dark" ? "#20ff20" : light ? "#1a7f37" : theme.accent;
  const red = light ? "#cf222e" : theme.name === "github-dark" ? "#ff3b3b" : "#ff4d6d";
  const glow = glowAttr(theme);
  const halo = (color) => theme.glow > 0 ? ` stroke="${color}" stroke-opacity=".3" stroke-width="${theme.glow > 2 ? 2.6 : 1.8}" stroke-linejoin="round"` : "";
  const ink = theme.ink;
  const delay = (t) => `style="--d:${(-(duration - at(t))).toFixed(3)}s"`;
  const empty = sim.kills.length === 0;
  const defs = [];
  const names = ["o", "c", "s"];
  [OCTOPUS, CRAB, SQUID].forEach((frames2, i) => {
    frames2.forEach((rows, f) => defs.push(`<path id="${names[i]}${f}" d="${bitmapPath(rows, [SPRITE_SCALE2[0], SPRITE_SCALE2[2], SPRITE_SCALE2[3]][i])}"/>`));
  });
  defs.push(`<path id="bl" d="${bitmapPath(BLAST, BLAST_SCALE)}"/>`, `<path id="sp" d="${bitmapPath(SPLAT)}"/>`);
  defs.push(`<path id="uf" d="${bitmapPath(UFO, UFO_SCALE)}"/>`, `<path id="cn" d="${bitmapPath(CANNON, CANNON_SCALE)}"/>`);
  for (let i = 0; i < 4; i++) defs.push(`<path id="bm${i}" d="${bitmapPath(bombRows(i))}"/>`);
  const parts = [];
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));
  const marchFrames = [[0, "transform:translate(0px,0px)"]];
  const legA = [[0, "opacity:1"]];
  const legB = [[0, "opacity:0"]];
  const lastKill = sim.kills.length ? sim.kills[sim.kills.length - 1].t : 0;
  sim.march.times.forEach((t, i) => {
    if (t > lastKill + 0.01) return;
    const T = at(t);
    const showA = (i + 1) % 2 === 0;
    marchFrames.push([T, marchFrames[marchFrames.length - 1][1]], [T, translate(sim.march.offsets[i], 0)]);
    legA.push([T, `opacity:${showA ? 0 : 1}`], [T, `opacity:${showA ? 1 : 0}`]);
    legB.push([T, `opacity:${showA ? 1 : 0}`], [T, `opacity:${showA ? 0 : 1}`]);
  });
  marchFrames.push([at(lastKill) + 0.05, marchFrames[marchFrames.length - 1][1]], [at(lastKill) + 0.05, "transform:translate(0px,0px)"]);
  legA.push([at(lastKill) + 0.05, "opacity:1"]);
  legB.push([at(lastKill) + 0.05, "opacity:0"]);
  const marchClass = tl.track(marchFrames);
  const legAClass = tl.track(legA);
  const legBClass = tl.track(legB);
  const invaders2 = [];
  const blasts = [];
  const blastKeys = tl.keyframes([[0, "opacity:1"], [0.26, "opacity:1"], [0.261, "opacity:0"]]);
  for (const kill of sim.kills) {
    const { cell } = kill;
    const kind = species(cell);
    const id = SPRITE_ID[kind];
    const x = layout.left + cell.x * layout.pitch;
    const y = spriteTop(layout, cell);
    const T = at(kill.t);
    const cls = tl.track([
      [0, "opacity:1"],
      [T, "opacity:1"],
      [T + 1e-3, "opacity:0"],
      [back, "opacity:0"],
      [back + PACE.restore, "opacity:1"]
    ]);
    invaders2.push(
      `<g class="${cls}" fill="${spriteColor(theme, cell)}"${halo(spriteColor(theme, cell))}><use class="${legAClass}" href="#${id}0" x="${fmt(x)}" y="${fmt(y)}"/><use class="${legBClass}" href="#${id}1" x="${fmt(x)}" y="${fmt(y)}"/></g>`
    );
    const cx = columnX(layout, cell.x) + offsetAt(sim.march, kill.t);
    blasts.push(`<use class="bx" href="#bl" x="${fmt(cx - 6.5 * BLAST_SCALE)}" y="${fmt(y + spriteHeight(cell) / 2 - 3.5 * BLAST_SCALE)}" ${delay(kill.t)}/>`);
  }
  parts.push(`<g class="${marchClass}">${invaders2.join("")}</g>`);
  parts.push(`<g fill="${ink}"${halo(ink)}>${blasts.join("")}</g>`);
  const gone = /* @__PURE__ */ new Set();
  for (const chip of sim.chips) for (const [b, c, r] of chip.tiles) gone.add(`${b}:${c}:${r}`);
  const bunkerStatic = [];
  field.bunkerX.forEach((bx, b) => {
    const rows = BUNKER.map((row, r) => [...row].map((ch, c) => ch === "#" && !gone.has(`${b}:${c}:${r}`) ? "#" : ".").join(""));
    bunkerStatic.push(bitmapPath(rows, BUNKER_TILE, bx, field.bunkerTop));
  });
  parts.push(`<path d="${bunkerStatic.join("")}" fill="${green}"${glow}/>`);
  for (const chip of sim.chips) {
    const d = chip.tiles.map(([b, c, r]) => bitmapPath(["#"], BUNKER_TILE, field.bunkerX[b] + c * BUNKER_TILE, field.bunkerTop + r * BUNKER_TILE)).join("");
    const T = at(chip.t);
    const cls = tl.track([
      [0, "opacity:1"],
      [T, "opacity:1"],
      [T + 1e-3, "opacity:0"],
      [back, "opacity:0"],
      [back + PACE.restore, "opacity:1"]
    ]);
    parts.push(`<path class="${cls}" d="${d}" fill="${green}"/>`);
  }
  parts.push(`<rect x="4" y="${field.groundY}" width="${field.width - 8}" height="2" fill="${green}" opacity=".75"/>`);
  const shotKeys = /* @__PURE__ */ new Map();
  const shotCss = [];
  const shotEls = [];
  for (const s of sim.shots) {
    const travel = Math.round(field.cannonY - SHOT_LEAD - s.y);
    let name = shotKeys.get(travel);
    if (!name) {
      const flight = travel / SHOT_SPEED;
      name = tl.keyframes([
        [0, "opacity:1;transform:translateY(0px)"],
        [flight, `opacity:1;transform:translateY(${-travel}px)`],
        [flight + 1e-3, `opacity:0;transform:translateY(${-travel}px)`]
      ]);
      shotKeys.set(travel, name);
      shotCss.push(`.sh${shotKeys.size}{animation:${name} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`);
    }
    const idx = [...shotKeys.keys()].indexOf(travel) + 1;
    shotEls.push(`<rect class="sh${idx}" x="${fmt(s.x - 1)}" y="${field.cannonY - SHOT_LEAD}" width="2" height="${SHOT_H}" stroke="${green}" stroke-opacity=".55" stroke-width="2" ${delay(s.fire)}/>`);
  }
  parts.push(`<g fill="${ink}">${shotEls.join("")}</g>`);
  const splatKeys = tl.keyframes([[0, "opacity:1"], [0.2, "opacity:1"], [0.201, "opacity:0"]]);
  const bombEls = [];
  const splatEls = [];
  for (const b of sim.bombs) {
    const t0 = at(b.t);
    const t1 = at(b.end);
    const cls = tl.track([
      [0, `opacity:0;${translate(b.x - 1.5, b.y0)}`],
      [t0, `opacity:0;${translate(b.x - 1.5, b.y0)}`],
      [t0, `opacity:1;${translate(b.x - 1.5, b.y0)}`],
      [t1, `opacity:1;${translate(b.x - 1.5, b.y1)}`],
      [t1, `opacity:0;${translate(b.x - 1.5, b.y1)}`]
    ]);
    bombEls.push(`<g class="${cls}">${[0, 1, 2, 3].map((i) => `<use class="bf${i}" href="#bm${i}"/>`).join("")}</g>`);
    splatEls.push(`<use class="sx" href="#sp" x="${fmt(b.x - 3)}" y="${fmt(b.y1 + 2)}" ${delay(b.end)}/>`);
  }
  parts.push(`<g fill="${ink}">${bombEls.join("")}${splatEls.join("")}</g>`);
  const ufoEls = [];
  for (const u of sim.ufos) {
    const startX = u.dir > 0 ? -24 : field.width;
    const endX2 = u.dir > 0 ? field.width : -24;
    const cross = (field.width + 16) / UFO_SPEED;
    const a = at(u.start);
    const frames2 = [[0, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:1;${translate(startX, field.ufoY)}`]];
    if (u.hit !== null) {
      const h = at(u.hit);
      const x = u.hitX - 8 * UFO_SCALE;
      frames2.push([h, `opacity:1;${translate(x, field.ufoY)}`], [h, `opacity:0;${translate(x, field.ufoY)}`]);
    } else {
      frames2.push([a + cross, `opacity:1;${translate(endX2, field.ufoY)}`], [a + cross, `opacity:0;${translate(endX2, field.ufoY)}`]);
    }
    ufoEls.push(`<use class="${tl.track(frames2)}" href="#uf" fill="${red}"/>`);
    if (u.hit !== null) {
      const h = at(u.hit);
      const label = pixelText(String(u.score), 2);
      const lx = Math.min(Math.max(u.hitX - label.width / 2, 2), field.width - label.width - 2);
      ufoEls.push(`<use class="bx" href="#bl" x="${fmt(u.hitX - 6.5 * BLAST_SCALE)}" y="${fmt(field.ufoY + 3.5 * UFO_SCALE - 3.5 * BLAST_SCALE)}" fill="${red}" ${delay(u.hit)}/>`);
      const cls = tl.track([[0, "opacity:0"], [h + 0.2, "opacity:0"], [h + 0.2, "opacity:1"], [h + 1.2, "opacity:1"], [h + 1.2, "opacity:0"]]);
      ufoEls.push(`<path class="${cls}" d="${label.d}" transform="translate(${fmt(lx)} ${field.ufoY - 3})" fill="${red}"/>`);
    }
  }
  parts.push(ufoEls.join(""));
  const cannonFrames = [[0, translate(field.startX - CANNON_HALF, field.cannonY)], [intro, translate(field.startX - CANNON_HALF, field.cannonY)]];
  for (const p of sim.cannonPath.slice(1)) cannonFrames.push([at(p.t), translate(p.x - CANNON_HALF, field.cannonY)]);
  const endX = sim.cannonPath[sim.cannonPath.length - 1].x;
  cannonFrames.push([back, translate(endX - CANNON_HALF, field.cannonY)], [duration - 0.1, translate(field.startX - CANNON_HALF, field.cannonY)]);
  const blink = [[0, "opacity:1"]];
  if (!empty) {
    let t = at(play) + 0.15;
    for (let i = 0; i < 2; i++) {
      blink.push(...tri(t, "opacity:1", "opacity:0"), ...tri(t + 0.15, "opacity:0", "opacity:1"));
      t += 0.3;
    }
  }
  parts.push(`<g class="${tl.track(cannonFrames)}"><g${glow}><use class="${tl.track(blink)}" href="#cn" fill="${green}"/></g></g>`);
  if (!empty) {
    const gridCx = layout.left + layout.gridWidth / 2;
    const gridCy = layout.top + layout.gridHeight / 2;
    parts.push(banner(tl, { theme, lines: stageClearLines(grid), cx: gridCx, cy: gridCy, from: at(play) + 0.1, to: back - 0.05 }));
  }
  const clears = sim.kills.map((k) => ({ t: at(k.t), cell: k.cell }));
  parts.push(hud(tl, grid, { theme, title: "SPACE INVADERS", clears, resetAt: back, width: field.width }));
  const cycle = 0.32;
  const dur = (n) => fmt(n);
  const css = [
    `.bx{animation:${blastKeys} ${dur(duration)}s linear infinite;animation-delay:var(--d)}`,
    `.sx{animation:${splatKeys} ${dur(duration)}s linear infinite;animation-delay:var(--d)}`,
    ...shotCss,
    "@keyframes bfk{0%{opacity:1}25%{opacity:0}100%{opacity:0}}",
    ...[0, 1, 2, 3].map((i) => `.bf${i}{animation:bfk ${cycle}s steps(1,end) infinite;animation-delay:-${fmt(cycle - i * 0.08)}s}`),
    "path{shape-rendering:crispEdges}",
    tl.css()
  ].join("\n");
  return { width: field.width, height: field.height, css, defs: defs.join("") + glowDefs(theme), body: parts.join("\n") };
}
var invaders = { id: "invaders", title: "Space Invaders", render: render5 };

// src/games/pacman.ts
var LANE = 1;
var DX = [1, 0, -1, 0];
var DY = [0, 1, 0, -1];
var GHOST_ORDER = [3, 2, 1, 0];
var PAC_PERIOD = 2;
var GHOST_PERIOD = 3;
var FRIGHT_PERIOD = 5;
var EYES_PERIOD = 1;
var FRIGHT_LENGTH = 100;
var FLASH_LENGTH = 24;
var SCATTER_LENGTH = 30;
var CHASE_LENGTH = 130;
var GHOST_GAP = 2;
var PRESS_GAP = 1;
var BLINKY_PERIOD = 2;
var ENDGAME_SHARE = 0.2;
var HUNT_RANGE = 14;
var LOOKAHEAD = 6;
var POWER_PELLETS = 4;
var GHOSTS = [
  { name: "blinky", color: "#ff0000", release: 0 },
  { name: "pinky", color: "#ffb8ff", release: 30 },
  { name: "inky", color: "#00ffff", release: 70 },
  { name: "clyde", color: "#ffb852", release: 110 }
];
function positionAt(wps, t) {
  if (t <= wps[0].t) return [wps[0].x, wps[0].y];
  for (let i = 1; i < wps.length; i++) {
    const b = wps[i];
    if (t <= b.t) {
      const a = wps[i - 1];
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
    }
  }
  const last = wps[wps.length - 1];
  return [last.x, last.y];
}
function pickPowerPellets(food) {
  const count = Math.min(POWER_PELLETS, Math.floor(food.length / 4));
  if (count === 0) return /* @__PURE__ */ new Set();
  const xs = food.map((c) => c.x);
  const ys = food.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const corners = [[x0, y1], [x1, y0], [x0, y0], [x1, y1]];
  const chosen = /* @__PURE__ */ new Set();
  for (const [cx, cy] of corners.slice(0, count)) {
    let best = null;
    let bestDist = Infinity;
    for (const c of food) {
      if (chosen.has(c)) continue;
      const d = Math.abs(c.x - cx) * 1.5 + Math.abs(c.y - cy) * 3 - c.level * 0.1;
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    chosen.add(best);
  }
  return chosen;
}
function simulatePacman(grid, rng) {
  const cols = grid.width + 2 * LANE;
  const rows = grid.height + 2 * LANE;
  const total = cols * rows;
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
  const foodList = activeCells(grid);
  const powerCells = pickPowerPellets(foodList);
  const food = /* @__PURE__ */ new Map();
  for (const c of foodList) food.set((c.y + LANE) * cols + c.x + LANE, c);
  const mid = Math.floor(cols / 2);
  const taken = /* @__PURE__ */ new Set();
  const homes = GHOSTS.map((_, i) => {
    let x = Math.min(cols - 1, Math.max(0, mid - 3 + 2 * i));
    let y = 0;
    while (taken.has(y * cols + x)) {
      x = (x + 1) % cols;
      if (x === 0) y++;
    }
    taken.add(y * cols + x);
    return [x, y];
  });
  const pac = { x: mid, y: rows - 1, px: mid, py: rows - 1, dir: 0, nextAt: 0, wps: [{ t: 0, x: mid, y: rows - 1 }] };
  const ghosts = GHOSTS.map((g, i) => ({
    x: homes[i][0],
    y: homes[i][1],
    px: homes[i][0],
    py: homes[i][1],
    dir: 2,
    nextAt: g.release,
    wps: [{ t: 0, x: homes[i][0], y: homes[i][1] }],
    mode: "normal",
    home: homes[i],
    release: g.release,
    spans: [],
    since: 0,
    movedAt: -1
  }));
  const eats = [];
  const ghostEats = [];
  let frightEnd = 0;
  let chain = 0;
  let lastEat = 0;
  let calmUntil = 0;
  let target = -1;
  const endgameAt = Math.max(6, Math.ceil(foodList.length * ENDGAME_SHARE));
  const pacPeriod = () => food.size <= endgameAt ? 1 : PAC_PERIOD;
  const gapFor = (index, u2) => index === 0 && chasing(u2) ? PRESS_GAP : GHOST_GAP;
  const startMove = (a, dir, u2, period) => {
    const last = a.wps[a.wps.length - 1];
    if (last.t < u2) a.wps.push({ t: u2, x: a.x, y: a.y });
    a.px = a.x;
    a.py = a.y;
    a.x += DX[dir];
    a.y += DY[dir];
    a.dir = dir;
    a.wps.push({ t: u2 + period, x: a.x, y: a.y });
    a.nextAt = u2 + period;
  };
  const setMode = (g, mode, t, timeout = false) => {
    if (g.mode === mode) return;
    if (t > g.since) g.spans.push({ mode: g.mode, from: g.since, to: t, timeout });
    g.mode = mode;
    g.since = t;
  };
  const chasing = (u2) => u2 >= calmUntil && u2 % (SCATTER_LENGTH + CHASE_LENGTH) >= SCATTER_LENGTH;
  const ghostTarget = (index, g, u2) => {
    const corners = [[cols - 1, 0], [0, 0], [cols - 1, rows - 1], [0, rows - 1]];
    if (!chasing(u2)) return corners[index];
    if (index === 0) return [pac.x, pac.y];
    if (index === 1) return [pac.x + 4 * DX[pac.dir], pac.y + 4 * DY[pac.dir]];
    if (index === 2) {
      const b = ghosts[0];
      return [2 * (pac.x + 2 * DX[pac.dir]) - b.x, 2 * (pac.y + 2 * DY[pac.dir]) - b.y];
    }
    return manhattan(g.x, g.y, pac.x, pac.y) > 8 ? [pac.x, pac.y] : corners[3];
  };
  const crowded = (g, x, y) => ghosts.some((o) => o !== g && o.mode !== "eyes" && manhattan(o.x, o.y, x, y) < 2);
  const moveGhost = (index, g, u2) => {
    if (g.mode === "eyes") {
      const dx = g.home[0] - g.x;
      const dy = g.home[1] - g.y;
      if (dx === 0 && dy === 0) {
        if (manhattan(g.x, g.y, pac.x, pac.y) <= GHOST_GAP + 2) {
          g.nextAt = u2 + 2;
          return;
        }
        setMode(g, "normal", u2);
        g.nextAt = u2 + 4;
        return;
      }
      startMove(g, dx !== 0 ? dx > 0 ? 0 : 2 : dy > 0 ? 1 : 3, u2, EYES_PERIOD);
      return;
    }
    const options = [];
    for (const dir of GHOST_ORDER) {
      const x = g.x + DX[dir];
      const y = g.y + DY[dir];
      if (inside(x, y)) options.push({ dir, x, y });
    }
    const reverse = (g.dir + 2) % 4;
    if (g.mode === "fright") {
      let best = options.filter((o) => !crowded(g, o.x, o.y));
      if (best.length === 0) best = options;
      const far = Math.max(...best.map((o) => manhattan(o.x, o.y, pac.x, pac.y)));
      const pool2 = best.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) >= far - 1 && o.dir !== reverse);
      const choice = (pool2.length ? pool2 : best.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) === far))[0];
      const picked = pool2.length > 1 ? pool2[Math.floor(rng() * pool2.length)] : choice;
      startMove(g, picked.dir, u2, FRIGHT_PERIOD);
      return;
    }
    const goal = ghostTarget(index, g, u2);
    const score = (o) => (o.x - goal[0]) ** 2 + (o.y - goal[1]) ** 2;
    const gap = gapFor(index, u2);
    const open = (o) => manhattan(o.x, o.y, pac.x, pac.y) >= gap && !(o.x === pac.px && o.y === pac.py) && !crowded(g, o.x, o.y);
    let pool = options.filter((o) => o.dir !== reverse && open(o));
    if (pool.length === 0) pool = options.filter(open);
    if (pool.length === 0) {
      const far = Math.max(...options.map((o) => manhattan(o.x, o.y, pac.x, pac.y)));
      pool = options.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) === far);
      pool.sort((a, b) => score(b) - score(a));
    } else {
      pool.sort((a, b) => score(a) - score(b));
    }
    startMove(g, pool[0].dir, u2, index === 0 ? BLINKY_PERIOD : GHOST_PERIOD);
  };
  const dangerous = (u2) => {
    const blocked = new Uint8Array(total);
    ghosts.forEach((g, i) => {
      if (g.mode !== "normal") return;
      const reach = gapFor(i, u2) - 1;
      const centres = reach === 0 ? [[g.x, g.y], [g.px, g.py]] : [[g.x, g.y]];
      for (const [cx, cy] of centres) {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > reach) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (inside(x, y)) blocked[y * cols + x] = 1;
          }
        }
      }
    });
    return blocked;
  };
  const search = (blocked) => {
    const dist = new Int32Array(total).fill(-1);
    const parent = new Int32Array(total).fill(-1);
    const heading = new Int8Array(total).fill(-1);
    const start = pac.y * cols + pac.x;
    dist[start] = 0;
    heading[start] = pac.dir;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      for (const turn2 of [0, 1, 3, 2]) {
        const d = (heading[cur] + turn2) % 4;
        const x = cx + DX[d];
        const y = cy + DY[d];
        if (!inside(x, y)) continue;
        const n = y * cols + x;
        if (dist[n] >= 0 || blocked[n]) continue;
        dist[n] = dist[cur] + 1;
        parent[n] = cur;
        heading[n] = d;
        queue.push(n);
      }
    }
    return { dist, parent };
  };
  const firstStep = (parent, goal) => {
    let c = goal;
    while (parent[c] !== pac.y * cols + pac.x) c = parent[c];
    return dirBetween(pac.x, pac.y, c % cols, Math.floor(c / cols));
  };
  const dirBetween = (ax, ay, bx, by) => bx > ax ? 0 : by > ay ? 1 : bx < ax ? 2 : 3;
  const decidePac = (u2) => {
    const blocked = dangerous(u2);
    const normals = ghosts.filter((g) => g.mode === "normal");
    const chasers = normals.filter((g) => u2 >= g.release + 6);
    const nearestThreat = chasers.length ? Math.min(...chasers.map((g) => manhattan(g.x, g.y, pac.x, pac.y))) : Infinity;
    const frightened = u2 < frightEnd ? ghosts.filter((g) => g.mode === "fright") : [];
    const endgame = food.size <= endgameAt;
    const hunted = frightened.map((g) => ({ g, d: manhattan(g.x, g.y, pac.x, pac.y) })).filter(({ d }) => !endgame && d <= HUNT_RANGE && d * pacPeriod() + 4 < frightEnd - u2).sort((a, b) => a.d - b.d)[0];
    if (hunted) {
      const goal = hunted.g.y * cols + hunted.g.x;
      const route = search(blocked);
      if (route.dist[goal] > 0) return firstStep(route.parent, goal);
    }
    if (u2 >= frightEnd && nearestThreat <= 5 && chasing(u2)) {
      const open = search(blocked);
      let bestPellet = -1;
      for (const [id, c] of food) {
        if (!powerCells.has(c) || open.dist[id] < 0 || open.dist[id] > 12) continue;
        if (bestPellet < 0 || open.dist[id] < open.dist[bestPellet]) bestPellet = id;
      }
      if (bestPellet >= 0) {
        target = bestPellet;
        return firstStep(open.parent, bestPellet);
      }
    }
    const map = search(blocked);
    if (target >= 0 && food.has(target) && map.dist[target] > 0) {
      return firstStep(map.parent, target);
    }
    let best = -1;
    let bestCost = Infinity;
    for (const id of food.keys()) {
      if (map.dist[id] < 1) continue;
      const x = id % cols;
      const y = Math.floor(id / cols);
      let near = LOOKAHEAD;
      for (let dy = -LOOKAHEAD; dy <= LOOKAHEAD; dy++) {
        for (let dx = -LOOKAHEAD; dx <= LOOKAHEAD; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d === 0 || d >= near || !inside(x + dx, y + dy)) continue;
          if (food.has((y + dy) * cols + x + dx)) near = d;
        }
      }
      const cost = map.dist[id] + (endgame ? 0 : 0.45 * near);
      if (cost < bestCost) {
        bestCost = cost;
        best = id;
      }
    }
    if (best >= 0) {
      target = best;
      return firstStep(map.parent, best);
    }
    target = -1;
    let pick = pac.dir;
    let room = -1;
    for (let d = 0; d < 4; d++) {
      const x = pac.x + DX[d];
      const y = pac.y + DY[d];
      if (!inside(x, y)) continue;
      const gap = normals.length ? Math.min(...normals.map((g) => manhattan(g.x, g.y, x, y))) : 99;
      if (gap > room) {
        room = gap;
        pick = d;
      }
    }
    return pick;
  };
  const eatGhost = (index, g, arrive) => {
    const [gx, gy] = positionAt(g.wps, arrive);
    const points = 200 * 2 ** Math.min(chain, 3);
    chain++;
    ghostEats.push({ t: arrive, ghost: index, points, x: gx, y: gy });
    while (g.wps.length > 1 && g.wps[g.wps.length - 1].t > arrive) g.wps.pop();
    g.wps.push({ t: arrive, x: gx, y: gy }, { t: arrive + 1, x: g.x, y: g.y });
    setMode(g, "eyes", arrive);
    g.nextAt = arrive + 1;
  };
  let u = 0;
  const limit = 400 * total;
  let end = 0;
  while (food.size > 0) {
    if (u > limit) throw new Error("Pac-Man did not clear the board within the step limit");
    if (u - lastEat > 120 && u >= calmUntil) calmUntil = u + 90;
    if (u - lastEat > 400 && u >= frightEnd) {
      frightEnd = u + FRIGHT_LENGTH;
      lastEat = u;
      chain = 0;
      for (const g of ghosts) {
        if (g.mode === "eyes") continue;
        setMode(g, "fright", u);
        g.dir = (g.dir + 2) % 4;
      }
    }
    let pacMoved = false;
    if (u >= pac.nextAt) {
      const dir = decidePac(u);
      const period = pacPeriod();
      startMove(pac, dir, u, period);
      pacMoved = true;
      const id = pac.y * cols + pac.x;
      const cell = food.get(id);
      if (cell) {
        food.delete(id);
        const power = powerCells.has(cell);
        eats.push({ t: u + period, cell, power, period });
        lastEat = u;
        if (power) {
          chain = 0;
          frightEnd = u + period + FRIGHT_LENGTH;
          for (const g of ghosts) {
            if (g.mode === "eyes") continue;
            setMode(g, "fright", u + period);
            g.dir = (g.dir + 2) % 4;
          }
        }
        if (food.size === 0) end = u + period;
      }
    }
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (u < g.nextAt) continue;
      moveGhost(i, g, u);
      if (g.nextAt > u) g.movedAt = u;
    }
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (g.mode !== "fright") continue;
      const met = g.x === pac.x && g.y === pac.y;
      const swapped = pacMoved && g.movedAt === u && g.x === pac.px && g.y === pac.py && g.px === pac.x && g.py === pac.y;
      if (met || swapped) eatGhost(i, g, Math.max(u + 1, pac.nextAt));
    }
    if (u >= frightEnd) {
      for (const g of ghosts) if (g.mode === "fright") setMode(g, "normal", u, true);
    }
    u++;
  }
  for (const g of ghosts) {
    if (g.since < end) g.spans.push({ mode: g.mode, from: g.since, to: end });
  }
  return {
    cols,
    rows,
    pac: pac.wps,
    ghosts: ghosts.map((g) => ({ waypoints: g.wps, spans: g.spans })),
    eats,
    ghostEats,
    end
  };
}
function isDark3(theme) {
  const hex = theme.ink.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function toggleFrames(intervals, duration, on = "opacity:1", off = "opacity:0") {
  const merged = [];
  for (const [a, b] of [...intervals].filter(([a2, b2]) => b2 > a2).sort((p, q) => p[0] - q[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const frames2 = [];
  if (merged.length === 0 || merged[0][0] > 0) frames2.push([0, off]);
  for (const [a, b] of merged) {
    if (a > 0) frames2.push([a, off]);
    frames2.push([a, on], [b, on]);
    if (b < duration - 1e-6) frames2.push([b, off]);
  }
  return frames2;
}
function simplify2(wps) {
  const out = [wps[0]];
  for (let i = 1; i < wps.length - 1; i++) {
    const a = wps[i - 1];
    const b = wps[i];
    const c = wps[i + 1];
    const same = b.t > a.t && c.t > b.t && Math.abs((b.x - a.x) * (c.t - b.t) - (c.x - b.x) * (b.t - a.t)) < 1e-9 && Math.abs((b.y - a.y) * (c.t - b.t) - (c.y - b.y) * (b.t - a.t)) < 1e-9;
    if (!same) out.push(b);
  }
  if (wps.length > 1) out.push(wps[wps.length - 1]);
  return out;
}
function headings(wps) {
  const out = [];
  for (let i = 1; i < wps.length; i++) {
    const dx = wps[i].x - wps[i - 1].x;
    const dy = wps[i].y - wps[i - 1].y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
    const dir = Math.abs(dx) >= Math.abs(dy) ? dx > 0 ? 0 : 2 : dy > 0 ? 1 : 3;
    if (out.length === 0 || out[out.length - 1][1] !== dir) out.push([wps[i - 1].t, dir]);
  }
  return out;
}
var PAC_YELLOW = "#ffe600";
var FRIGHT_BLUE = "#2121ff";
var PAC_RADIUS = 7.2;
function pacPath(halfAngle) {
  const a = halfAngle * Math.PI / 180;
  const x = PAC_RADIUS * Math.cos(a);
  const y = PAC_RADIUS * Math.sin(a);
  return `M0 0L${fmt(x)} ${fmt(-y)}A${PAC_RADIUS} ${PAC_RADIUS} 0 1 0 ${fmt(x)} ${fmt(y)}Z`;
}
function ghostPath(low) {
  const xs = [7, 4.67, 2.33, 0, -2.33, -4.67, -7];
  const skirt = xs.slice(1, 6).map((x, i) => `L${x} ${low[i + 1]}`).join("");
  return `M-7 ${low[6]}V-1A7 7 0 0 1 7 -1V${low[0]}${skirt}Z`;
}
var SKIRT_A = [7, 4.5, 7, 4.5, 7, 4.5, 7];
var SKIRT_B = [4.5, 7, 4.5, 7, 4.5, 7, 4.5];
var LOOK = [
  [0.9, 0],
  [0, 1.4],
  [-0.9, 0],
  [0, -1.4]
];
function mixColors(a, b, k) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}
var SPRITE = 1.28;
var MAZE_FLASH_BEATS = 4;
var MAZE_FLASH_BEAT = 0.25;
function render6(ctx) {
  const { grid, theme } = ctx;
  const dark = isDark3(theme);
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const sim = simulatePacman(grid, ctx.rng);
  const foodCount = activeCells(grid).length;
  const hasPlay = sim.end > 0;
  const rawDt = hasPlay ? (20 + foodCount * 0.12) / sim.end : 0.05;
  const play = hasPlay ? Math.round(sim.end * Math.min(0.07, Math.max(0.03, rawDt)) * 100) / 100 : 3;
  const unit = hasPlay ? play / sim.end : 0.05;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (t) => PACE.intro + t * unit;
  const tEnd = at(sim.end);
  const px = (x, y) => cellCenter(layout, x - LANE, y - LANE);
  const outline = dark ? "" : ` stroke="#000" stroke-opacity=".4" stroke-width=".8"`;
  const fadeFrames = (hideAt, hideFor) => [
    [0, "opacity:1"],
    [hideAt, "opacity:1"],
    [hideAt + hideFor, "opacity:0"],
    [duration - 0.3, "opacity:0"],
    [duration, "opacity:1"]
  ];
  const moveFrames = (wps, jumpAt) => {
    const frames2 = simplify2(wps).map((p) => [at(p.t), translate(...px(p.x, p.y))]);
    const last = wps[wps.length - 1];
    frames2.push([jumpAt, translate(...px(last.x, last.y))], [jumpAt, translate(...px(wps[0].x, wps[0].y))]);
    return frames2;
  };
  const flashStart = tEnd + 0.05;
  const flashEnd = flashStart + MAZE_FLASH_BEATS * MAZE_FLASH_BEAT;
  const wallA = FRIGHT_BLUE;
  const wallB = dark ? "#ffffff" : "#8fa6ff";
  const wallFrames = [[0, "opacity:0"]];
  if (hasPlay) {
    wallFrames.push([flashStart, "opacity:0"]);
    for (let k = 0; k < MAZE_FLASH_BEATS; k++) {
      const t = flashStart + k * MAZE_FLASH_BEAT;
      const css2 = `opacity:1;stroke:${k % 2 === 0 ? wallA : wallB}`;
      wallFrames.push([t, css2], [t + MAZE_FLASH_BEAT, css2]);
    }
    wallFrames.push([flashEnd, "opacity:0"]);
  }
  const wallClass = tl.track(wallFrames);
  const pulse = mixColors(theme.empty, FRIGHT_BLUE, dark ? 0.2 : 0.12);
  const floorFrames = [[0, `fill:${theme.empty}`]];
  if (hasPlay) {
    floorFrames.push(
      [flashStart, `fill:${theme.empty}`],
      [flashStart + 0.25, `fill:${pulse}`],
      [flashStart + 0.5, `fill:${theme.empty}`],
      [flashStart + 0.75, `fill:${pulse}`],
      [flashEnd, `fill:${theme.empty}`]
    );
  }
  const floorClass = tl.track(floorFrames);
  const wall = `<rect class="${wallClass}" x="${fmt(layout.left - 7)}" y="${fmt(layout.top - 7)}" width="${fmt(layout.gridWidth + 14)}" height="${fmt(layout.gridHeight + 14)}" rx="10" fill="none" stroke="${wallA}" stroke-width="2.5"${glowAttr(theme)}/>`;
  const floor = [];
  const dots = [];
  const eatTime = /* @__PURE__ */ new Map();
  for (const e of sim.eats) eatTime.set(e.cell, { t: at(e.t), power: e.power, period: e.period });
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      floor.push(cellRect(layout, cell, "inherit"));
      if (cell.level === 0) continue;
      const fill = levelColor(theme, cell);
      const eaten = eatTime.get(cell);
      const rest = "opacity:1;transform:scale(1)";
      const cls = tl.track(
        eaten ? [
          [0, rest],
          [eaten.t - 0.5 * eaten.period * unit, rest],
          [eaten.t + 0.1 * eaten.period * unit, "opacity:0;transform:scale(0)"],
          [restore, "opacity:0;transform:scale(0)"],
          [restore + PACE.restore, rest]
        ] : [[0, rest]]
      );
      if (eaten?.power) {
        const [ox, oy] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
        dots.push(
          `<g class="c ${cls}">${cellRect(layout, cell, fill)}<rect x="${fmt(ox - 1.5)}" y="${fmt(oy - 1.5)}" width="${layout.cell + 3}" height="${layout.cell + 3}" rx="${layout.radius + 1}" fill="none" stroke="${theme.accent}" stroke-width="1.6"><animate attributeName="opacity" values="1;.2;1" dur=".56s" repeatCount="indefinite"/></rect></g>`
        );
      } else {
        dots.push(cellRect(layout, cell, fill, `class="c ${cls}"`));
      }
    }
  }
  const pacHeadings = headings(sim.pac);
  let angle = (pacHeadings[0]?.[1] ?? 0) * 90;
  const startAngle = angle;
  const rotFrames = [[0, `transform:rotate(${angle}deg)`]];
  for (let i = 1; i < pacHeadings.length; i++) {
    const turn2 = (pacHeadings[i][1] - pacHeadings[i - 1][1] + 4) % 4;
    const t = at(pacHeadings[i][0]);
    rotFrames.push([t - 0.3 * unit, `transform:rotate(${angle}deg)`]);
    angle += turn2 === 1 ? 90 : turn2 === 3 ? -90 : 180;
    rotFrames.push([t + 0.3 * unit, `transform:rotate(${angle}deg)`]);
  }
  const pacJump = Math.max(fadeEnd + 0.05, at(sim.pac[sim.pac.length - 1].t) + 0.02);
  rotFrames.push([pacJump, `transform:rotate(${angle}deg)`], [pacJump, `transform:rotate(${startAngle}deg)`]);
  const pacFade = tl.track(fadeFrames(restore - 0.4, 0.3));
  const pacPos = tl.track(moveFrames(sim.pac, pacJump));
  const pacRot = tl.track(rotFrames);
  const open = pacPath(38);
  const pac = `<g class="${pacFade}"${glowAttr(theme)}><g class="${pacPos}"><g class="${pacRot}"><g transform="scale(${SPRITE})"><path d="${open}" fill="${PAC_YELLOW}"${outline.replace(".8", ".9")}><animate attributeName="d" values="${open};${pacPath(3)};${open}" dur=".3s" repeatCount="indefinite"/></path></g></g></g></g>`;
  const frightRim = dark ? ` stroke="#dfe6ff" stroke-width="1"` : "";
  const ghostMarkup = [];
  sim.ghosts.forEach((ghost, i) => {
    const spec = GHOSTS[i];
    const span = (mode) => ghost.spans.filter((s) => s.mode === mode).map((s) => [s.from === 0 ? 0 : at(s.from), Math.min(at(s.to), tEnd + 0.15)]);
    const hiddenAfter = tEnd + 0.15;
    const normal = ghost.spans.length ? span("normal") : [[0, hiddenAfter]];
    normal.push([hiddenAfter, duration]);
    const fright = span("fright");
    const flash = [];
    for (const s of ghost.spans) {
      if (s.mode !== "fright" || !s.timeout) continue;
      for (let k = 0; k * 6 < FLASH_LENGTH; k += 2) {
        const a = s.to - FLASH_LENGTH + k * 6 + 6;
        flash.push([at(Math.max(s.from, a)), at(Math.min(s.to, a + 6))]);
      }
    }
    const eyes = [...span("normal"), ...span("eyes"), [hiddenAfter, duration]];
    if (!ghost.spans.length) eyes.push([0, hiddenAfter]);
    const jump = Math.max(tEnd + 0.3, at(ghost.waypoints[ghost.waypoints.length - 1].t) + 0.02);
    const pos = tl.track(moveFrames(ghost.waypoints, jump));
    const fade = tl.track(fadeFrames(tEnd + 0.05, 0.1));
    const normalOp = tl.track(toggleFrames(normal, duration));
    const frightOp = tl.track(toggleFrames(fright, duration));
    const flashOp = tl.track(toggleFrames(flash, duration));
    const eyesOp = tl.track(toggleFrames(eyes, duration));
    const looks = headings(ghost.waypoints);
    const offset = (dir) => `transform:translate(${LOOK[dir][0]}px,${LOOK[dir][1]}px)`;
    const lookFrames = [[0, offset(2)]];
    let prev = 2;
    for (const [t, dir] of looks) {
      lookFrames.push([at(t), offset(prev)], [at(t) + 0.06, offset(dir)]);
      prev = dir;
    }
    lookFrames.push([jump, offset(prev)], [jump, offset(2)]);
    const lookClass = tl.track(lookFrames);
    ghostMarkup.push(
      `<g class="${fade}"${glowAttr(theme)}><g class="${pos}"><g transform="scale(${SPRITE})"${outline}><g class="${normalOp}"><use href="#gb" fill="${spec.color}"/></g><g class="${frightOp}"><use href="#gb" fill="${FRIGHT_BLUE}"${frightRim}/><use href="#gf" color="#ffb8ae"/></g><g class="${flashOp}"><use href="#gb" fill="#fff"/><use href="#gf" color="#f00"/></g><g class="${eyesOp}"><use href="#ge"/><g class="${lookClass}"><circle cx="-2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/><circle cx="2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/></g></g></g></g></g>`
    );
  });
  const popupColor = dark ? "#22e0ff" : "#0089a8";
  const popups = sim.ghostEats.map((e) => {
    const te = at(e.t);
    const [x, y] = px(e.x, e.y);
    const text = pixelText(String(e.points), 1.6);
    const cls = tl.track([
      [0, `opacity:0;${translate(x, y)}`],
      [te - 1e-3, `opacity:0;${translate(x, y)}`],
      [te, `opacity:1;${translate(x, y)}`],
      [te + 0.9, `opacity:1;${translate(x, y - 6)}`],
      [te + 0.92, `opacity:0;${translate(x, y - 6)}`]
    ]);
    return `<g class="${cls}"><path d="${text.d}" transform="translate(${fmt(-text.width / 2)} ${fmt(-text.height / 2)})" fill="${popupColor}"/></g>`;
  });
  const clears = sim.eats.map((e) => ({ t: at(e.t), cell: e.cell }));
  const bar = hud(tl, grid, { theme, title: "PAC-MAN", clears, resetAt: restore, width });
  const ready = pixelText("READY!", 3);
  const readyClass = tl.track([
    [0, "opacity:1"],
    [PACE.intro - 0.05, "opacity:1"],
    [PACE.intro + 0.15, "opacity:0"],
    [duration - 0.3, "opacity:0"],
    [duration, "opacity:1"]
  ]);
  const readyColor = dark ? PAC_YELLOW : "#b88a00";
  const readyX = (width - ready.width) / 2;
  const readyY = layout.top + (layout.gridHeight - ready.height) / 2;
  const readyMarkup = `<g class="${readyClass}"><rect x="${fmt(readyX - 10)}" y="${fmt(readyY - 8)}" width="${fmt(ready.width + 20)}" height="${fmt(ready.height + 16)}" rx="6" fill="${theme.surface}" fill-opacity=".9"/><path d="${ready.d}" transform="translate(${fmt(readyX)} ${fmt(readyY)})" fill="${readyColor}"/></g>`;
  const end = hasPlay ? banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: width / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: tEnd + 0.45,
    to: restore
  }) : "";
  const defs = [
    glowDefs(theme),
    `<path id="gb" d="${ghostPath(SKIRT_A)}"><animate attributeName="d" values="${ghostPath(SKIRT_A)};${ghostPath(SKIRT_B)}" calcMode="discrete" dur=".34s" repeatCount="indefinite"/></path>`,
    `<g id="gf"><circle cx="-2.4" cy="-2.2" r="1.15" fill="currentColor"/><circle cx="2.4" cy="-2.2" r="1.15" fill="currentColor"/><path d="M-4.7 3.4l1.57-1.6 1.57 1.6 1.56-1.6 1.57 1.6 1.57-1.6 1.56 1.6" fill="none" stroke="currentColor" stroke-width=".9"/></g>`,
    `<g id="ge"><ellipse cx="-2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/><ellipse cx="2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/></g>`
  ].join("");
  const css = `.c{transform-box:fill-box;transform-origin:center}
${tl.css()}`;
  const body = [
    `<g class="${floorClass}">${floor.join("")}</g>`,
    wall,
    `<g>${dots.join("")}</g>`,
    ...ghostMarkup,
    pac,
    ...popups,
    bar,
    readyMarkup,
    end
  ].join("\n");
  return { width, height, css, defs, body };
}
var pacman = { id: "pacman", title: "Pac-Man", render: render6 };

// src/games/snake.ts
var DX2 = [1, 0, -1, 0];
var DY2 = [0, 1, 0, -1];
var TURN_ORDER = [0, 1, 3];
var LANE2 = 1;
var GROWTH_SHARE = 1 / 3;
var MAX_LENGTH = 56;
var CANDIDATES = 12;
var Trapped = class extends Error {
};
function simulateSnake(grid, coda = () => 0) {
  const cols = grid.width + 2 * LANE2;
  const rows = grid.height + 2 * LANE2;
  const total = cols * rows;
  const food = /* @__PURE__ */ new Map();
  for (const c of activeCells(grid)) food.set((c.y + LANE2) * cols + c.x + LANE2, c);
  let maxLength = Math.max(1, Math.min(MAX_LENGTH, Math.floor(total * GROWTH_SHARE)));
  const body = [0];
  const path = [0];
  const eats = [];
  let lastDir = 0;
  let playSteps = 0;
  const stepLimit = total * 60;
  const dirOf = (from, to) => {
    const dx = to % cols - from % cols;
    const dy = Math.floor(to / cols) - Math.floor(from / cols);
    return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
  };
  const advance = (to, grow) => {
    lastDir = dirOf(body[0], to);
    const cell = food.get(to);
    const growing = grow && body.length < maxLength;
    body.unshift(to);
    if (!growing) body.pop();
    path.push(to);
    if (cell) {
      food.delete(to);
      eats.push({ step: path.length - 1, cell, grew: growing });
      playSteps = path.length - 1;
    }
    if (path.length > stepLimit) throw new Trapped("snake did not finish within the step limit");
  };
  const explore = () => {
    const length = body.length;
    const occupant = new Int16Array(total).fill(-1);
    body.forEach((cell, i) => occupant[cell] = i);
    const dist = new Int32Array(total).fill(-1);
    const parent = new Int32Array(total).fill(-1);
    const heading = new Int8Array(total).fill(-1);
    const head = body[0];
    dist[head] = 0;
    heading[head] = lastDir;
    const queue = [head];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      const t = dist[cur] + 1;
      for (const turn2 of TURN_ORDER) {
        const d = (heading[cur] + turn2) % 4;
        const nx = cx + DX2[d];
        const ny = cy + DY2[d];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (dist[n] >= 0) continue;
        const o = occupant[n];
        if (o >= 0 && (t <= length - 1 - o || o === 1 && t === 1)) continue;
        dist[n] = t;
        parent[n] = cur;
        heading[n] = d;
        queue.push(n);
      }
    }
    return { dist, parent, queue };
  };
  const routeTo = (parent, target) => {
    const route = [];
    for (let c = target; c !== body[0]; c = parent[c]) route.push(c);
    return route.reverse();
  };
  const reachesTail = (snake2) => {
    if (snake2.length < 3) return true;
    const blocked = new Uint8Array(total);
    for (const c of snake2) blocked[c] = 1;
    const tail = snake2[snake2.length - 1];
    const tx = tail % cols;
    const ty = Math.floor(tail / cols);
    const seen = new Uint8Array(total);
    const stack = [snake2[0]];
    seen[snake2[0]] = 1;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      if (Math.abs(cx - tx) + Math.abs(cy - ty) === 1) return true;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX2[d];
        const ny = cy + DY2[d];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (blocked[n] || seen[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    return false;
  };
  const chaseTail = () => {
    if (body.length === 1) {
      for (let k = 0; k < 4; k++) {
        const d = (lastDir + [0, 1, 3, 2][k]) % 4;
        const nx = body[0] % cols + DX2[d];
        const ny = Math.floor(body[0] / cols) + DY2[d];
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) return advance(ny * cols + nx, false);
      }
    }
    const { dist, parent } = explore();
    const tail = body[body.length - 1];
    if (dist[tail] > 0) return advance(routeTo(parent, tail)[0], false);
    for (let k = 0; k < 4; k++) {
      const d = (lastDir + [0, 1, 3, 2][k]) % 4;
      const nx = body[0] % cols + DX2[d];
      const ny = Math.floor(body[0] / cols) + DY2[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (dist[n] === 1) return advance(n, false);
    }
    throw new Trapped("snake has nowhere to go");
  };
  let stalled = 0;
  while (food.size > 0) {
    const { dist, parent, queue } = explore();
    let chosen = null;
    let fallback = null;
    let tried = 0;
    for (const cell of queue) {
      if (!food.has(cell) || dist[cell] < 1) continue;
      const route = routeTo(parent, cell);
      const firstFood = route.findIndex((c) => food.has(c));
      const leg = route.slice(0, firstFood + 1);
      fallback ??= leg;
      const grows = body.length < maxLength;
      const after = [...leg].reverse().concat(body).slice(0, body.length + (grows ? 1 : 0));
      if (reachesTail(after)) {
        chosen = leg;
        break;
      }
      if (++tried >= CANDIDATES) break;
    }
    if (!chosen && stalled > total * 2 && maxLength <= body.length) chosen = fallback;
    if (chosen) {
      stalled = 0;
      chosen.forEach((c, i) => advance(c, i === chosen.length - 1));
      continue;
    }
    if (++stalled > total * 2) maxLength = Math.min(maxLength, body.length);
    chaseTail();
  }
  const extra = eats.length > 0 ? coda(playSteps, eats) : 0;
  for (let i = 0; i < extra; i++) chaseTail();
  return { cols, rows, path, eats, playSteps, maxLength };
}
var BODY = 13;
var OUTLINE2 = 1.5;
var HEAD = 16;
var TAPER = [0.6, 0.64, 0.7, 0.76, 0.82, 0.88, 0.93, 0.97];
var POP = 0.22;
var SPEED_UP_AT = 0.55;
var SPEED_UP_RATIO = 0.55;
var MIN_STEP = 0.04;
var MIN_PLAY_FOR_SPEED_UP = 10;
var EAT_HOLD = 0.15;
var EAT_FADE = 0.3;
function snakeAngle(dir) {
  return dir * 90;
}
function roundStep(s) {
  return Math.round(s * 50) / 50;
}
function planPhases(foodCount, sim) {
  const steps = sim.playSteps;
  const target = 20 + foodCount * 0.12;
  const raw = steps > 0 ? target / steps : 0.1;
  const s = Math.min(0.14, Math.max(0.06, roundStep(raw)));
  const boundary = sim.eats[Math.floor(sim.eats.length * SPEED_UP_AT)]?.step ?? steps;
  if (sim.eats.length < 8 || boundary >= steps || boundary * s < MIN_PLAY_FOR_SPEED_UP) return [{ from: 0, s }];
  const fast = Math.max(MIN_STEP, roundStep(s * SPEED_UP_RATIO));
  return fast >= s ? [{ from: 0, s }] : [{ from: 0, s }, { from: boundary, s: fast }];
}
function isDark4(theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function mixColors2(a, b) {
  const parse = (hex2) => [1, 3, 5].map((i) => parseInt(hex2.slice(i, i + 2), 16));
  const [ra, ga, ba] = parse(a);
  const [rb, gb, bb] = parse(b);
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex((ra + rb) / 2)}${hex((ga + gb) / 2)}${hex((ba + bb) / 2)}`;
}
function render7(ctx) {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark4(theme);
  let phases = [{ from: 0, s: 0.1 }];
  const sim = simulateSnake(grid, (playSteps, eats) => {
    phases = planPhases(activeCells(grid).length, { playSteps, eats });
    return Math.ceil((PACE.hold + PACE.restore) / phases[phases.length - 1].s);
  });
  const hasPlay = sim.eats.length > 0;
  const lastStep = sim.path.length - 1;
  const starts = [PACE.intro];
  for (let j = 1; j < phases.length; j++) {
    starts[j] = starts[j - 1] + (phases[j].from - phases[j - 1].from) * phases[j - 1].s;
  }
  const atIn = (j, step) => starts[j] + (step - phases[j].from) * phases[j].s;
  const phaseOf = (step) => {
    let j = 0;
    while (j + 1 < phases.length && phases[j + 1].from <= step) j++;
    return j;
  };
  const at = (step) => atIn(phaseOf(step), step);
  const play = hasPlay ? Math.round((at(sim.playSteps) - PACE.intro) * 100) / 100 : 3;
  const duration = loopDuration(play);
  const tl = new Timeline(duration);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const jumpAt = Math.max(fadeEnd + 0.05, at(lastStep) + 0.02);
  const px = (id) => cellCenter(layout, id % sim.cols - LANE2, Math.floor(id / sim.cols) - LANE2);
  const dirs = [];
  for (let k = 1; k < sim.path.length; k++) {
    const a = sim.path[k - 1];
    const b = sim.path[k];
    const dx = b % sim.cols - a % sim.cols;
    const dy = Math.floor(b / sim.cols) - Math.floor(a / sim.cols);
    dirs.push(dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3);
  }
  const moveFrames = (lo, hi, timeOf, stops = []) => {
    const frames2 = [];
    for (let k = lo; k <= hi; k++) {
      if (k === lo || k === hi || dirs[k - 1] !== dirs[k] || stops.includes(k)) {
        frames2.push([timeOf(k), translate(...px(sim.path[k]))]);
      }
    }
    return frames2;
  };
  const startPos = px(sim.path[0]);
  const endPos = px(sim.path[lastStep]);
  const headFrames = moveFrames(0, lastStep, at, phases.slice(1).map((p) => p.from));
  headFrames.push([jumpAt, translate(...endPos)], [jumpAt, translate(...startPos)]);
  const headTrack = tl.keyframes(headFrames);
  const headPos = tl.useKeyframes(headTrack, 0);
  const startAngle = snakeAngle(dirs[0] ?? 0);
  let angle = startAngle;
  const turnFrames = [[0, `transform:rotate(${angle}deg)`]];
  for (let k = 1; k < lastStep; k++) {
    const turn2 = (dirs[k] - dirs[k - 1] + 4) % 4;
    if (turn2 === 0) continue;
    const j = phaseOf(k);
    turnFrames.push([at(k) - 0.3 * phases[j].s, `transform:rotate(${angle}deg)`]);
    angle += turn2 === 1 ? 90 : -90;
    turnFrames.push([at(k) + 0.3 * phases[j].s, `transform:rotate(${angle}deg)`]);
  }
  turnFrames.push([jumpAt, `transform:rotate(${angle}deg)`], [jumpAt, `transform:rotate(${startAngle}deg)`]);
  const headTurn = tl.track(turnFrames);
  const wiggleStart = PACE.intro + play + 0.05;
  const wiggleFrames = [[0, "transform:rotate(0deg)"]];
  if (hasPlay) {
    for (let k = 0; k < 8; k++) {
      wiggleFrames.push([wiggleStart + k * 0.13, `transform:rotate(${k % 2 === 0 ? -16 : 16}deg)`]);
    }
    wiggleFrames.push([wiggleStart + 8 * 0.13, "transform:rotate(0deg)"]);
  }
  const headWiggle = tl.track(wiggleFrames);
  const snakeFade = tl.track([
    [0, "opacity:1"],
    [restore - 0.4, "opacity:1"],
    [restore - 0.1, "opacity:0"],
    [jumpAt, "opacity:0"],
    [duration, "opacity:1"]
  ]);
  const growth = sim.eats.filter((e) => e.grew);
  const growTime = (m) => at(growth[m - 1].step);
  const taperShape = (e) => e < TAPER.length ? TAPER[e] : 1;
  const rim = dark ? theme.surface : theme.ink;
  const rimOpacity = dark ? 1 : 0.8;
  const pitch = Math.abs(px(1)[0] - px(0)[0]);
  const reach = Math.ceil(lastStep * pitch) + pitch;
  const route = [];
  for (let k = 0; k <= lastStep; k++) {
    if (k === 0 || k === lastStep || dirs[k - 1] !== dirs[k]) {
      const [x, y] = px(sim.path[k]);
      route.push(`${route.length ? "L" : "M"}${fmt(x)} ${fmt(y)}`);
    }
  }
  const dash = pitch / 2;
  const along = (steps) => `stroke-dashoffset:${fmt(dash / 2 - steps * pitch)}px`;
  const copies = phases.map((phase, j) => {
    const lo = j === 0 ? 0 : Math.max(0, phase.from - growth.length - 2);
    const hi = j + 1 < phases.length ? phases[j + 1].from : lastStep;
    const tLo = atIn(j, lo);
    const frames2 = tLo >= 0 ? [[tLo, along(lo)], [atIn(j, hi), along(hi)]] : [[0, along(lo - tLo / phase.s)], [atIn(j, hi), along(hi)]];
    return { track: tl.keyframes(frames2), s: phase.s };
  });
  const gates = copies.map((_, j) => {
    if (copies.length === 1) return "";
    const switchAt = starts[1];
    return tl.track(
      j === 0 ? [[0, "opacity:1"], [switchAt, "opacity:1"], [switchAt, "opacity:0"]] : [[0, "opacity:0"], [switchAt, "opacity:0"], [switchAt, "opacity:1"]]
    );
  });
  const tube = copies.map(() => []);
  const shadow = copies.map(() => []);
  for (let i = growth.length; i >= 1; i--) {
    const look = (size, odd) => {
      const width2 = (scale) => `stroke-width:${fmt(size * scale)}`;
      const frames2 = [[0, `opacity:0;${width2(0.2)}`]];
      for (let j = 0; 2 * j <= TAPER.length; j++) {
        const m = i + j;
        if (m > growth.length) break;
        const start = growTime(m);
        const next = m + 1 <= growth.length ? growTime(m + 1) : Infinity;
        const end2 = Math.min(start + POP, next);
        const from = j === 0 ? `opacity:0;${width2(0.2)}` : `opacity:1;${width2(taperShape(2 * j - 2 + odd))}`;
        frames2.push([start, from], [end2, `opacity:1;${width2(taperShape(2 * j + odd))}`]);
      }
      frames2.push([fadeEnd, frames2[frames2.length - 1][1]], [fadeEnd + 0.01, "opacity:0"]);
      return tl.track(frames2);
    };
    const looks = [look(BODY, 0), look(BODY, 1), look(BODY + 2 * OUTLINE2, 0), look(BODY + 2 * OUTLINE2, 1)];
    const fill = spriteColor(theme, growth[i - 1].cell);
    const joint = i === 1 ? fill : mixColors2(spriteColor(theme, growth[i - 2].cell), fill);
    copies.forEach((copy, j) => {
      const pos = tl.useKeyframes(copy.track, i * copy.s);
      const bridge = tl.useKeyframes(copy.track, (i - 0.5) * copy.s);
      const piece = (look2, cls, color) => `<g class="${look2}"><use class="${cls}" href="#body-route" stroke="${color}"/></g>`;
      tube[j].push(piece(looks[0], pos, fill), piece(looks[1], bridge, joint));
      shadow[j].push(piece(looks[2], pos, rim), piece(looks[3], bridge, rim));
    });
  }
  const gated = (parts) => parts.map((p, j) => gates[j] ? `<g class="${gates[j]}">${p.join("")}</g>` : p.join("")).join("");
  const dashing = `stroke-dasharray="${fmt(dash)} ${reach}"`;
  const baseCells = [];
  const foodCells = [];
  const pops = [];
  const eatTime = /* @__PURE__ */ new Map();
  for (const e of sim.eats) eatTime.set(e.cell, at(e.step));
  const popFrames = [
    [0, "opacity:1;transform:scale(.6)"],
    [EAT_HOLD, "opacity:1;transform:scale(1)"],
    [EAT_HOLD + EAT_FADE, "opacity:0;transform:scale(2.3)"]
  ];
  const popTrack = tl.keyframes(popFrames);
  const bigTrack = tl.keyframes([
    [0, "opacity:1;transform:scale(.5)"],
    [0.2, "opacity:1;transform:scale(1.4)"],
    [0.7, "opacity:0;transform:scale(3.2)"]
  ]);
  const lastEat = sim.eats[sim.eats.length - 1]?.cell;
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      baseCells.push(cellRect(layout, cell, theme.empty));
      if (cell.level === 0) continue;
      const te = eatTime.get(cell);
      const fill = levelColor(theme, cell);
      if (te === void 0) {
        foodCells.push(cellRect(layout, cell, fill));
        continue;
      }
      const cls = tl.track([
        [0, "opacity:1"],
        [te, "opacity:1"],
        [te, "opacity:0"],
        [restore, "opacity:0"],
        [restore + PACE.restore, "opacity:1"]
      ]);
      foodCells.push(cellRect(layout, cell, fill, `class="${cls}"`));
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      const big = cell === lastEat;
      const pop = tl.useKeyframes(big ? bigTrack : popTrack, te);
      pops.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><use class="${pop}" href="#${big ? "pop-big" : "pop"}"/></g>`);
    }
  }
  const spark = (n, radius, size) => Array.from({ length: n }, (_, k) => {
    const a = k / n * Math.PI * 2 + 0.3;
    const fill = k % 2 ? theme.accent : flash;
    return `<circle cx="${fmt(Math.cos(a) * radius)}" cy="${fmt(Math.sin(a) * radius)}" r="${size}" fill="${fill}"/>`;
  }).join("");
  const flash = dark ? "#ffffff" : theme.accent;
  const defs = glowDefs(theme) + `<g id="pop"><circle r="7" fill="none" stroke="${flash}" stroke-width="1.4"/>${spark(8, 7, 1.7)}</g>` + (growth.length > 0 ? `<path id="body-route" d="${route.join("")}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : "") + `<g id="pop-big"><circle r="8" fill="none" stroke="${flash}" stroke-width="2"/><circle r="5" fill="none" stroke="${theme.accent}" stroke-width="2"/>${spark(12, 8, 2.1)}</g>`;
  const clears = sim.eats.map((e) => ({ t: at(e.step), cell: e.cell }));
  const bar = hud(tl, grid, { theme, title: "SNAKE", clears, resetAt: restore, width });
  const end = hasPlay ? banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: width / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: PACE.intro + play + 0.1,
    to: restore
  }) : "";
  const head = `<g class="${headPos}"><g class="${headTurn}"><g class="${headWiggle}">
<rect x="${-HEAD / 2}" y="${-HEAD / 2}" width="${HEAD}" height="${HEAD}" rx="${HEAD * 0.42}" fill="${theme.accent}" stroke="${rim}" stroke-opacity="${rimOpacity}" stroke-width="${OUTLINE2}"/>
<circle cx="2.6" cy="-3.4" r="2.4" fill="#fff"/><circle cx="2.6" cy="3.4" r="2.4" fill="#fff"/>
<circle cx="3.4" cy="-3.4" r="1.2" fill="#111"/><circle cx="3.4" cy="3.4" r="1.2" fill="#111"/>
<path d="M7.5 0H11.5M11.5 0l2.4-1.8M11.5 0l2.4 1.8" stroke="#e5484d" stroke-width="1.2" stroke-linecap="round" fill="none" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.55;.6;.8;.85" dur="1.4s" repeatCount="indefinite"/></path>
</g></g></g>`;
  const bodyMarkup = [
    `<g>${baseCells.join("")}</g>`,
    `<g>${foodCells.join("")}</g>`,
    `<g class="${snakeFade}"${glowAttr(theme)}><g ${dashing}><g opacity="${rimOpacity}">${gated(shadow)}</g>${gated(tube)}</g>${head}</g>`,
    `<g>${pops.join("")}</g>`,
    bar,
    end
  ].join("\n");
  return { width, height, css: tl.css(), defs, body: bodyMarkup };
}
var snake = { id: "snake", title: "Snake", render: render7 };

// src/games/tetris.ts
var SHAPES = {
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] }
};
var KINDS = Object.keys(SHAPES);
function turn(cells, n, times = 1) {
  let out = cells;
  for (let k = 0; k < (times % 4 + 4) % 4; k++) out = out.map(([x, y]) => [n - 1 - y, x]);
  return out;
}
var FILLERS = [
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [0, 1]],
  [[0, 0], [1, 0], [1, 1]],
  [[1, 0], [0, 1], [1, 1]],
  [[0, 0], [0, 1], [1, 1]]
];
function normalise(kind, raw) {
  const up = raw.map(([x, y]) => [x, -y]);
  const first = up.reduce((a, b) => b[0] < a[0] || b[0] === a[0] && b[1] < a[1] ? b : a);
  const cells = up.map(([x, y]) => [x - first[0], y - first[1]]);
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { kind, cells, size: cells.length };
}
function orientations(kind, base, n) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let r = 0; r < 4; r++) {
    const o = normalise(kind, turn(base, n, r));
    const key = o.cells.map((c) => c.join(":")).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(o);
    }
  }
  return out;
}
var TETRO = KINDS.flatMap((k) => orientations(k, SHAPES[k].cells, SHAPES[k].n));
var FILL = FILLERS.flatMap((cells) => orientations("x", cells, Math.max(...cells.flat()) + 1));
function solveBoard(heights, rng, opts = {}) {
  const W = heights.length;
  const total = heights.reduce((a, b) => a + b, 0);
  const maxH = Math.max(0, ...heights);
  if (total === 0) return { rows: 0, placements: [], filler: 0 };
  const attempts = [];
  for (let rows = maxH; rows <= maxH + 9; rows++) {
    const cells = W * rows - total;
    if (cells < 0) continue;
    for (let slack = cells % 4; slack <= 7 && slack <= cells; slack += 4) {
      const cost = (slack > 0 ? 20 + slack * 3 : 0) + (rows - maxH) * (W / 4) * 0.5 + (slack > 3 ? 12 : 0);
      const deep = Array.from({ length: W }, (_, c) => c).filter((c) => rows - heights[c] >= 4);
      for (const c of shuffle(rng, deep).slice(0, 30)) attempts.push({ rows, slack, well: c, cost });
      attempts.push({ rows, slack, well: -1, cost: cost + 4 });
    }
  }
  attempts.sort((a, b) => a.cost - b.cost);
  const budget = opts.budget ?? 8e3;
  const limit = opts.limit ?? 15e4;
  const shared = { nodes: 0 };
  const failed = attempts.map(() => /* @__PURE__ */ new Set());
  for (let round = 0; round < 6 && shared.nodes < limit; round++) {
    for (let i = 0; i < Math.min(attempts.length, 40 + round * 20); i++) {
      const a = attempts[i];
      const tiles = tile(heights, a.rows, a.slack, a.well, rng, a.well >= 0 ? 1200 : budget, failed[i], shared);
      if (!tiles) continue;
      const placements = sequence(heights, tiles.pieces);
      if (placements) return { rows: a.rows, placements, filler: a.slack };
    }
  }
  return emergency(heights, maxH);
}
function emergency(heights, rows) {
  const placements = [];
  for (let r = 1; r <= rows; r++) {
    heights.forEach((h, c) => {
      if (h < r) placements.push({ kind: "x", cells: [[c, r]] });
    });
  }
  return { rows, placements, filler: placements.length };
}
function tile(heights, K, slackStart, wc, rng, budget, failed, shared) {
  const W = heights.length;
  const covered = new Int32Array(W + 4);
  const pieces = [];
  const recent = [];
  let nodes = 0;
  let aborted = false;
  if (wc >= 0) for (let r = K - 3; r <= K; r++) covered[wc] |= 1 << r;
  const dfs = (start, slack) => {
    let c = start;
    let r = 0;
    for (; c < W; c++) {
      r = heights[c] + 1;
      while (r <= K && covered[c] >> r & 1) r++;
      if (r <= K) break;
    }
    if (c >= W) return slack === 0;
    nodes++;
    shared.nodes++;
    if (nodes > budget) {
      aborted = true;
      return false;
    }
    const key = `${c}:${covered[c]},${covered[c + 1]},${covered[c + 2]},${covered[c + 3]}:${slack}`;
    if (failed.has(key)) return false;
    const options = [];
    const pool = slack > 0 ? TETRO.concat(FILL.filter((o) => o.size <= slack)) : TETRO;
    for (const o of pool) {
      let ok = true;
      for (const [dx, dy] of o.cells) {
        const col = c + dx;
        const row = r + dy;
        if (col >= W || row <= heights[col] || row > K || covered[col] >> row & 1) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let reuse = 0;
      for (let k = Math.max(0, recent.length - 3); k < recent.length; k++) if (recent[k] === o.kind) reuse++;
      options.push({ o, score: rng() * 2 + reuse * 0.9 + (o.kind === "x" ? 6 : 0) });
    }
    options.sort((a, b) => a.score - b.score);
    for (const { o } of options) {
      const cells = o.cells.map(([dx, dy]) => [c + dx, r + dy]);
      for (const [col, row] of cells) covered[col] |= 1 << row;
      pieces.push({ kind: o.kind, cells });
      recent.push(o.kind);
      if (dfs(c, slack - (o.kind === "x" ? o.size : 0))) return true;
      recent.pop();
      pieces.pop();
      for (const [col, row] of cells) covered[col] &= ~(1 << row);
      if (aborted) return false;
    }
    if (!aborted) failed.add(key);
    return false;
  };
  if (!dfs(0, slackStart)) return null;
  if (wc >= 0) pieces.push({ kind: "I", last: true, cells: [[wc, K - 3], [wc, K - 2], [wc, K - 1], [wc, K]] });
  return { pieces };
}
function sequence(heights, pieces) {
  const owner = /* @__PURE__ */ new Map();
  pieces.forEach((p, i) => p.cells.forEach(([c, r]) => owner.set(`${c}:${r}`, i)));
  const after = pieces.map(() => []);
  const waiting = pieces.map(() => 0);
  pieces.forEach((p, i) => {
    for (const [c, r] of p.cells) {
      const above = owner.get(`${c}:${r + 1}`);
      if (above !== void 0 && above !== i && !after[i].includes(above)) {
        after[i].push(above);
        waiting[above]++;
      }
    }
  });
  const low = pieces.map((p) => p.last ? Infinity : Math.min(...p.cells.map((c) => c[1])));
  const left = pieces.map((p) => Math.min(...p.cells.map((c) => c[0])));
  const ready = pieces.map((_, i) => i).filter((i) => waiting[i] === 0);
  const order = [];
  const h = heights.slice();
  while (ready.length > 0) {
    let best = 0;
    for (let k = 1; k < ready.length; k++) {
      const a = ready[k];
      const b = ready[best];
      if (low[a] < low[b] || low[a] === low[b] && left[a] < left[b]) best = k;
    }
    const i = ready.splice(best, 1)[0];
    const p = pieces[i];
    const rows = Math.min(...h);
    const top = Math.max(...p.cells.map((c) => c[1]));
    if (top - rows > 7) return null;
    for (const [c, r] of p.cells) {
      if (r !== h[c] + 1 && !p.cells.some(([c2, r2]) => c2 === c && r2 === r - 1)) return null;
    }
    for (const [c, r] of p.cells) h[c] = Math.max(h[c], r);
    order.push(p);
    for (const next of after[i]) if (--waiting[next] === 0) ready.push(next);
  }
  return order.length === pieces.length ? order : null;
}
var ROWS = 7;
var TARGET_PLAY5 = 40;
var Track = class {
  frames = [];
  state;
  css;
  last = 0;
  constructor(state2, css) {
    this.state = state2;
    this.css = css;
  }
  pin(t, ease) {
    const css = this.css(this.state) + (ease ? `;animation-timing-function:${ease}` : "");
    if (this.frames.length === 0) {
      this.frames.push([0, css]);
      this.last = 0;
    }
    const at = Math.max(t, this.last);
    if (at > this.last + 1e-6) {
      this.frames.push([at, css]);
      this.last = at;
    } else if (ease) {
      this.frames[this.frames.length - 1][1] = css;
    }
  }
  set(t, patch) {
    this.pin(t);
    Object.assign(this.state, patch);
    this.frames.push([Math.max(t, this.last) + 1e-3, this.css(this.state)]);
    this.last = Math.max(t, this.last) + 1e-3;
  }
  tween(t0, t1, patch, ease = "linear") {
    this.pin(t0, ease);
    Object.assign(this.state, patch);
    const end = Math.max(t1, this.last + 1e-3);
    this.frames.push([end, this.css(this.state)]);
    this.last = end;
  }
};
var blockCss = (s) => `transform:translate(0,${fmt(s.dy)}px);fill:${s.fill};opacity:${s.opacity}`;
var poseCss = (s) => `opacity:${s.opacity};transform:translate(${fmt(s.x)}px,${fmt(s.y)}px) rotate(${fmt(s.rot)}deg)`;
function shuffle(rng, items) {
  const out = items.slice();
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}
function planPath(spawn, n, target, occ, rng, canRotate) {
  const W = occ.length;
  const turns = [0, 1, 2, 3].map((r) => turn(spawn, n, r));
  const order = (cells) => cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const t0 = order(target);
  const goals = [];
  for (let r = 0; r < (canRotate ? 4 : 1); r++) {
    const c0 = order(turns[r]);
    const dx = t0[0][0] - c0[0][0];
    const dy = t0[0][1] - c0[0][1];
    if (c0.every((c, i) => c[0] + dx === t0[i][0] && c[1] + dy === t0[i][1])) goals.push({ bx: dx, bj: dy, r });
  }
  const key = (s) => ((s.bx + 12) * 24 + (s.bj + 6)) * 4 + s.r;
  const goalKeys = new Set(goals.map(key));
  const blocked = (s) => {
    for (const [x, y] of turns[s.r]) {
      const col = s.bx + x;
      const j = s.bj + y;
      if (col < 0 || col >= W || j < -1 || j > ROWS - 1) return true;
      if (j >= 0 && occ[col][ROWS - j]) return true;
    }
    return false;
  };
  const minY = (r) => Math.min(...turns[r].map((c) => c[1]));
  const search = (start2) => {
    if (blocked(start2)) return null;
    const dist = /* @__PURE__ */ new Map([[key(start2), 0]]);
    const from = /* @__PURE__ */ new Map();
    const open = [{ cost: 0, s: start2 }];
    const closed = /* @__PURE__ */ new Set();
    while (open.length > 0) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k].cost < open[bi].cost) bi = k;
      const { cost, s } = open.splice(bi, 1)[0];
      const sk = key(s);
      if (closed.has(sk)) continue;
      closed.add(sk);
      if (goalKeys.has(sk)) {
        const moves = [];
        let k = sk;
        let cur = s;
        while (from.has(k)) {
          const step = from.get(k);
          moves.push(step.move);
          cur = step.prev;
          k = key(cur);
        }
        return { goal: s, moves: moves.reverse() };
      }
      const low = 0.03 * Math.max(0, s.bj + 2);
      const next = [
        [{ bx: s.bx - 1, bj: s.bj, r: s.r }, "L", 1 + low],
        [{ bx: s.bx + 1, bj: s.bj, r: s.r }, "R", 1 + low],
        [{ bx: s.bx, bj: s.bj + 1, r: s.r }, "D", 0.35]
      ];
      if (canRotate) {
        next.push([{ bx: s.bx, bj: s.bj, r: (s.r + 1) % 4 }, "CW", 1.05 + low], [{ bx: s.bx, bj: s.bj, r: (s.r + 3) % 4 }, "CCW", 1.05 + low]);
      }
      for (const [ns, move, step] of next) {
        if (ns.bx < -10 || ns.bx > W + 10 || ns.bj > ROWS + 1 || blocked(ns)) continue;
        const nk = key(ns);
        const nc = cost + step;
        if (nc < (dist.get(nk) ?? Infinity)) {
          dist.set(nk, nc);
          from.set(nk, { prev: s, move });
          open.push({ cost: nc, s: ns });
        }
      }
    }
    return null;
  };
  const ref = goals.slice().sort((a, b) => a.r - b.r)[0];
  for (const off of shuffle(rng, [-3, -2, -1, 0, 1, 2, 3])) {
    const start2 = { bx: ref.bx + off, bj: -1 - minY(0), r: 0 };
    const found2 = search(start2);
    if (found2) return { start: start2, goal: found2.goal, moves: found2.moves };
  }
  const start = { bx: ref.bx, bj: -1 - minY(ref.r), r: ref.r };
  const found = search(start);
  if (found) return { start, goal: found.goal, moves: found.moves };
  return { start: ref, goal: ref, moves: [] };
}
var PALETTES = {
  dark: { I: "#22d3ee", O: "#ffd23f", T: "#b565ff", S: "#3be07a", Z: "#ff4b4b", J: "#4f80ff", L: "#ff9a1f", x: "#8b949e" },
  light: { I: "#0aa6c7", O: "#e5a400", T: "#8f45e6", S: "#1fa648", Z: "#dc2f2f", J: "#2f5fe0", L: "#ee7c0a", x: "#7d8590" },
  neon: { I: "#23f0ff", O: "#fff04d", T: "#c68bff", S: "#39ff88", Z: "#ff4d6d", J: "#5a8cff", L: "#ffa11a", x: "#a08cc4" }
};
function luminance2(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  return (0.2126 * (v >> 16) + 0.7152 * (v >> 8 & 255) + 0.0722 * (v & 255)) / 255;
}
function paletteFor3(theme) {
  const light = luminance2(theme.surface) > 0.6;
  const kinds = PALETTES[theme.name === "neon" ? "neon" : light ? "light" : "dark"];
  return { kinds, flash: light ? theme.ink : "#ffffff" };
}
function planTetris(ctx, theme, layout) {
  const { grid, rng } = ctx;
  const W = grid.width;
  const { pitch, cell: size } = layout;
  const pal = paletteFor3(theme);
  const days = [];
  const occ = Array.from({ length: W }, () => Array(ROWS + 2).fill(null));
  const heights = [];
  for (let c = 0; c < W; c++) {
    const col = grid.cells[c].filter((d) => d !== null && d.level > 0).sort((a, b) => a.y - b.y);
    heights.push(col.length);
    col.forEach((cell, idx) => {
      const [x, y] = [layout.left + c * pitch, layout.top + cell.y * pitch];
      const fill = levelColor(theme, cell);
      const block = { day: true, cell, c, p: col.length - idx, rest: col.length - idx, color: fill, track: new Track({ dy: 0, fill, opacity: 1 }, blockCss), x, y };
      days.push(block);
      occ[c][block.p] = block;
    });
  }
  const ops = [];
  let cleared = 0;
  const completeRows = () => {
    let n = 0;
    for (let p = 1; p <= ROWS; p++) {
      if (occ.every((col) => col[p] !== null)) n++;
      else break;
    }
    return n;
  };
  const clearRows = (rows) => {
    const done = [];
    const moved = [];
    for (let c = 0; c < W; c++) {
      for (let p = 1; p <= rows; p++) done.push(occ[c][p]);
      for (let p = rows + 1; p <= ROWS; p++) {
        const b = occ[c][p];
        occ[c][p - rows] = b;
        if (b) {
          b.p = p - rows;
          moved.push(b);
        }
      }
      for (let p = ROWS - rows + 1; p <= ROWS; p++) occ[c][p] = null;
    }
    ops.push({ type: "clear", rows, cleared: done, shifted: moved });
    cleared += rows;
  };
  const solution = solveBoard(heights, rng);
  for (let n = completeRows(); n > 0; n = completeRows()) clearRows(Math.min(4, n));
  for (const placement of solution.placements) {
    const filler = placement.kind === "x";
    const cells = placement.cells.map(([c, r]) => [c, ROWS - (r - cleared)]);
    let spawn;
    let n;
    if (filler) {
      const minC = Math.min(...cells.map((c) => c[0]));
      const minJ = Math.min(...cells.map((c) => c[1]));
      spawn = cells.map(([c, j]) => [c - minC, j - minJ]);
      n = Math.max(...spawn.flat()) + 1;
    } else {
      const shape = SHAPES[placement.kind];
      spawn = shape.cells;
      n = shape.n;
    }
    const path = planPath(spawn, n, cells, occ, rng, !filler);
    const color = pal.kinds[placement.kind];
    const blocks = cells.map(([c, j]) => {
      const block = {
        day: false,
        cell: null,
        c,
        p: ROWS - j,
        rest: ROWS - j,
        color,
        track: new Track({ dy: 0, fill: color, opacity: 1 }, blockCss),
        x: (c - path.goal.bx - (n - 1) / 2) * pitch - size / 2,
        y: (j - path.goal.bj - (n - 1) / 2) * pitch - size / 2
      };
      occ[c][block.p] = block;
      return block;
    });
    ops.push({ type: "piece", kind: placement.kind, blocks, n, start: path.start, goal: path.goal, moves: path.moves, pose: null });
    const rows = completeRows();
    if (rows > 0) clearRows(rows);
  }
  const play = {
    layout,
    ops,
    rows: solution.rows,
    filler: solution.filler,
    pieces: solution.placements.length,
    clears: [],
    lines: [],
    tetrises: [],
    gravityEnd: 0,
    play: 0,
    days
  };
  return play;
}
var TIMING = { spawn: 0.05, lateral: 0.04, rotate: 0.055, downBase: 0.05, downPer: 0.03, settle: 0.1, gap: 0.03 };
var sweepOf = (W) => Math.min(0.4, W * 75e-4);
var CLEAR_HOLD = 0.16;
var CLEAR_VANISH = 0.1;
var CLEAR_TAIL = 0.26;
var DROP_EASE = "cubic-bezier(.5,0,.9,.7)";
function segments(moves) {
  const out = [];
  for (const m of moves) {
    const type = m === "L" || m === "R" ? "lat" : m === "D" ? "down" : "rot";
    const dir = m === "L" || m === "CCW" ? -1 : 1;
    const last = out[out.length - 1];
    if (type !== "rot" && last && last.type === type && last.dir === dir) last.n++;
    else out.push({ type, n: 1, dir });
  }
  return out;
}
function segmentSeconds(s, speed) {
  if (s.type === "lat") return Math.min(0.18, TIMING.lateral * s.n) / speed;
  if (s.type === "rot") return TIMING.rotate / speed;
  return (TIMING.downBase + TIMING.downPer * s.n) / speed;
}
function pieceSeconds(op, speed) {
  let t = TIMING.spawn / speed;
  for (const s of segments(op.moves)) t += segmentSeconds(s, speed);
  return t + (TIMING.settle + TIMING.gap) / speed;
}
var clearSeconds = (W) => sweepOf(W) + CLEAR_HOLD + CLEAR_VANISH + CLEAR_TAIL;
function dropDays(play) {
  const { pitch } = play.layout;
  let end = 0;
  for (const b of play.days) {
    const d = ROWS - b.cell.y - b.rest;
    if (d <= 0) continue;
    const s = b.c * 0.024 + (b.rest - 1) * 0.02;
    const dur = 0.2 + 0.08 * Math.sqrt(d);
    b.track.tween(s, s + dur, { dy: d * pitch + 2 }, "cubic-bezier(.55,0,.85,.55)");
    b.track.tween(s + dur, s + dur + 0.07, { dy: d * pitch }, "ease-out");
    end = Math.max(end, s + dur + 0.07);
  }
  return end;
}
function pieceSpeedFactor(i, total) {
  return 0.85 + 0.45 * i / Math.max(1, total - 1);
}
function schedule(play, theme, width) {
  const { pitch, cell: size, left, top } = play.layout;
  const pal = paletteFor3(theme);
  const W = width;
  const pieces = play.ops.filter((o) => o.type === "piece");
  const start = play.gravityEnd > 0 ? play.gravityEnd + 0.3 : 0.3;
  const clearsTotal = play.ops.filter((o) => o.type === "clear").length * clearSeconds(W);
  const base = pieces.reduce((sum, op, i) => sum + pieceSeconds(op, pieceSpeedFactor(i, pieces.length)), 0);
  const free = Math.max(6, TARGET_PLAY5 - start - clearsTotal);
  const sp = Math.min(1.8, Math.max(0.75, base / free));
  let t = start;
  let linesTotal = 0;
  let index = 0;
  const S = sweepOf(W);
  for (const op of play.ops) {
    if (op.type === "piece") {
      const speed = sp * pieceSpeedFactor(index++, pieces.length);
      const n = op.n;
      const px = (bx) => left + (bx + (n - 1) / 2) * pitch + size / 2;
      const py = (bj) => top + (bj + (n - 1) / 2) * pitch + size / 2;
      const net = op.moves.reduce((sum, m) => sum + (m === "CW" ? 1 : m === "CCW" ? -1 : 0), 0);
      const pose = new Track({ x: px(op.start.bx), y: py(op.start.bj), rot: -net * 90, opacity: 0 }, poseCss);
      pose.pin(0);
      pose.pin(t);
      pose.set(t, { opacity: 1 });
      t += TIMING.spawn / speed;
      for (const seg of segments(op.moves)) {
        const dur = segmentSeconds(seg, speed);
        if (seg.type === "lat") pose.tween(t, t + dur, { x: pose.state.x + seg.dir * seg.n * pitch });
        else if (seg.type === "rot") pose.tween(t, t + dur, { rot: pose.state.rot + seg.dir * 90 });
        else pose.tween(t, t + dur, { y: pose.state.y + seg.n * pitch }, DROP_EASE);
        t += dur;
      }
      const rest = pose.state.y;
      pose.tween(t, t + TIMING.settle * 0.4 / speed, { y: rest + 1.8 }, "ease-out");
      pose.tween(t + TIMING.settle * 0.4 / speed, t + TIMING.settle / speed, { y: rest }, "ease-in-out");
      t += (TIMING.settle + TIMING.gap) / speed;
      op.pose = pose;
    } else {
      const sweepEnd = t + S;
      const vanish = sweepEnd + CLEAR_HOLD;
      for (const b of op.cleared) {
        const ts = t + b.c * S / W;
        b.track.set(ts, { fill: pal.flash });
        b.track.tween(vanish, vanish + CLEAR_VANISH, { opacity: 0 });
        if (b.day) play.clears.push({ t: ts + 0.02, cell: b.cell });
      }
      for (const b of op.shifted) {
        b.track.tween(vanish + 0.06, vanish + 0.23, { dy: b.track.state.dy + op.rows * pitch }, "cubic-bezier(.3,.7,.4,1)");
      }
      linesTotal += op.rows;
      play.lines.push({ t: t + S * 0.6, total: linesTotal });
      if (op.rows >= 4) play.tetrises.push(t);
      t = vanish + CLEAR_VANISH + CLEAR_TAIL - 0.1;
    }
  }
  play.play = Math.max(t + 0.1, 2.4);
}
function playTetris(ctx) {
  const layout = arcadeLayout(ctx.grid);
  const play = planTetris(ctx, ctx.theme, layout);
  play.gravityEnd = dropDays(play);
  schedule(play, ctx.theme, ctx.grid.width);
  const restore = PACE.hold + play.play;
  for (const b of play.days) {
    b.track.set(restore, { dy: 0, opacity: 0, fill: b.color });
    b.track.tween(restore + 2e-3, restore + PACE.restore, { opacity: 1 });
  }
  return play;
}
function renderTetris(ctx, play) {
  const { theme, grid } = ctx;
  const { layout } = play;
  const W = grid.width;
  const shift = PACE.intro;
  const L = (s) => PACE.intro + s;
  const D = loopDuration(play.play);
  const restore = restoreAt(play.play);
  const tl = new Timeline(D, "t");
  const pal = paletteFor3(theme);
  const eps = 1e-3;
  const emit = (frames2) => tl.track(frames2.map(([t, css]) => [t + shift, css]));
  const tiles = [];
  for (const col of grid.cells) {
    for (const c of col) if (c) tiles.push(cellRect(layout, c, theme.empty));
  }
  const dayEls = play.days.map((b) => cellRect(layout, b.cell, b.color, `class="${emit(b.track.frames)}"`));
  const pieceEls = [];
  for (const op of play.ops) {
    if (op.type !== "piece") continue;
    const kids = op.blocks.map(
      (b) => `<use href="#tb" x="${fmt(b.x)}" y="${fmt(b.y)}" fill="${b.color}" class="${emit(b.track.frames)}"/>`
    );
    pieceEls.push(`<g class="${emit(op.pose.frames)}">${kids.join("")}</g>`);
  }
  const bands = [];
  const tetrisText = pixelText("TETRIS!", 3);
  const sweep = sweepOf(W);
  const fourRows = 4 * layout.pitch - layout.gap;
  for (const t0 of play.tetrises) {
    const at = t0 + sweep;
    const cls = tl.track([
      [0, "opacity:0"],
      [L(at), "opacity:0"],
      [L(at) + eps, "opacity:.55"],
      [L(at) + 0.3, "opacity:0"]
    ]);
    bands.push(
      `<rect class="${cls}" x="${fmt(layout.left)}" y="${fmt(layout.top + (ROWS - 4) * layout.pitch)}" width="${fmt(layout.gridWidth)}" height="${fmt(fourRows)}" rx="2" fill="${pal.flash}"/>`
    );
    const blink = [[0, "opacity:0"]];
    for (let k = 0; k < 3; k++) {
      blink.push([L(at) + k * 0.3, "opacity:0"], [L(at) + k * 0.3 + eps, "opacity:1"], [L(at) + k * 0.3 + 0.18, "opacity:1"], [L(at) + k * 0.3 + 0.18 + eps, "opacity:0"]);
    }
    bands.push(
      `<path class="${tl.track(blink)}" d="${tetrisText.d}" transform="translate(${fmt(layout.left + layout.gridWidth / 2 - tetrisText.width / 2)} ${fmt(layout.top + ((ROWS - 4) * layout.pitch - tetrisText.height) / 2)})" fill="${theme.accent}"${glowAttr(theme)}/>`
    );
  }
  const counter = linesReadout(tl, play, theme, restore);
  const text = banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: layout.left + layout.gridWidth / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: L(play.play) + 0.05,
    to: restore - 0.1
  });
  const score = hud(tl, grid, {
    theme,
    title: "TETRIS",
    clears: play.clears.map((e) => ({ t: L(e.t), cell: e.cell })),
    resetAt: restore,
    width: layout.width
  });
  const defs = [
    glowDefs(theme),
    `<g id="tb"><rect width="${layout.cell}" height="${layout.cell}" rx="2.4"/><path d="M1.4 1.4h9.2v2.2H1.4z" fill="#fff" fill-opacity=".42"/><path d="M1.4 3.6h2.2v7H1.4z" fill="#fff" fill-opacity=".22"/><path d="M3.6 10.6h7v-2.2h-7z" fill="#000" fill-opacity=".24"/><path d="M8.4 3.6h2.2v5h-2.2z" fill="#000" fill-opacity=".14"/></g>`
  ].join("");
  return {
    width: layout.width,
    height: layout.height,
    css: tl.css(),
    defs,
    body: [...tiles, ...dayEls, counter, `<g${glowAttr(theme)}>${pieceEls.join("")}</g>`, ...bands, score, text].join("")
  };
}
function linesReadout(tl, play, theme, restore) {
  const scale = 2;
  const advance = 6 * scale;
  const label = pixelText("LINES", scale);
  const { layout } = play;
  const x = layout.left + layout.gridWidth - label.width - 3 * advance;
  const y = layout.top + layout.gridHeight + 12;
  const events = [{ t: 0, value: 0 }, ...play.lines.map((l) => ({ t: PACE.intro + l.t, value: l.total })), { t: restore, value: 0 }];
  const out = [`<path d="${label.d}" transform="translate(${fmt(x)} ${fmt(y)})" fill="${theme.muted}"/>`];
  const digitsX = x + label.width + advance;
  for (let pos = 0; pos < 2; pos++) {
    const shown = events.map((e) => ({ t: e.t, ch: pos === 0 && e.value < 10 ? " " : String(e.value).padStart(2, "0")[pos] }));
    const runs = [];
    for (const s of shown) if (!runs.length || runs[runs.length - 1].ch !== s.ch) runs.push(s);
    for (const ch of new Set(runs.map((r) => r.ch).filter((c) => c !== " "))) {
      const glyph = pixelText(ch, scale);
      const frames2 = [];
      runs.forEach((r, i) => {
        if (i > 0) frames2.push([r.t, runs[i - 1].ch === ch ? "opacity:1" : "opacity:0"]);
        frames2.push([r.t, r.ch === ch ? "opacity:1" : "opacity:0"]);
      });
      out.push(`<path class="${tl.track(frames2)}" d="${glyph.d}" transform="translate(${fmt(digitsX + pos * advance)} ${fmt(y)})" fill="${theme.ink}"/>`);
    }
  }
  return `<g class="lines">${out.join("")}</g>`;
}
var tetris = {
  id: "tetris",
  title: "Tetris",
  render(ctx) {
    return renderTetris(ctx, playTetris(ctx));
  }
};

// src/games/tron.ts
var DX3 = [1, 0, -1, 0];
var DY3 = [0, 1, 0, -1];
var ARENA_TOP = -1;
var ARENA_BOTTOM = 9;
var FINALE_STEP = 0.058;
var HUNT_SPAN = 24;
var BASE_STEP_MIN = 0.07;
var BASE_STEP_MAX = 0.13;
var ENDGAME_SHARE2 = 0.12;
var CRASH_AFTER = 0.9;
var LAP_AFTER = 1.7;
var LAP_TICKS = 70;
var CRASH_DEADLINE = 90;
var ESCAPE = 36;
var TERRITORY = 45;
var CUT_COOLDOWN = 24;
var CRASH_MARGIN_COLS = 1;
var CRASH_TOP_ROW = 1;
var CRASH_BOTTOM_ROW = 7;
var idOf = (a, col, row) => (col - a.c0) * a.rows + (row - ARENA_TOP);
var colOf = (a, id) => Math.floor(id / a.rows) + a.c0;
var rowOf = (a, id) => id % a.rows + ARENA_TOP;
function neighbour(a, id, dir) {
  const col = colOf(a, id) + DX3[dir];
  const row = rowOf(a, id) + DY3[dir];
  if (col < a.c0 || col > a.c1 || row < ARENA_TOP || row > ARENA_BOTTOM) return -1;
  return idOf(a, col, row);
}
function directionOf(a, from, to) {
  const dx = colOf(a, to) - colOf(a, from);
  const dy = rowOf(a, to) - rowOf(a, from);
  return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
}
function clamp2(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function collapse(head, tail, from) {
  let j0 = tail.findIndex((t) => t > from);
  if (j0 < 0) j0 = tail.length;
  let prev = 0;
  for (let i = 0; i < tail.length; i++) {
    let t = tail[i];
    if (i >= j0) t = Math.min(t, from + (i - j0) * 0.01);
    t = Math.max(t, head[i] + 1e-3, prev);
    tail[i] = t;
    prev = t;
  }
}
function race(grid, rng) {
  const width = grid.width;
  const arena = { c0: -1, c1: width, cols: width + 2, rows: ARENA_BOTTOM - ARENA_TOP + 1 };
  const total = arena.cols * arena.rows;
  const trail = clamp2(Math.round(total * 0.06), 8, 36);
  const days = /* @__PURE__ */ new Map();
  for (const c of activeCells(grid)) days.set(idOf(arena, c.x, c.y), c);
  const dayTotal = days.size;
  const visit = new Int32Array(total).fill(-1e6);
  const owner = new Int8Array(total).fill(-1);
  const free = (c, t) => visit[c] + trail < t;
  const live = (c, t) => visit[c] + trail >= t;
  const startRow = Math.floor(grid.height / 2);
  const cells = [[idOf(arena, -1, startRow)], [idOf(arena, width, startRow)]];
  const dirs = [0, 2];
  cells.forEach((cs, k) => {
    visit[cs[0]] = 0;
    owner[cs[0]] = k;
  });
  const derez = [];
  const fast = /* @__PURE__ */ new Set();
  let nearMisses = 0;
  let collisions = 0;
  let lastCut = -CUT_COOLDOWN;
  let doneAt = -1;
  let crashTick = -1;
  let crashPoint = { x: 0, y: 0 };
  const crashAllowed = (id) => {
    const col = colOf(arena, id);
    const row = rowOf(arena, id);
    return col >= CRASH_MARGIN_COLS && col <= width - 1 - CRASH_MARGIN_COLS && row >= CRASH_TOP_ROW && row <= CRASH_BOTTOM_ROW;
  };
  const escape = (cell, dir, t, near = []) => {
    const used = /* @__PURE__ */ new Set([cell]);
    let budget = 2e4;
    const walk = (c, d, depth) => {
      if (depth >= ESCAPE || budget-- <= 0) return depth;
      let best = depth;
      for (const turn2 of [0, 1, 3]) {
        const nd = (d + turn2) % 4;
        const n = neighbour(arena, c, nd);
        if (n < 0 || used.has(n) || !free(n, t + depth + 1) || depth < near.length && near[depth].includes(n)) continue;
        used.add(n);
        best = Math.max(best, walk(n, nd, depth + 1));
        used.delete(n);
        if (best >= ESCAPE) return best;
      }
      return best;
    };
    return walk(cell, dir, 0);
  };
  const search = (start, t, goal) => {
    const dist = new Int16Array(total).fill(-1);
    dist[start] = 0;
    let queue = [start];
    let best = Infinity;
    let firstDepth = -1;
    for (let d = 0; queue.length; d++) {
      if (firstDepth >= 0 && d > firstDepth + 5) break;
      const next = [];
      for (const c of queue) {
        const g = goal(c, d);
        if (g !== null) {
          best = Math.min(best, g);
          if (firstDepth < 0) firstDepth = d;
        }
        for (let nd = 0; nd < 4; nd++) {
          const n = neighbour(arena, c, nd);
          if (n < 0 || dist[n] >= 0 || !free(n, t + d + 1)) continue;
          dist[n] = d + 1;
          next.push(n);
        }
      }
      queue = next;
    }
    return best;
  };
  const territory = (cell, rival2, t) => {
    const owner2 = new Int8Array(total).fill(-1);
    owner2[cell] = 0;
    owner2[rival2] = 1;
    let queue = [cell, rival2];
    let mine = 1;
    for (let d = 0; queue.length && d < 40; d++) {
      const next = [];
      for (const c of queue) {
        for (let nd = 0; nd < 4; nd++) {
          const n = neighbour(arena, c, nd);
          if (n < 0 || owner2[n] >= 0 || !free(n, t + d + 1)) continue;
          owner2[n] = owner2[c];
          if (owner2[c] === 0) mine++;
          next.push(n);
        }
      }
      queue = next;
    }
    return mine;
  };
  const seekDays = (cell, t, rival2) => {
    const rivalCol = colOf(arena, rival2);
    const rivalRow = rowOf(arena, rival2);
    return search(cell, t, (c, d) => {
      const day = days.get(c);
      if (!day) return null;
      const closer = Math.abs(colOf(arena, c) - rivalCol) + Math.abs(rowOf(arena, c) - rivalRow) < d - 1;
      return d + (closer ? 5 : 0) - 0.4 * day.level;
    });
  };
  const seekWall = (cell, t) => search(cell, t, (c, d) => {
    for (let nd = 0; nd < 4; nd++) {
      const n = neighbour(arena, c, nd);
      if (n >= 0 && owner[n] === 0 && live(n, t + d + 1) && crashAllowed(n)) return d;
    }
    return null;
  });
  const intercept = (cell, t, rival2, rivalDir, rivalMoved) => {
    const line = [];
    let c = rival2;
    for (let i = 0; i < 4; i++) {
      c = neighbour(arena, c, rivalDir);
      if (c < 0) break;
      line.push(c);
    }
    const base2 = rivalMoved ? t : t - 1;
    return search(cell, t, (c2, d) => {
      const k = line.indexOf(c2) + 1;
      if (k < 2) return null;
      const gap = base2 + k - (t + d);
      return gap === 1 || gap === 2 ? d : null;
    });
  };
  const step = (k, t, finale) => {
    const me = cells[k];
    const head = me[me.length - 1];
    const dir = dirs[k];
    const other = cells[1 - k];
    const rival2 = other[other.length - 1];
    const rivalDir = dirs[1 - k];
    const rivalAlive = !(k === 0 && crashTick >= 0);
    if (finale && k === 1) {
      const ahead = neighbour(arena, head, dir);
      const hitWall = ahead >= 0 && live(ahead, t) && owner[ahead] === 0 && crashAllowed(ahead);
      const late = t > doneAt + CRASH_DEADLINE && (ahead < 0 || live(ahead, t));
      if (hitWall && t >= doneAt + Math.ceil(CRASH_AFTER / FINALE_STEP) || late) {
        crashTick = t - 1;
        const [ac, ar] = ahead >= 0 ? [colOf(arena, ahead), rowOf(arena, ahead)] : [colOf(arena, head) + DX3[dir], rowOf(arena, head) + DY3[dir]];
        crashPoint = { x: (colOf(arena, head) + ac) / 2, y: (rowOf(arena, head) + ar) / 2 };
        return;
      }
    }
    const options = [];
    for (const turn2 of [0, 1, 3]) {
      const d = (dir + turn2) % 4;
      const n = neighbour(arena, head, d);
      if (n >= 0 && free(n, t)) options.push({ n, d });
    }
    if (options.length === 0) {
      collisions++;
      const d = dir;
      const n = neighbour(arena, head, d);
      options.push({ n: n >= 0 ? n : head, d });
    }
    const ahead1 = rivalAlive ? neighbour(arena, rival2, rivalDir) : -1;
    const rivalMoved = other.length > me.length;
    const reach1 = [];
    const reach2 = [];
    if (rivalAlive) {
      for (const turn2 of [0, 1, 3]) {
        const d1 = (rivalDir + turn2) % 4;
        const n1 = neighbour(arena, rival2, d1);
        if (n1 < 0) continue;
        reach1.push(n1);
        for (const turn22 of [0, 1, 3]) {
          const n2 = neighbour(arena, n1, (d1 + turn22) % 4);
          if (n2 >= 0) reach2.push(n2);
        }
      }
    }
    const rivalHasMove = (taken) => {
      if (!rivalAlive) return true;
      const was = visit[taken];
      visit[taken] = t;
      const ok = [0, 1, 3].some((turn2) => {
        const n = neighbour(arena, rival2, (rivalDir + turn2) % 4);
        return n >= 0 && free(n, rivalMoved ? t + 1 : t);
      });
      visit[taken] = was;
      return ok;
    };
    const rivalEscapes = (taken) => {
      const was = visit[taken];
      visit[taken] = t;
      const ok = [1, 3].some((turn2) => {
        const nd = (rivalDir + turn2) % 4;
        const n = neighbour(arena, rival2, nd);
        return n >= 0 && free(n, t) && escape(n, nd, t) >= ESCAPE;
      });
      visit[taken] = was;
      return ok;
    };
    const seeking = finale && k === 1 && t >= doneAt + Math.ceil(CRASH_AFTER / FINALE_STEP);
    const hunting = !finale;
    let best = options[0];
    let bestScore = Infinity;
    let bestSafe = false;
    let bestEscape = -1;
    for (const o of options) {
      const room = escape(o.n, o.d, t, [reach1, reach2]);
      const roomy = !rivalAlive || territory(o.n, rival2, t) >= TERRITORY;
      const safe = room >= ESCAPE && roomy;
      let score;
      if (hunting) {
        score = days.has(o.n) ? -0.4 * (days.get(o.n)?.level ?? 0) : seekDays(o.n, t, rival2);
        if (!Number.isFinite(score)) score = 400;
      } else if (seeking) {
        score = seekWall(o.n, t);
        if (!Number.isFinite(score)) score = 400;
      } else {
        score = (ESCAPE - room) * 0.6;
      }
      score += (o.d === dir ? -0.25 : 0) + rng() * 0.7;
      if (hunting && o.n === ahead1 && t - lastCut >= CUT_COOLDOWN && rivalEscapes(o.n)) score -= 12;
      else if (hunting && rivalAlive && t - lastCut >= CUT_COOLDOWN && Math.abs(colOf(arena, rival2) - colOf(arena, head)) + Math.abs(rowOf(arena, rival2) - rowOf(arena, head)) <= 10 && Number.isFinite(intercept(o.n, t, rival2, rivalDir, rivalMoved))) score -= 6;
      if (!rivalHasMove(o.n)) score += 1e3;
      const better = safe && !bestSafe || safe === bestSafe && (safe ? score < bestScore : room > bestEscape || room === bestEscape && score < bestScore);
      if (better) {
        best = o;
        bestScore = score;
        bestSafe = safe;
        bestEscape = room;
      }
    }
    if (hunting && best.n === ahead1) {
      nearMisses++;
      lastCut = t;
    }
    visit[best.n] = t;
    owner[best.n] = k;
    me.push(best.n);
    dirs[k] = best.d;
    const day = days.get(best.n);
    if (day) {
      days.delete(best.n);
      derez.push({ tick: t, cell: day, by: k });
      if (days.size === 0) doneAt = t;
    }
  };
  const limit = 4e3;
  for (let t = 1; t < limit; t++) {
    if (days.size > 0 && days.size <= dayTotal * ENDGAME_SHARE2) fast.add(t);
    const order = t % 2 ? [0, 1] : [1, 0];
    const finale = doneAt >= 0 && t > doneAt;
    if (dayTotal === 0 && doneAt < 0) doneAt = 0;
    for (const k of order) {
      if (k === 1 && crashTick >= 0) continue;
      step(k, t, finale);
    }
    if (crashTick >= 0 && cells[0].length > crashTick + LAP_TICKS) break;
  }
  if (crashTick < 0) throw new Error("the rival never crashed");
  const lastTick = cells[0].length - 1;
  const base = clamp2(HUNT_SPAN / Math.max(doneAt, 1), BASE_STEP_MIN, BASE_STEP_MAX);
  const times = [0];
  for (let t = 1; t <= lastTick; t++) {
    times.push(times[t - 1] + (t > doneAt ? FINALE_STEP : fast.has(t) ? base * 0.72 : base));
  }
  const crashTime = times[crashTick] + FINALE_STEP * 0.5;
  const end = crashTime + LAP_AFTER;
  let keep = lastTick + 1;
  while (keep > 1 && times[keep - 2] > end + PACE.hold + 0.1) keep--;
  const make = (cs, tCollapse) => {
    const head = times.slice(0, cs.length);
    const tail = head.map((_, i) => i + trail < head.length ? head[i + trail] : Infinity);
    collapse(head, tail, tCollapse);
    return { cells: cs, head, tail };
  };
  const player = make(cells[0].slice(0, keep), end + 0.1);
  const rival = make(cells[1].slice(0, crashTick + 1), crashTime + 0.15);
  return {
    arena,
    cycles: [player, rival],
    derez: derez.map((e) => ({ t: times[Math.max(0, e.tick - 1)], cell: e.cell, by: e.by })),
    crash: { t: crashTime, x: crashPoint.x, y: crashPoint.y },
    harvestEnd: times[doneAt],
    end,
    trail,
    nearMisses,
    collisions
  };
}
function simulateTron(grid, rng) {
  const base = Math.floor(rng() * 1e9);
  let best = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const sim = race(grid, createRng(`${base}:${attempt}`));
    if (sim.collisions === 0 && (sim.nearMisses >= 1 || attempt >= 5)) return sim;
    const better = !best || sim.collisions < best.collisions || sim.collisions === best.collisions && sim.nearMisses > best.nearMisses;
    if (better) best = sim;
  }
  return best;
}
function isDark5(theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function mix3(a, b, k) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}
function paletteFor4(theme) {
  if (theme.name === "neon") {
    return { player: "#23f0ff", rival: "#ff9a1f", grid: "#5b34a8", gridOpacity: 0.55, border: "#23f0ff", glowStrength: 1 };
  }
  if (isDark5(theme)) {
    return { player: "#2fd8ff", rival: "#ff8a2b", grid: "#2b6a9c", gridOpacity: 0.4, border: "#2fd8ff", glowStrength: 1 };
  }
  return { player: "#0969da", rival: "#e5580c", grid: "#cfd6de", gridOpacity: 0.8, border: "#0969da", glowStrength: 0 };
}
var TRAIL_WIDTH = 4.4;
var CORE_WIDTH = 1.7;
function render8(ctx) {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark5(theme);
  const pal = paletteFor4(theme);
  const hasPlay = activeCells(grid).length > 0;
  const sim = hasPlay ? simulateTron(grid, ctx.rng) : null;
  const play = sim ? Math.round(sim.end * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const T = (t) => PACE.intro + t;
  const arena = sim?.arena ?? { c0: -1, c1: grid.width, cols: grid.width + 2, rows: ARENA_BOTTOM - ARENA_TOP + 1 };
  const half = layout.gap / 2;
  const gx0 = layout.left + arena.c0 * layout.pitch - half;
  const gx1 = layout.left + (arena.c1 + 1) * layout.pitch - half;
  const gy0 = layout.top + ARENA_TOP * layout.pitch - half;
  const gy1 = layout.top + (ARENA_BOTTOM + 1) * layout.pitch - half;
  const lines = [];
  for (let c = arena.c0; c <= arena.c1 + 1; c++) lines.push(`M${fmt(layout.left + c * layout.pitch - half)} ${fmt(gy0)}V${fmt(gy1)}`);
  for (let r = ARENA_TOP; r <= ARENA_BOTTOM + 1; r++) lines.push(`M${fmt(gx0)} ${fmt(layout.top + r * layout.pitch - half)}H${fmt(gx1)}`);
  const gridMarkup = `<path d="${lines.join("")}" fill="none" stroke="${pal.grid}" stroke-opacity="${pal.gridOpacity}" stroke-width="1"/><rect x="${fmt(gx0)}" y="${fmt(gy0)}" width="${fmt(gx1 - gx0)}" height="${fmt(gy1 - gy0)}" rx="3" fill="none" stroke="${pal.border}" stroke-opacity="${dark ? 0.55 : 0.5}" stroke-width="1.6"/>`;
  const filter = pal.glowStrength > 0 ? `<filter id="tron-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 0.9)}" result="a"/><feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 2.6)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : "";
  const glow = pal.glowStrength > 0 ? ` filter="url(#tron-glow)"` : "";
  const bursts = new Bursts(duration);
  const pixels = [
    [-14, -14],
    [0, -18],
    [14, -14],
    [-18, 0],
    [18, 0],
    [-14, 14],
    [0, 18],
    [14, 14]
  ].map(([dx, dy]) => ({ dx, dy, size: 4.4 }));
  bursts.define("derez", { life: 0.55, sparks: pixels });
  const crackle = Array.from({ length: 20 }, (_, i) => {
    const a = i / 20 * Math.PI * 2 + 0.2;
    const r = 26 + i * 7 % 5 * 5;
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, size: 4 + i % 3 };
  });
  bursts.define("crash", { life: 1.1, sparks: crackle, ring: 28, ringWidth: 2.6, flash: 9, flashColor: "#ffffff" });
  bursts.define("crashRing", { life: 0.8, sparks: [], ring: 40, ringWidth: 1.8 });
  const cells = [];
  for (const column of grid.cells) for (const cell of column) if (cell) cells.push(cellRect(layout, cell, theme.empty));
  const body = [];
  const clears = [];
  const dayMarkup = [];
  const burstMarkup = [];
  const trailMarkup = [];
  const cycleMarkup = [];
  const cycleDef = (color) => {
    const edge = dark ? "#ffffff" : theme.ink;
    return `<g transform="scale(1.3)"><path d="M-10 -3.4H5Q10.5 -3.4 10.5 0T5 3.4H-10Z" fill="${color}" stroke="${edge}" stroke-opacity="${dark ? 0.9 : 0.7}" stroke-width="1"/><rect x="-11.5" y="-4.6" width="4" height="9.2" rx="1.6" fill="${mix3(color, "#000000", 0.45)}"/><rect x="5" y="-4.2" width="4" height="8.4" rx="1.6" fill="${mix3(color, "#000000", 0.45)}"/><ellipse cx="-0.5" cy="0" rx="4.4" ry="2" fill="#ffffff" fill-opacity=".92"/><rect x="9" y="-1.2" width="2.6" height="2.4" fill="#ffffff"/></g>`;
  };
  const defs = filter + `<g id="cyc0">${cycleDef(pal.player)}</g><g id="cyc1">${cycleDef(pal.rival)}</g>` + bursts.defs();
  if (sim) {
    const point = (id) => cellCenter(layout, ...cellCoord(sim.arena, id));
    const jumpAt = restore + 0.3;
    const trailGroups = [];
    sim.cycles.forEach((cy2, which) => {
      const color = which === 0 ? pal.player : pal.rival;
      const core = dark ? "#ffffff" : mix3(color, "#ffffff", 0.55);
      const n = cy2.cells.length;
      const dirsOf = (i) => directionOf(sim.arena, cy2.cells[i - 1], cy2.cells[i]);
      const dtAt = (i) => i + 1 < n ? cy2.head[i + 1] - cy2.head[i] : i > 0 ? cy2.head[i] - cy2.head[i - 1] : 1;
      let a = 0;
      while (a < n - 1) {
        let b = a + 1;
        const d = dirsOf(b);
        while (b + 1 < n && dirsOf(b + 1) === d) b++;
        const [sx, sy] = point(cy2.cells[a]);
        const len = (b - a) * layout.pitch;
        const ext = len + TRAIL_WIDTH;
        const gOf = (i) => ((i - a) * layout.pitch + TRAIL_WIDTH) / ext;
        const fixedHead = (t) => {
          if (t <= cy2.head[a]) return 0;
          if (t >= cy2.head[b]) return 1;
          let i = a;
          while (i + 1 < b && cy2.head[i + 1] <= t) i++;
          const f = (t - cy2.head[i]) / (cy2.head[i + 1] - cy2.head[i]);
          return gOf(i) + (gOf(i + 1) - gOf(i)) * f;
        };
        const tailPos = (t) => {
          if (t <= cy2.tail[a]) return 0;
          let i = a;
          while (i < b && cy2.tail[i + 1] <= t) i++;
          if (i >= b) return 1;
          const span = cy2.tail[i + 1] - cy2.tail[i];
          const f = Number.isFinite(span) && span > 0 ? (t - cy2.tail[i]) / span : 0;
          return (i - a + f) * layout.pitch / ext;
        };
        const times = /* @__PURE__ */ new Set([cy2.head[a], cy2.head[b]]);
        for (let i = a + 1; i < b; i++) if (Math.abs(dtAt(i) - dtAt(i - 1)) > 1e-6) times.add(cy2.head[i]);
        let tailEnds = false;
        for (let i = a; i <= b; i++) {
          const t = cy2.tail[i];
          if (!Number.isFinite(t)) break;
          if (i === a || i === b || Math.abs(cy2.tail[Math.min(i + 1, n - 1)] - t - (t - cy2.tail[Math.max(i - 1, 0)])) > 1e-6) times.add(t);
          if (i === b) tailEnds = true;
        }
        const css = (g, dd) => `transform:translate(${fmt(dd * ext)}px,0) scale(${fmt(Math.max(0, g - dd))},1)`;
        const frames2 = [[0, css(0, 0)]];
        const sorted = [...times].sort((p, q) => p - q);
        for (const t of sorted) {
          if (t === cy2.head[a]) frames2.push([T(t), css(0, 0)]);
          frames2.push([T(t), css(fixedHead(t), tailPos(t))]);
        }
        if (tailEnds && Number.isFinite(cy2.tail[b])) frames2.push([T(cy2.tail[b]), css(1, 1)]);
        const cls = tl.track(frames2);
        const angle2 = d * 90;
        trailGroups.push(
          `<g transform="translate(${fmt(sx - TRAIL_WIDTH / 2 * DX3[d])} ${fmt(sy - TRAIL_WIDTH / 2 * DY3[d])}) rotate(${angle2})"><g class="${cls}"><rect x="0" y="${-TRAIL_WIDTH / 2}" width="${fmt(ext)}" height="${TRAIL_WIDTH}" rx="1" fill="${color}" fill-opacity="${dark ? 0.9 : 1}"/><rect x="0" y="${-CORE_WIDTH / 2}" width="${fmt(ext)}" height="${CORE_WIDTH}" fill="${core}"/></g></g>`
        );
        a = b;
      }
      const start = point(cy2.cells[0]);
      const end2 = point(cy2.cells[n - 1]);
      const posFrames = [[0, translate(start[0], start[1])]];
      const angleOf = (i) => (i + 1 < n ? directionOf(sim.arena, cy2.cells[i], cy2.cells[i + 1]) : dirsOf(i)) * 90;
      const startAngle = n > 1 ? angleOf(0) : which === 0 ? 0 : 180;
      let angle = startAngle;
      const rotFrames = [[0, `transform:rotate(${angle}deg)`]];
      for (let i = 0; i < n; i++) {
        const turning = i > 0 && i + 1 < n && directionOf(sim.arena, cy2.cells[i - 1], cy2.cells[i]) !== directionOf(sim.arena, cy2.cells[i], cy2.cells[i + 1]);
        const pace = i > 0 && i + 1 < n && Math.abs(dtAt(i) - dtAt(i - 1)) > 1e-6;
        if (i === 0 || i === n - 1 || turning || pace) {
          const [x, y] = point(cy2.cells[i]);
          posFrames.push([T(cy2.head[i]), translate(x, y)]);
        }
        if (turning) {
          const dIn = directionOf(sim.arena, cy2.cells[i - 1], cy2.cells[i]);
          const dOut = directionOf(sim.arena, cy2.cells[i], cy2.cells[i + 1]);
          const turn2 = (dOut - dIn + 4) % 4;
          const dt = dtAt(i);
          rotFrames.push([T(cy2.head[i]) - 0.12 * dt, `transform:rotate(${angle}deg)`]);
          angle += turn2 === 1 ? 90 : -90;
          rotFrames.push([T(cy2.head[i]) + 0.12 * dt, `transform:rotate(${angle}deg)`]);
        }
      }
      if (n === 1) posFrames.push([T(0), translate(start[0], start[1])]);
      posFrames.push([jumpAt, translate(end2[0], end2[1])], [jumpAt, translate(start[0], start[1])]);
      rotFrames.push([jumpAt, `transform:rotate(${angle}deg)`], [jumpAt, `transform:rotate(${startAngle}deg)`]);
      const crashAt = which === 1 ? T(sim.crash.t) : Infinity;
      const vis = [[0, "opacity:1"]];
      if (which === 1) {
        vis.push([crashAt, "opacity:1"], [crashAt + 1e-3, "opacity:0"], [duration - 0.35, "opacity:0"], [duration, "opacity:1"]);
      } else {
        vis.push([restore - 0.2, "opacity:1"], [restore + 0.1, "opacity:0"], [duration - 0.35, "opacity:0"], [duration, "opacity:1"]);
      }
      const pos = tl.track(posFrames);
      const rot = tl.track(rotFrames);
      const visClass = tl.track(vis);
      cycleMarkup.push(`<g class="${visClass}"><g class="${pos}"><g class="${rot}"><use href="#cyc${which}"/></g></g></g>`);
    });
    trailMarkup.push(`<g>${trailGroups.join("")}</g>`);
    const cleared = /* @__PURE__ */ new Map();
    for (const e of sim.derez) cleared.set(e.cell, T(e.t));
    for (const column of grid.cells) {
      for (const cell of column) {
        if (!cell || cell.level === 0) continue;
        const fill = levelColor(theme, cell);
        const flashFill = dark ? mix3(spriteColor(theme, cell), "#ffffff", 0.75) : spriteColor(theme, cell);
        const te = cleared.get(cell);
        if (te === void 0) throw new Error("a day was never reached");
        const cls = tl.track([
          [0, `opacity:1;transform:scale(1);fill:${fill}`],
          [te, `opacity:1;transform:scale(1);fill:${fill}`],
          [te + 0.05, `opacity:1;transform:scale(1.15);fill:${flashFill}`],
          [te + 0.22, `opacity:0;transform:scale(1.5);fill:${flashFill}`],
          [restore, `opacity:0;transform:scale(1);fill:${fill}`],
          [fadeEnd, `opacity:1;transform:scale(1);fill:${fill}`]
        ]);
        dayMarkup.push(cellRect(layout, cell, fill, `class="d ${cls}"`));
        const [cx2, cy2] = cellCenter(layout, cell.x, cell.y);
        burstMarkup.push(bursts.use("derez", cx2, cy2, te, spriteColor(theme, cell)));
        clears.push({ t: te, cell });
      }
    }
    const [cx, cy] = cellCenter(layout, sim.crash.x, sim.crash.y);
    const tc = T(sim.crash.t);
    burstMarkup.push(bursts.use("crash", cx, cy, tc, pal.rival), bursts.use("crashRing", cx, cy, tc + 0.12, pal.player));
  } else {
    for (const column of grid.cells) {
      for (const cell of column) if (cell && cell.level > 0) dayMarkup.push(cellRect(layout, cell, levelColor(theme, cell)));
    }
    const [x, y] = cellCenter(layout, -1, 3);
    const [x2] = cellCenter(layout, grid.width, 3);
    cycleMarkup.push(`<g transform="translate(${fmt(x)} ${fmt(y)})"><use href="#cyc0"/></g>`);
    cycleMarkup.push(`<g transform="translate(${fmt(x2)} ${fmt(y)}) rotate(180)"><use href="#cyc1"/></g>`);
  }
  const bar = hud(tl, grid, { theme, title: "TRON", clears, resetAt: restore, width });
  const end = sim ? banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: width / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: T(sim.end) + 0.1,
    to: restore
  }) : "";
  body.push(
    `<g>${gridMarkup}</g>`,
    `<g>${cells.join("")}</g>`,
    `<g>${dayMarkup.join("")}</g>`,
    `<g${glow}>${trailMarkup.join("")}${cycleMarkup.join("")}${burstMarkup.join("")}</g>`,
    bar,
    end
  );
  return { width, height, css: `.d{transform-box:fill-box;transform-origin:center}
${tl.css()}
${bursts.css()}`, defs, body: body.join("\n") };
}
function cellCoord(a, id) {
  return [colOf(a, id), rowOf(a, id)];
}
var tron = { id: "tron", title: "Tron", render: render8 };

// src/games/index.ts
var GAMES = {
  snake,
  pacman,
  breakout,
  invaders,
  asteroids,
  tetris,
  bomberman,
  galaga,
  centipede,
  tron
};

// src/render.ts
var GAME_IDS = Object.keys(GAMES);
function resolveGameId(id, now = /* @__PURE__ */ new Date()) {
  if (id === "daily") {
    const day = Math.floor(now.getTime() / 864e5);
    return GAME_IDS[day % GAME_IDS.length];
  }
  if (!GAMES[id]) {
    throw new Error(`Unknown game "${id}". Pick one of: ${[...GAME_IDS, "daily"].join(", ")}`);
  }
  return id;
}
function renderGame(game, grid, theme, seed) {
  const out = game.render({ grid, theme, rng: createRng(`${seed}:${game.id}`) });
  return svgDocument({
    width: out.width,
    height: out.height,
    title: `${game.title} played on a GitHub contribution graph`,
    css: out.css,
    defs: out.defs,
    body: out.body,
    background: theme.background
  });
}

// src/theme.ts
var THEMES = {
  "github-dark": {
    name: "github-dark",
    background: null,
    empty: "#151b23",
    levels: ["#033a16", "#196c2e", "#2ea043", "#56d364"],
    ink: "#e6edf3",
    muted: "#7d8590",
    accent: "#f5b53d",
    sprites: ["#2ea043", "#3fb950", "#56d364", "#7ee787"],
    surface: "#0d1117",
    glow: 1.6
  },
  "github-light": {
    name: "github-light",
    background: null,
    empty: "#eff2f5",
    levels: ["#aceebb", "#4ac26b", "#2da44e", "#116329"],
    ink: "#1f2328",
    muted: "#59636e",
    accent: "#8250df",
    sprites: ["#4ac26b", "#2da44e", "#1a7f37", "#116329"],
    surface: "#ffffff",
    glow: 0
  },
  neon: {
    name: "neon",
    background: "#0b0614",
    empty: "#1a1029",
    levels: ["#3b1d6e", "#6a2fd0", "#b14dff", "#ff4df0"],
    ink: "#f4ecff",
    muted: "#8c7aa8",
    accent: "#23f0ff",
    sprites: ["#8a4dff", "#b46bff", "#e07bff", "#ff6bf5"],
    surface: "#0b0614",
    glow: 3
  }
};
function resolveTheme(name, overrides = {}) {
  const base = THEMES[name];
  if (!base) {
    throw new Error(`Unknown theme "${name}". Pick one of: ${Object.keys(THEMES).join(", ")}`);
  }
  return { ...base, ...overrides };
}

// src/outputs.ts
var COLOR_KEYS = ["background", "empty", "ink", "muted", "accent", "surface"];
function parseOutput(line) {
  const [path, query = ""] = line.trim().split("?", 2);
  if (!path) throw new Error(`Output line has no file path: "${line}"`);
  const params = /* @__PURE__ */ new Map();
  for (const part of query.split("&").filter(Boolean)) {
    const [k, v = ""] = part.split("=", 2);
    params.set(k.trim(), decodeURIComponent(v.trim()));
  }
  const overrides = {};
  for (const key of COLOR_KEYS) {
    const v = params.get(key);
    if (v !== void 0) overrides[key] = v === "none" ? null : v;
  }
  for (const key of ["levels", "sprites"]) {
    const raw = params.get(key);
    if (!raw) continue;
    const list = raw.split(",").map((s) => s.trim());
    if (list.length !== 4) throw new Error(`${key} needs exactly 4 colours, got ${list.length}`);
    overrides[key] = list;
  }
  if (overrides.levels && !overrides.sprites) overrides.sprites = overrides.levels;
  return {
    path,
    game: params.get("game") ?? "snake",
    theme: params.get("theme") ?? "github-dark",
    overrides
  };
}
async function writeOutputs(grid, specs, seed, log = console.log) {
  const written = [];
  for (const spec of specs) {
    const id = resolveGameId(spec.game);
    const theme = resolveTheme(spec.theme, spec.overrides);
    const started = performance.now();
    const svg = renderGame(GAMES[id], grid, theme, seed);
    await mkdir(dirname(spec.path) || ".", { recursive: true });
    await writeFile(spec.path, svg, "utf8");
    const ms = Math.round(performance.now() - started);
    log(`${spec.path}: ${id}, ${theme.name}, ${(svg.length / 1024).toFixed(0)} KB in ${ms} ms`);
    written.push(spec.path);
  }
  return written;
}

// src/action.ts
function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}
async function run() {
  const user = input("github_user_name");
  const token = input("github_token");
  const lines = input("outputs").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!user) throw new Error("github_user_name is empty");
  if (!token) throw new Error("github_token is empty");
  if (lines.length === 0) throw new Error("outputs is empty: list at least one file to write");
  const grid = await fetchGrid(user, token);
  await writeOutputs(grid, lines.map(parseOutput), user);
}
run().catch((err) => {
  console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
