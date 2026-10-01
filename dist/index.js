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
  track(frames, timing = "linear") {
    const name = this.keyframes(frames);
    return this.useKeyframes(name, 0, timing);
  }
  /** Registers bare @keyframes so several elements can share them with different delays. */
  keyframes(frames) {
    const name = `${this.prefix}${this.count++}`;
    this.rules.push(`@keyframes ${name}{${this.body(frames)}}`);
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
  body(frames) {
    if (frames.length === 0) throw new Error("A track needs at least one frame");
    const sorted = frames.map(([t, css], i) => ({ t: Math.min(Math.max(t, 0), this.duration), css, i })).sort((a, b) => a.t - b.t || a.i - b.i);
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

// src/games/asteroids.ts
var MARGIN = { left: 26, top: 36, right: 26, bottom: 26 };
var CLEARANCE = 6.5;
var NOSE = 8;
var BULLET_SPEED = 800;
var SAUCER_SPEED = 300;
var SAUCER_LANE = 10;
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
function wrapDelta(d) {
  const twoPi = Math.PI * 2;
  return ((d + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
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
function planAsteroids(grid, layout, seed, tempo) {
  const rng = createRng(seed);
  const field = new Field(grid, layout);
  const cells = activeCells(grid);
  const total = cells.length;
  const W = grid.width;
  const H = grid.height;
  const NJ = H + 2;
  const width = layout.left + layout.gridWidth + MARGIN.right;
  const height = layout.top + layout.gridHeight + MARGIN.bottom;
  const center = { x: layout.left + layout.gridWidth / 2, y: layout.top + layout.gridHeight / 2 };
  const gap = 0.17 / tempo;
  const aimSpeed = 10 * tempo;
  const turnSpeed = 7 * tempo;
  const poses = [];
  const burns = [];
  const bullets = [];
  const hits = [];
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
  const visibleFrom = (p) => {
    let n = 0;
    for (const c of liveCells()) {
      const [cx, cy] = cellCenter(layout, c.x, c.y);
      const len = Math.hypot(cx - p.x, cy - p.y);
      const h = field.cast(p, (cx - p.x) / len, (cy - p.y) / len);
      if (h && h.cell === c) n++;
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
  const land = (now) => {
    for (let k = inFlight.length - 1; k >= 0; k--) {
      const h = inFlight[k];
      if (h.t <= now) {
        field.alive[h.cell.x][h.cell.y] = false;
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
      const score = visibleFrom(field.node(o.i, o.j)) - dist[id(o.i, o.j)] * 8e-3 + rng() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return flyTo(best.i, best.j);
  };
  const shoot = (aim, hit) => {
    const delta = wrapDelta(aim - angle);
    const dur = Math.max(gap, Math.abs(delta) / aimSpeed);
    angle += delta;
    segment(t, t + dur, pos.x, pos.y, angle, Math.abs(delta) > 0.5 ? TURN_EASE : "linear");
    t += dur;
    const dx = Math.cos(aim);
    const dy = Math.sin(aim);
    const from = { x: pos.x + dx * NOSE, y: pos.y + dy * NOSE };
    const to = { x: pos.x + dx * hit.dist, y: pos.y + dy * hit.dist };
    const flight = Math.max(0.02, (hit.dist - NOSE) / BULLET_SPEED);
    bullets.push({ t0: t, t1: t + flight, from, to });
    const h = { cell: hit.cell, t: t + flight, point: to, dir: aim };
    hits.push(h);
    inFlight.push(h);
    reserved.add(hit.cell);
    return h;
  };
  const pickShot = (lastSign2) => {
    let best = null;
    for (const c2 of liveCells()) {
      const [cx2, cy2] = cellCenter(layout, c2.x, c2.y);
      const len2 = Math.hypot(cx2 - pos.x, cy2 - pos.y);
      const hit2 = field.cast(pos, (cx2 - pos.x) / len2, (cy2 - pos.y) / len2);
      if (!hit2 || reserved.has(hit2.cell)) continue;
      const aim = Math.atan2(cy2 - pos.y, cx2 - pos.x);
      const delta = wrapDelta(aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign2 ? 0.12 : 0;
      const cost = Math.abs(delta) + reversal + hit2.dist * 4e-4;
      if (!best || cost < best.cost) best = { cell: hit2.cell, dist: hit2.dist, angle: aim, delta, cost };
    }
    if (!best) return null;
    const c = best.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    const ax = cx + (rng() - 0.5) * 5 - pos.x;
    const ay = cy + (rng() - 0.5) * 5 - pos.y;
    const len = Math.hypot(ax, ay);
    const hit = field.cast(pos, ax / len, ay / len);
    if (hit && hit.cell === c) {
      const aim = Math.atan2(ay, ax);
      return { cell: c, dist: hit.dist, angle: aim, delta: wrapDelta(aim - angle), cost: best.cost };
    }
    return best;
  };
  const runSaucer = () => {
    const eventStart = t;
    const wide = width / 2;
    const picks = [];
    for (let i = Math.round(W * 0.25); i <= Math.round(W * 0.75); i++) {
      picks.push({ i, d: Math.abs(field.node(i, -1).x - pos.x) });
    }
    picks.sort((a, b) => a.d - b.d);
    const spotI = picks[0].i;
    flyTo(spotI, -1);
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
    const reach = (first.m.y + 8) / -Math.sin(first.a);
    segment(t, fire1, spot.x, spot.y, angle + wrapDelta(first.a - angle), TURN_EASE);
    angle += wrapDelta(first.a - angle);
    bullets.push({
      t0: fire1,
      t1: fire1 + reach / BULLET_SPEED,
      from: first.m,
      to: { x: first.m.x + Math.cos(first.a) * reach, y: -8 }
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
  while (fired < total) {
    land(t);
    if (!sauced && total >= 12 && fired >= Math.floor(total * 0.45)) {
      sauced = true;
      runSaucer();
      spotShots = 0;
      continue;
    }
    const shot = pickShot(lastSign);
    if (!shot) {
      t = Math.min(...inFlight.map((h) => h.t));
      continue;
    }
    if (spotShots >= limit || spotShots >= 2 && Math.abs(shot.delta) > 1.4) {
      relocate();
      spotShots = 0;
      limit = quota();
      continue;
    }
    const delta = shot.delta;
    shoot(shot.angle, shot);
    if (Math.abs(delta) > 0.01) lastSign = Math.sign(delta);
    spotShots++;
    fired++;
  }
  let end = Math.max(t, lastEvent);
  for (const h of hits) end = Math.max(end, h.t);
  return {
    layout,
    width,
    height,
    poses,
    burns,
    bullets,
    hits,
    saucer,
    play: Math.max(end + 0.25, 2.4)
  };
}
function playAsteroids(ctx) {
  const layout = makeLayout(ctx.grid, { left: MARGIN.left, top: MARGIN.top });
  const seed = Math.floor(ctx.rng() * 2 ** 32);
  const n = activeCells(ctx.grid).length;
  let tempo = n < 80 ? Math.max(0.55, n / 80) : 1;
  let play = planAsteroids(ctx.grid, layout, seed, tempo);
  while (play.play > MAX_PLAY && tempo < 4) {
    tempo *= 1.2;
    play = planAsteroids(ctx.grid, layout, seed, tempo);
  }
  return play;
}
var GLYPHS = {
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"]
};
function glyphPath(rows, px) {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let e = x;
      while (e < row.length && row[e] === "#") e++;
      d += `M${x * px} ${y * px}h${(e - x) * px}v${px}h${-(e - x) * px}z`;
      x = e;
    }
  });
  return d;
}
var f1 = (n) => String(Math.round(n * 10) / 10);
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
  const defs = [];
  const driftTime = 1.35;
  const driftFrames = (angle, dist, spin) => {
    const out = [];
    for (const s of [0, 0.12, 0.3, 0.55, 1]) {
      const e = 1 - (1 - s) * (1 - s);
      const op = s < 0.4 ? 1 : 1 - (s - 0.4) / 0.6;
      out.push([
        s * driftTime,
        `transform:translate(${fmt(Math.cos(angle) * dist * e)}px,${fmt(Math.sin(angle) * dist * e)}px) rotate(${fmt(spin * e)}deg);opacity:${fmt(op)}`
      ]);
    }
    return out;
  };
  const SLOTS = 16;
  const drift = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    for (const dist of [15, 27]) {
      for (const spin of [1, -1]) {
        drift.push(tl.keyframes(driftFrames(slot / SLOTS * Math.PI * 2, dist, spin * (170 + rng() * 150))));
      }
    }
  }
  const burst = tl.keyframes([
    [0, "transform:scale(.35);opacity:1;animation-timing-function:ease-out"],
    [0.3, "transform:scale(1.9);opacity:0"]
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
  const rays = Array.from({ length: 8 }, (_, k) => {
    const a = k / 8 * Math.PI * 2 + 0.2;
    return `M${f1(Math.cos(a) * 3)} ${f1(Math.sin(a) * 3)}L${f1(Math.cos(a) * (k % 2 ? 5.5 : 7.5))} ${f1(Math.sin(a) * (k % 2 ? 5.5 : 7.5))}`;
  }).join("");
  defs.push(`<path id="sp" d="${rays}" fill="none" stroke="${accent}" stroke-width="1.2" stroke-linecap="round"/>`);
  defs.push(
    `<g id="bl"><circle r="3.4" fill="${ink}" opacity=".28"/><circle r="1.7" fill="${ink}"/></g>`
  );
  defs.push(`<path id="sh" d="M8 0L-6 -5L-3.4 0L-6 5Z"/>`);
  defs.push(`<path id="ufo" d="M-10 1.5L-4.5 -1.8H4.5L10 1.5ZM-10 1.5L-4.5 4.6H4.5L10 1.5ZM-3.6 -1.8L-2 -5H2L3.6 -1.8"/>`);
  const level = (cell) => levelColor(theme, cell);
  for (const hit of play.hits) {
    const c = hit.cell;
    const frames = [
      [0, `fill:${level(c)}`],
      [L(hit.t), `fill:${level(c)}`],
      [L(hit.t) + eps, `fill:${theme.empty}`],
      [restore, `fill:${theme.empty}`],
      [restore + PACE.restore, `fill:${level(c)}`]
    ];
    body.push(cellRect(layout, c, level(c), `class="${tl.track(frames)}"`));
  }
  const rest = [];
  for (const col of grid.cells) {
    for (const c of col) {
      if (c && c.level === 0) rest.push(cellRect(layout, c, theme.empty));
    }
  }
  body.unshift(...rest);
  const debris = [];
  const sparks = [];
  const bulletsOut = [];
  for (const hit of play.hits) {
    const c = hit.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    const count = c.level >= 4 ? 4 : c.level === 3 ? 3 : 2 + Math.floor(rng() * 2);
    for (const piece of shatter(rng, layout.cell, count)) {
      const outward = Math.atan2(piece.cy, piece.cx);
      const vx = Math.cos(outward) * 0.7 + Math.cos(hit.dir) * 0.9;
      const vy = Math.sin(outward) * 0.7 + Math.sin(hit.dir) * 0.9;
      const slot = (Math.round(Math.atan2(vy, vx) / (Math.PI * 2) * SLOTS) + SLOTS * 2) % SLOTS;
      const variant = slot * 4 + (rng() < 0.5 ? 0 : 2) + (rng() < 0.5 ? 0 : 1);
      const cls = tl.useKeyframes(drift[variant], L(hit.t));
      debris.push(
        `<g transform="translate(${f1(cx + piece.cx)} ${f1(cy + piece.cy)})"><polygon class="r${c.level} ${cls}" points="${piece.points}"/></g>`
      );
    }
    sparks.push(
      `<g transform="translate(${f1(hit.point.x)} ${f1(hit.point.y)})"><use href="#sp" class="${tl.useKeyframes(burst, L(hit.t))}"/></g>`
    );
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
  if (play.saucer) {
    const s = play.saucer;
    const pos = (p) => `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px)`;
    const first2 = s.path[0];
    const last2 = s.path[s.path.length - 1];
    const frames = [
      [0, `opacity:0;${pos(first2)}`],
      [L(s.tIn), `opacity:0;${pos(first2)}`],
      [L(s.tIn) + eps, `opacity:1;${pos(first2)}`],
      ...s.path.map((p) => [L(p.t), `opacity:1;${pos(p)}`]),
      [L(s.tOut) + eps, `opacity:0;${pos(last2)}`]
    ];
    const cls = tl.track(frames);
    saucerOut += `<g class="${cls}"><use href="#ufo" class="glow"/><use href="#ufo" class="line"/></g>`;
    const at = `translate(${f1(last2.x)} ${f1(last2.y)})`;
    saucerOut += `<g transform="${at} scale(1.35)"><use href="#sp" class="${tl.useKeyframes(burst, L(s.tOut))}"/></g>`;
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2 + 0.3 + rng() * 0.4;
      const len = 3 + rng() * 3;
      const slot = (Math.round(a / (Math.PI * 2) * SLOTS) + SLOTS) % SLOTS;
      const cls2 = tl.useKeyframes(drift[slot * 4 + 2 + k % 2], L(s.tOut));
      saucerOut += `<g transform="${at} rotate(${f1(a * 180 / Math.PI)})"><path class="line ${cls2}" d="M${f1(-len)} 0H${f1(len)}"/></g>`;
    }
  }
  const poseFrames = play.poses.map((p) => [
    L(p.t),
    `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) rotate(${fmt(p.a * 180 / Math.PI)}deg);animation-timing-function:${p.ease}`
  ]);
  const first = play.poses[0];
  const last = play.poses[play.poses.length - 1];
  const warpIn = 0.2;
  const spinAt = L(play.play) + 0.05;
  const spinEnd = spinAt + 0.85;
  const outAt = restore - 0.4;
  poseFrames.push(
    [spinAt, `transform:translate(${fmt(last.x)}px,${fmt(last.y)}px) rotate(${fmt(last.a * 180 / Math.PI)}deg);animation-timing-function:cubic-bezier(.3,.6,.3,1)`],
    [spinEnd, `transform:translate(${fmt(last.x)}px,${fmt(last.y)}px) rotate(${fmt(last.a * 180 / Math.PI + 720)}deg)`]
  );
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
  const ringAt = (p, kf, t) => `<g transform="translate(${f1(p.x)} ${f1(p.y)})"><circle r="12" class="ring ${tl.useKeyframes(kf, t)}"/></g>`;
  const rings = ringAt(first, implode, warpIn) + ringAt(last, explode, outAt + 0.04);
  const ship = `<g class="${move}"><g class="${shimmer}"><g class="${flameCls}"><g transform="translate(-3.4 0)"><g class="flick"><path class="burn" d="M0 -2.4L-7 0L0 2.4"/><path class="burn" d="M0 -1L-3.6 0L0 1"/></g></g></g><use href="#sh" class="glow"/><use href="#sh" class="line"/></g></g>`;
  const px = 4;
  const word = "GAME CLEAR";
  const advance = (ch) => ch === " " ? 3 * px : 6 * px;
  const wordWidth = [...word].reduce((s, ch) => s + advance(ch), 0) - px;
  const tx = layout.left + layout.gridWidth / 2 - wordWidth / 2;
  const ty = layout.top + layout.gridHeight / 2 - 7 * px / 2;
  for (const ch of Object.keys(GLYPHS)) defs.push(`<path id="g${ch}" d="${glyphPath(GLYPHS[ch], px)}"/>`);
  let text = "";
  let cursor = tx;
  let n = 0;
  for (const ch of word) {
    if (ch !== " ") {
      const cls = tl.visible(L(play.play) + 0.2 + n * 0.055, restore + 0.1, 1e-3);
      text += `<g class="${cls}"><use href="#g${ch}" x="${f1(cursor + 2)}" y="${f1(ty + 2)}" fill="${accent}"/><use href="#g${ch}" x="${f1(cursor)}" y="${f1(ty)}" fill="${ink}"/></g>`;
      n++;
    }
    cursor += advance(ch);
  }
  const css = [
    tl.css(),
    ...[1, 2, 3, 4].map((l) => `.r${l}{fill:${theme.levels[l - 1]};stroke:${ink};stroke-width:.9;stroke-linejoin:round;stroke-opacity:.85}`),
    `.glow{fill:none;stroke:${ink};stroke-width:3.6;stroke-opacity:.2;stroke-linejoin:round;stroke-linecap:round}`,
    `.line{fill:none;stroke:${ink};stroke-width:1.25;stroke-linejoin:round;stroke-linecap:round}`,
    `.burn{fill:none;stroke:${accent};stroke-width:1.2;stroke-linejoin:round;stroke-linecap:round}`,
    `.ring{fill:none;stroke:${ink};stroke-width:1;opacity:0}`,
    `.flick{animation:flick .16s steps(1) infinite}`,
    `@keyframes flick{0%{transform:scale(1,1)}33%{transform:scale(.6,.75)}66%{transform:scale(1.25,1.1)}}`
  ].join("\n");
  return {
    width: play.width,
    height: play.height,
    css,
    defs: defs.join(""),
    body: [...body, ...debris, ...sparks, ...bulletsOut, saucerOut, rings, ship, text].join("")
  };
}
var asteroids = {
  id: "asteroids",
  title: "Asteroids",
  render(ctx) {
    return renderAsteroids(ctx, playAsteroids(ctx));
  }
};

// src/games/pixel-font.ts
var GLYPHS2 = {
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
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};
function pixelText(text, scale = 2) {
  const chars = [...text.toUpperCase()];
  const parts = [];
  chars.forEach((ch, i) => {
    const rows = GLYPHS2[ch];
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

// src/games/breakout.ts
var BALL_R = 3;
var PADDLE_HALF = 32;
var PADDLE_H = 6;
var VOID = 34;
var MAX_TILT = 56 * Math.PI / 180;
var MIN_VERTICAL = 0.5;
var FIRE_SHARE = 0.35;
var SIM_SPEED = 600;
var SIM_DT = 1 / 720;
var TARGET_PLAY = 40;
var MIN_SPEED = 330;
var MAX_SPEED = 800;
var RAMP_FROM = 0.8;
var RAMP_TO = 1.3;
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
  const factors = breaks.map((t) => {
    const done = sim.hits.filter((h) => h.final && h.t <= t).length;
    return RAMP_FROM + (RAMP_TO - RAMP_FROM) * (done / total);
  });
  const unscaled = [0];
  for (let i = 1; i < breaks.length; i++) unscaled.push(unscaled[i - 1] + (breaks[i] - breaks[i - 1]) / factors[i - 1]);
  const base = Math.min(MAX_SPEED, Math.max(MIN_SPEED, SIM_SPEED * unscaled[unscaled.length - 1] / TARGET_PLAY));
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
var FLASH_TIME = 0.1;
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
function render(ctx) {
  const { grid, theme, rng } = ctx;
  const layout = makeLayout(grid, { left: 14, top: 14 });
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
  const width = court.fieldR + 14;
  const height = court.padTop + PADDLE_H + 10;
  const parts = [];
  parts.push(
    `<path d="M${court.fieldL - 1} ${court.padTop + PADDLE_H}V${court.fieldT - 1}H${court.fieldR + 1}V${court.padTop + PADDLE_H}" fill="none" stroke="${theme.muted}" stroke-opacity=".5" stroke-width="2" stroke-linejoin="round"/>`
  );
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));
  const flash = theme.ink;
  const pops = [];
  const hitsByCell = /* @__PURE__ */ new Map();
  for (const h of sim.hits) {
    const list = hitsByCell.get(h.cell) ?? [];
    list.push(h);
    hitsByCell.set(h.cell, list);
  }
  const burst = [
    { dx: -11, dy: -9 },
    { dx: 12, dy: -7 },
    { dx: -8, dy: 3 },
    { dx: 9, dy: 5 }
  ].map(
    ({ dx, dy }) => tl.keyframes([
      [0, "opacity:1;transform:translate(0px,0px) scale(1)"],
      [0.18, `opacity:.9;transform:translate(${fmt(dx * 0.65)}px,${fmt(dy * 0.65 - 3)}px) scale(.8)`],
      [0.5, `opacity:0;transform:translate(${dx}px,${dy + 6}px) scale(.3)`]
    ])
  );
  const burstClass = ["pa", "pb", "pc", "pd"];
  const burstCss = burst.map((name, i) => `.${burstClass[i]}{animation:${name} ${fmt(duration)}s ease-out infinite;animation-delay:var(--d)}`);
  for (const cell of activeCells(grid)) {
    const hits = hitsByCell.get(cell) ?? [];
    const top = levelColor(theme, cell);
    const worn = levelColor(theme, { ...cell, level: cell.level - 1 });
    const frames = [[0, state(top, 1, 1)]];
    let last = top;
    for (const h of hits) {
      const t = at(h.t);
      if (!h.final) {
        frames.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + FLASH_TIME * 1.2, state(worn, 1, 1)]);
        last = worn;
      } else {
        frames.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + FLASH_TIME, state(flash, 0, 1.45)]);
        const delay = -(duration - t);
        const cx = layout.left + cell.x * layout.pitch + layout.cell / 2;
        const cy = layout.top + cell.y * layout.pitch + layout.cell / 2;
        const px = (n) => fmt(n - 1.2);
        pops.push(
          `<g fill="${last}" style="--d:${fmt(delay)}s">${burstClass.map((c) => `<rect class="p ${c}" x="${px(cx)}" y="${px(cy)}" width="2.4" height="2.4"/>`).join("")}</g>`
        );
      }
    }
    frames.push([back, state(top, 0, 1)], [back + PACE.restore, state(top, 1, 1)]);
    parts.push(cellRect(layout, cell, top, `class="b ${tl.track(frames)}"`));
  }
  parts.push(...pops);
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
  const glide = smoothGlide(back, cur.x, returnEnd, court.startX);
  for (const [gt, gx] of glide) paddleFrames.push([gt, pos(gx)]);
  for (const [gt, gx] of smoothGlide(back, empty ? court.startX : ballEnd[1], returnEnd, court.startX)) {
    ballFrames.push([gt, ballPos(gx, startY)]);
  }
  paddleFrames.push([duration, pos(court.startX)]);
  ballFrames.push([duration, ballPos(court.startX, startY)]);
  const padRaw = tl.track(paddleFrames);
  const padSquash = tl.track(squash, "linear");
  parts.push(
    `<g class="${padRaw}"><g class="sq ${padSquash}"><rect x="${-PADDLE_HALF - 2}" y="-2" width="${PADDLE_HALF * 2 + 4}" height="${PADDLE_H + 4}" rx="${PADDLE_H / 2 + 2}" fill="${theme.accent}" opacity=".22"/><rect x="${-PADDLE_HALF}" y="0" width="${PADDLE_HALF * 2}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.ink}"/><rect x="${-PADDLE_HALF + 3}" y="0" width="${PADDLE_HALF * 2 - 6}" height="1.8" rx=".9" fill="${theme.accent}"/></g></g>`
  );
  const ballKeys = tl.keyframes(ballFrames);
  const ghosts = (sizes, lags, colors, opacities) => sizes.map((s, i) => {
    const cls = tl.useKeyframes(ballKeys, lags[i]);
    return `<rect class="${cls}" x="${fmt(-s / 2)}" y="${fmt(-s / 2)}" width="${s}" height="${s}" rx="${fmt(s / 4)}" fill="${colors[i]}" opacity="${opacities[i]}"/>`;
  }).join("");
  const plain = ghosts([5.4, 4.8, 4.2, 3.6], [0.012, 0.024, 0.036, 0.048], Array(4).fill(theme.ink), [0.34, 0.24, 0.15, 0.08]) + `<rect class="${tl.useKeyframes(ballKeys, 0)}" x="-3" y="-3" width="6" height="6" rx="1.5" fill="${theme.ink}"/>`;
  if (sim.fire) {
    const f = sim.fire;
    const ft = at(f.t);
    parts.push(`<g class="${tl.track([[0, "opacity:1"], [ft, "opacity:1"], [ft + 1e-3, "opacity:0"], [parkT, "opacity:0"], [parkT + 1e-3, "opacity:1"]])}">${plain}</g>`);
    const embers = ["#ffd23f", "#ffa51f", "#ff7a1a", "#ff5a1a", "#e8321a", "#c2241a"];
    const flameGhosts = ghosts(
      [6.4, 5.8, 5.2, 4.6, 3.8, 3],
      [0.01, 0.02, 0.032, 0.046, 0.062, 0.08],
      embers,
      [0.95, 0.85, 0.7, 0.55, 0.4, 0.25]
    );
    const core = `<rect class="${tl.useKeyframes(ballKeys, 0)}" x="-3.4" y="-3.4" width="6.8" height="6.8" rx="2" fill="#ff6a1a"/><rect class="${tl.useKeyframes(ballKeys, 0)}" x="-1.8" y="-1.8" width="3.6" height="3.6" rx="1" fill="#fff0a8"/>`;
    parts.push(`<g class="${tl.track([[0, "opacity:0"], [ft, "opacity:0"], [ft + 1e-3, "opacity:1"], [parkT, "opacity:1"], [parkT + 1e-3, "opacity:0"]])}">${flameGhosts}${core}</g>`);
    const ring = tl.track([
      [ft, "opacity:0;transform:scale(.4)"],
      [ft + 1e-3, "opacity:1;transform:scale(.6)"],
      [ft + 0.4, "opacity:0;transform:scale(4.5)"]
    ]);
    parts.push(`<circle class="ring ${ring}" cx="${fmt(f.x)}" cy="${fmt(f.y)}" r="4" fill="none" stroke="#ff7a1a" stroke-width="1.6"/>`);
  } else {
    parts.push(plain);
  }
  if (!empty) {
    const text = pixelText("CLEAR!", 3);
    const tx = fmt(layout.left + layout.gridWidth / 2 - text.width / 2);
    const ty = fmt(layout.top + layout.gridHeight / 2 - text.height / 2);
    const blink = [[0, "opacity:0"]];
    let t = parkT + 0.05;
    for (let i = 0; i < 4; i++) {
      blink.push([t, "opacity:0"], [t + 1e-3, "opacity:1"], [t + 0.13, "opacity:1"], [t + 0.131, "opacity:0"]);
      t += 0.26;
    }
    blink.push([t, "opacity:0"], [t + 1e-3, "opacity:1"], [back - 0.05, "opacity:1"], [back - 0.049, "opacity:0"]);
    parts.push(
      `<g class="${tl.track(blink)}"><path d="${text.d}" transform="translate(${fmt(Number(tx) + 3)} ${fmt(Number(ty) + 3)})" fill="${theme.accent}"/><path d="${text.d}" transform="translate(${tx} ${ty})" fill="${theme.ink}"/></g>`
    );
  }
  const css = [
    ".b,.p,.sq,.ring{transform-box:fill-box;transform-origin:center}",
    ".sq{transform-origin:50% 100%}",
    ...burstCss,
    tl.css()
  ].join("\n");
  return { width, height, css, body: parts.join("\n") };
}
var breakout = { id: "breakout", title: "Breakout", render };

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
var SPRITE_SCALE = [1, 1, 12 / 11, 1.5];
var BLAST_SCALE = 1.25;
var CANNON_SCALE = 2;
var CANNON_HALF = 13;
var SHOT_SPEED = 620;
var BOMB_SPEED = 170;
var UFO_SPEED = 190;
var CANNON_SPEED = 650;
var HOLD = 0.04;
var SWAY = [0, 2, 4, 6, 8, 6, 4, 2, 0, -2, -4, -6, -8, -6, -4, -2];
var TARGET_PLAY2 = 38;
var BUNKER_TILE = 2;
var BUNKER_COLS = 13;
var BUNKER_ROWS = 8;
var UFO_AFTER = [0.15, 0.55];
var SHOT_H = 10;
var SHOT_LEAD = 6;
function makeField(grid) {
  const layout = makeLayout(grid, { left: 20, top: 26 });
  const bottom = layout.top + layout.gridHeight;
  const width = layout.left + layout.gridWidth + 20;
  const bunkerWidth = BUNKER_COLS * BUNKER_TILE;
  const slot = (layout.gridWidth + 4) / 4;
  return {
    layout,
    width,
    height: bottom + 84,
    ufoY: 7,
    bunkerTop: bottom + 22,
    cannonY: bottom + 54,
    groundY: bottom + 74,
    bunkerX: [0, 1, 2, 3].map((i) => Math.round(layout.left + slot * (i + 0.5) - bunkerWidth / 2 - 2)),
    startX: Math.round(width / 2)
  };
}
var species = (cell) => cell.level - 1;
var columnX = (layout, col) => layout.left + col * layout.pitch + layout.cell / 2;
var spriteHeight = (cell) => 8 * SPRITE_SCALE[species(cell)];
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
  const ufoFlight = (cannonY - SHOT_LEAD - (ufoY + 7)) / SHOT_SPEED;
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
    plan.shots.push({ fire: p.fire, hit: p.hit, x: p.x, y: ufoY + 7, cell: null });
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
    let best = null;
    for (let col = 0; col < cols; col++) {
      const cell2 = columns[col][0];
      if (!cell2) continue;
      const bottom = spriteBottom(layout, cell2);
      const flight = (cannonY - SHOT_LEAD - bottom) / SHOT_SPEED;
      let fire = lastFire + fireGap;
      let hit = fire + flight;
      let x = columnX(layout, col) + offsetAt(march, hit);
      for (let i = 0; i < 3; i++) {
        fire = Math.max(lastFire + fireGap, lastFire + HOLD + Math.abs(x - cannonX) / CANNON_SPEED);
        hit = fire + flight;
        x = columnX(layout, col) + offsetAt(march, hit);
      }
      if (fire < lock[col]) continue;
      const dx = x - cannonX;
      const dir = Math.sign(dx);
      const cost = Math.abs(dx) + (dir !== 0 && dir !== lastDir && Math.abs(dx) > 3 ? 22 : 0) + 2.5 * columns[col].length + rng() * 5;
      if (!best || cost < best.cost) best = { col, fire, hit, x, cost };
    }
    if (!best) {
      lastFire += fireGap;
      continue;
    }
    if (pending && best.fire + HOLD + Math.abs(pending.x - best.x) / CANNON_SPEED > pending.fire) {
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
  const fireGap = Math.min(0.5, Math.max(0.1, TARGET_PLAY2 / Math.max(total, 1)));
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
  for (const ev of events) {
    if (ev.kind === "shot") {
      const b2 = bunkerAt(ev.x);
      if (b2 < 0) continue;
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
function render2(ctx) {
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
  const green = light ? "#1a7f37" : "#20ff20";
  const red = light ? "#cf222e" : "#ff3b3b";
  const ink = theme.ink;
  const delay = (t) => `style="--d:${(-(duration - at(t))).toFixed(3)}s"`;
  const empty = sim.kills.length === 0;
  const defs = [];
  const names = ["o", "c", "s"];
  [OCTOPUS, CRAB, SQUID].forEach((frames, i) => {
    frames.forEach((rows, f) => defs.push(`<path id="${names[i]}${f}" d="${bitmapPath(rows, [SPRITE_SCALE[0], SPRITE_SCALE[2], SPRITE_SCALE[3]][i])}"/>`));
  });
  defs.push(`<path id="bl" d="${bitmapPath(BLAST, BLAST_SCALE)}"/>`, `<path id="sp" d="${bitmapPath(SPLAT)}"/>`);
  defs.push(`<path id="uf" d="${bitmapPath(UFO)}"/>`, `<path id="cn" d="${bitmapPath(CANNON, CANNON_SCALE)}"/>`);
  for (let i = 0; i < 4; i++) defs.push(`<path id="bm${i}" d="${bitmapPath(bombRows(i))}"/>`);
  const parts = [];
  for (const cell of allCells(grid).filter((c) => c.level === 0)) {
    const [x, y] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
    parts.push(`<rect x="${x}" y="${y}" width="${layout.cell}" height="${layout.cell}" rx="${layout.radius}" fill="${theme.empty}"/>`);
  }
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
      `<g class="${cls}" fill="${levelColor(theme, cell)}"><use class="${legAClass}" href="#${id}0" x="${fmt(x)}" y="${fmt(y)}"/><use class="${legBClass}" href="#${id}1" x="${fmt(x)}" y="${fmt(y)}"/></g>`
    );
    const cx = columnX(layout, cell.x) + offsetAt(sim.march, kill.t);
    blasts.push(`<use class="bx" href="#bl" x="${fmt(cx - 6.5 * BLAST_SCALE)}" y="${fmt(y + spriteHeight(cell) / 2 - 3.5 * BLAST_SCALE)}" ${delay(kill.t)}/>`);
  }
  parts.push(`<g class="${marchClass}">${invaders2.join("")}</g>`);
  parts.push(`<g fill="${ink}">${blasts.join("")}</g>`);
  const gone = /* @__PURE__ */ new Set();
  for (const chip of sim.chips) for (const [b, c, r] of chip.tiles) gone.add(`${b}:${c}:${r}`);
  const bunkerStatic = [];
  field.bunkerX.forEach((bx, b) => {
    const rows = BUNKER.map((row, r) => [...row].map((ch, c) => ch === "#" && !gone.has(`${b}:${c}:${r}`) ? "#" : ".").join(""));
    bunkerStatic.push(bitmapPath(rows, BUNKER_TILE, bx, field.bunkerTop));
  });
  parts.push(`<path d="${bunkerStatic.join("")}" fill="${green}"/>`);
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
    const startX = u.dir > 0 ? -16 : field.width;
    const endX2 = u.dir > 0 ? field.width : -16;
    const cross = (field.width + 16) / UFO_SPEED;
    const a = at(u.start);
    const frames = [[0, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:1;${translate(startX, field.ufoY)}`]];
    if (u.hit !== null) {
      const h = at(u.hit);
      const x = u.hitX - 8;
      frames.push([h, `opacity:1;${translate(x, field.ufoY)}`], [h, `opacity:0;${translate(x, field.ufoY)}`]);
    } else {
      frames.push([a + cross, `opacity:1;${translate(endX2, field.ufoY)}`], [a + cross, `opacity:0;${translate(endX2, field.ufoY)}`]);
    }
    ufoEls.push(`<use class="${tl.track(frames)}" href="#uf" fill="${red}"/>`);
    if (u.hit !== null) {
      const h = at(u.hit);
      const label = pixelText(String(u.score), 2);
      const lx = Math.min(Math.max(u.hitX - label.width / 2, 2), field.width - label.width - 2);
      ufoEls.push(`<use class="bx" href="#bl" x="${fmt(u.hitX - 6.5 * BLAST_SCALE)}" y="${fmt(field.ufoY + 3.5 - 3.5 * BLAST_SCALE)}" fill="${red}" ${delay(u.hit)}/>`);
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
  parts.push(`<g class="${tl.track(cannonFrames)}"><use class="${tl.track(blink)}" href="#cn" fill="${green}"/></g>`);
  if (!empty) {
    const text = pixelText("WAVE CLEARED", 4);
    const pad = 12;
    const px = layout.left + layout.gridWidth / 2 - text.width / 2;
    const py = layout.top + layout.gridHeight / 2 - text.height / 2;
    const panel = theme.background ?? (light ? "#ffffff" : "#0d1117");
    const flashT = at(play) + 0.1;
    const on = [[0, "opacity:0"]];
    let t = flashT;
    for (let i = 0; i < 2; i++) {
      on.push(...tri(t, "opacity:0", "opacity:1"), ...tri(t + 0.12, "opacity:1", "opacity:0"));
      t += 0.22;
    }
    on.push(...tri(t, "opacity:0", "opacity:1"), ...tri(back - 0.05, "opacity:1", "opacity:0"));
    parts.push(
      `<g class="${tl.track(on)}"><rect x="${fmt(px - pad)}" y="${fmt(py - pad)}" width="${fmt(text.width + pad * 2)}" height="${fmt(text.height + pad * 2)}" rx="4" fill="${panel}" fill-opacity=".92" stroke="${green}" stroke-width="2"/><path d="${text.d}" transform="translate(${fmt(px)} ${fmt(py)})" fill="${green}"/></g>`
    );
  }
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
  return { width: field.width, height: field.height, css, defs: defs.join(""), body: parts.join("\n") };
}
var invaders = { id: "invaders", title: "Space Invaders", render: render2 };

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
var SCATTER_LENGTH = 50;
var CHASE_LENGTH = 110;
var GHOST_GAP = 2;
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
  if (food.length === 0) return /* @__PURE__ */ new Set();
  const sorted = [...food].sort((a, b) => b.level - a.level || a.x - b.x || a.y - b.y);
  const pool = sorted.slice(0, Math.max(POWER_PELLETS, sorted.filter((c) => c.level === sorted[0].level).length));
  const width = Math.max(...food.map((c) => c.x)) + 1;
  const first = [...pool].sort((a, b) => Math.abs(a.x - width * 0.2) - Math.abs(b.x - width * 0.2))[0];
  const chosen = [first];
  while (chosen.length < Math.min(POWER_PELLETS, pool.length)) {
    let best = null;
    let bestScore = -1;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      const score = Math.min(...chosen.map((o) => Math.abs(o.x - c.x) + Math.abs(o.y - c.y)));
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    chosen.push(best);
  }
  return new Set(chosen);
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
    const open = (o) => manhattan(o.x, o.y, pac.x, pac.y) >= GHOST_GAP && !crowded(g, o.x, o.y);
    let pool = options.filter((o) => o.dir !== reverse && open(o));
    if (pool.length === 0) pool = options.filter(open);
    if (pool.length === 0) {
      const far = Math.max(...options.map((o) => manhattan(o.x, o.y, pac.x, pac.y)));
      pool = options.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) === far);
      pool.sort((a, b) => score(b) - score(a));
    } else {
      pool.sort((a, b) => score(a) - score(b));
    }
    startMove(g, pool[0].dir, u2, GHOST_PERIOD);
  };
  const dangerous = (u2) => {
    const blocked = new Uint8Array(total);
    for (const g of ghosts) {
      if (g.mode !== "normal") continue;
      for (let dy = -GHOST_GAP + 1; dy <= GHOST_GAP - 1; dy++) {
        for (let dx = -GHOST_GAP + 1; dx <= GHOST_GAP - 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > GHOST_GAP - 1) continue;
          const x = g.x + dx;
          const y = g.y + dy;
          if (inside(x, y)) blocked[y * cols + x] = 1;
        }
      }
    }
    return blocked;
  };
  const search = (blocked, avoidPellets) => {
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
      for (const turn of [0, 1, 3, 2]) {
        const d = (heading[cur] + turn) % 4;
        const x = cx + DX[d];
        const y = cy + DY[d];
        if (!inside(x, y)) continue;
        const n = y * cols + x;
        if (dist[n] >= 0 || blocked[n]) continue;
        const cell = food.get(n);
        if (avoidPellets && cell && powerCells.has(cell)) continue;
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
    const nonPellets = [...food.values()].filter((c) => !powerCells.has(c)).length;
    const plain = search(blocked, nonPellets > 0);
    const hunted = frightened.map((g) => ({ g, d: manhattan(g.x, g.y, pac.x, pac.y) })).filter(({ d }) => d <= HUNT_RANGE && d * PAC_PERIOD + 4 < frightEnd - u2).sort((a, b) => a.d - b.d)[0];
    if (hunted) {
      const goal = hunted.g.y * cols + hunted.g.x;
      const route = search(blocked, true);
      if (route.dist[goal] > 0) return firstStep(route.parent, goal);
    }
    if (u2 >= frightEnd && nearestThreat <= 5 && chasing(u2)) {
      const open = search(blocked, false);
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
    const map = nonPellets > 0 ? plain : search(blocked, false);
    if (target >= 0 && food.has(target) && map.dist[target] > 0 && (nonPellets === 0 || !powerCells.has(food.get(target)))) {
      return firstStep(map.parent, target);
    }
    let best = -1;
    let bestCost = Infinity;
    for (const [id, c] of food) {
      if (map.dist[id] < 1) continue;
      if (nonPellets > 0 && powerCells.has(c)) continue;
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
      const cost = map.dist[id] + 0.45 * near;
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
      startMove(pac, dir, u, PAC_PERIOD);
      pacMoved = true;
      const id = pac.y * cols + pac.x;
      const cell = food.get(id);
      if (cell) {
        food.delete(id);
        const power = powerCells.has(cell);
        eats.push({ t: u + PAC_PERIOD, cell, power });
        lastEat = u;
        if (power) {
          chain = 0;
          frightEnd = u + PAC_PERIOD + FRIGHT_LENGTH;
          for (const g of ghosts) {
            if (g.mode === "eyes") continue;
            setMode(g, "fright", u + PAC_PERIOD);
            g.dir = (g.dir + 2) % 4;
          }
        }
        if (food.size === 0) end = u + PAC_PERIOD;
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
var GLYPHS3 = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  S: ["111", "100", "111", "001", "111"],
  C: ["111", "100", "100", "100", "111"],
  O: ["111", "101", "101", "101", "111"],
  R: ["110", "101", "110", "101", "101"],
  E: ["111", "100", "111", "100", "111"],
  A: ["010", "101", "111", "101", "101"],
  D: ["110", "101", "101", "101", "110"],
  Y: ["101", "101", "010", "010", "010"],
  "!": ["1", "1", "1", "0", "1"]
};
function pixelWidth(text, s) {
  return [...text].reduce((w, ch) => w + (GLYPHS3[ch][0].length + 1) * s, -s);
}
function pixelText2(text, x, y, s) {
  let d = "";
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS3[ch];
    glyph.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== "1") continue;
        let end = rx;
        while (end < row.length && row[end] === "1") end++;
        d += `M${fmt(cx + rx * s)} ${fmt(y + ry * s)}h${fmt((end - rx) * s)}v${fmt(s)}h${fmt(-(end - rx) * s)}z`;
        rx = end;
      }
    });
    cx += (glyph[0].length + 1) * s;
  }
  return d;
}
function isDark(theme) {
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
  const frames = [];
  if (merged.length === 0 || merged[0][0] > 0) frames.push([0, off]);
  for (const [a, b] of merged) {
    if (a > 0) frames.push([a, off]);
    frames.push([a, on], [b, on]);
    if (b < duration - 1e-6) frames.push([b, off]);
  }
  return frames;
}
function simplify(wps) {
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
function render3(ctx) {
  const { grid, theme } = ctx;
  const dark = isDark(theme);
  const margin = 22;
  const layout = makeLayout(grid, { left: margin, top: margin });
  const laneBottom = layout.top + (grid.height + LANE) * layout.pitch + layout.cell;
  const hudY = laneBottom + 8;
  const width = layout.left * 2 + layout.gridWidth;
  const height = hudY + 10 + 7;
  const sim = simulatePacman(grid, ctx.rng);
  const foodCount = activeCells(grid).length;
  const hasPlay = sim.end > 0;
  const rawDt = hasPlay ? (20 + foodCount * 0.12) / sim.end : 0.05;
  const play = hasPlay ? Math.round(sim.end * Math.min(0.07, Math.max(0.03, rawDt)) * 100) / 100 : 3;
  const unit = hasPlay ? play / sim.end : 0.05;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const cellTime = unit * PAC_PERIOD;
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
    const frames = simplify(wps).map((p) => [at(p.t), translate(...px(p.x, p.y))]);
    const last = wps[wps.length - 1];
    frames.push([jumpAt, translate(...px(last.x, last.y))], [jumpAt, translate(...px(wps[0].x, wps[0].y))]);
    return frames;
  };
  const flashA = "#2121ff";
  const flashB = dark ? "#ffffff" : "#bcd0ff";
  const flashStart = tEnd + 0.1;
  const flashFrames = [[0, `fill:${theme.empty}`]];
  if (hasPlay) {
    flashFrames.push([flashStart - 1e-3, `fill:${theme.empty}`]);
    for (let k = 0; k < 6; k++) {
      const t = flashStart + k * 0.17;
      flashFrames.push([t, `fill:${k % 2 === 0 ? flashA : flashB}`], [t + 0.17, `fill:${k % 2 === 0 ? flashA : flashB}`]);
    }
    flashFrames.push([flashStart + 6 * 0.17, `fill:${theme.empty}`]);
  }
  const floorClass = tl.track(flashFrames);
  const floor = [];
  const dots = [];
  const eatTime = /* @__PURE__ */ new Map();
  for (const e of sim.eats) eatTime.set(e.cell, { t: at(e.t), power: e.power });
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
          [eaten.t - 0.5 * cellTime, rest],
          [eaten.t + 0.1 * cellTime, "opacity:0;transform:scale(0)"],
          [restore, "opacity:0;transform:scale(0)"],
          [restore + PACE.restore, rest]
        ] : [[0, rest]]
      );
      if (eaten?.power) {
        const [ox, oy] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
        dots.push(
          `<g class="c ${cls}">${cellRect(layout, cell, fill)}<rect x="${fmt(ox - 1.5)}" y="${fmt(oy - 1.5)}" width="${layout.cell + 3}" height="${layout.cell + 3}" rx="${layout.radius + 1}" fill="none" stroke="${theme.ink}" stroke-width="1.2"><animate attributeName="opacity" values="1;.15;1" dur=".56s" repeatCount="indefinite"/></rect></g>`
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
    const turn = (pacHeadings[i][1] - pacHeadings[i - 1][1] + 4) % 4;
    const t = at(pacHeadings[i][0]);
    rotFrames.push([t - 0.3 * cellTime, `transform:rotate(${angle}deg)`]);
    angle += turn === 1 ? 90 : turn === 3 ? -90 : 180;
    rotFrames.push([t + 0.3 * cellTime, `transform:rotate(${angle}deg)`]);
  }
  const pacJump = Math.max(fadeEnd + 0.05, at(sim.pac[sim.pac.length - 1].t) + 0.02);
  rotFrames.push([pacJump, `transform:rotate(${angle}deg)`], [pacJump, `transform:rotate(${startAngle}deg)`]);
  const pacFade = tl.track(fadeFrames(restore, PACE.restore));
  const pacPos = tl.track(moveFrames(sim.pac, pacJump));
  const pacRot = tl.track(rotFrames);
  const open = pacPath(38);
  const pac = `<g class="${pacFade}"><g class="${pacPos}"><g class="${pacRot}"><path d="${open}" fill="${PAC_YELLOW}"${outline.replace(".8", ".9")}><animate attributeName="d" values="${open};${pacPath(3)};${open}" dur=".3s" repeatCount="indefinite"/></path></g></g></g>`;
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
      `<g class="${fade}"><g class="${pos}"${outline}><g class="${normalOp}"><use href="#gb" fill="${spec.color}"/></g><g class="${frightOp}"><use href="#gb" fill="${FRIGHT_BLUE}"/><use href="#gf" color="#ffb8ae"/></g><g class="${flashOp}"><use href="#gb" fill="#fff"/><use href="#gf" color="#f00"/></g><g class="${eyesOp}"><use href="#ge"/><g class="${lookClass}"><circle cx="-2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/><circle cx="2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/></g></g></g></g>`
    );
  });
  const popupColor = dark ? "#22e0ff" : "#0089a8";
  const popups = sim.ghostEats.map((e) => {
    const te = at(e.t);
    const [x, y] = px(e.x, e.y);
    const text = String(e.points);
    const cls = tl.track([
      [0, `opacity:0;${translate(x, y)}`],
      [te - 1e-3, `opacity:0;${translate(x, y)}`],
      [te, `opacity:1;${translate(x, y)}`],
      [te + 0.9, `opacity:1;${translate(x, y - 6)}`],
      [te + 0.92, `opacity:0;${translate(x, y - 6)}`]
    ]);
    return `<path class="${cls}" d="${pixelText2(text, -pixelWidth(text, 1.4) / 2, -3.5, 1.4)}" fill="${popupColor}"/>`;
  });
  const events = [[0, 0]];
  let score = 0;
  const scoring = [
    ...sim.eats.map((e) => ({ t: e.t, points: e.power ? 50 : 10 })),
    ...sim.ghostEats.map((e) => ({ t: e.t, points: e.points }))
  ].sort((a, b) => a.t - b.t);
  for (const s of scoring) {
    score += s.points;
    events.push([at(s.t), score]);
  }
  events.push([restore + 0.1, 0]);
  const digits = Math.max(4, String(score).length);
  const glyph = 2;
  const advance = (3 + 1) * glyph;
  const label = "SCORE";
  const digitsX = 6 + pixelWidth(label, glyph) + 2 * glyph + glyph;
  const digitIntervals = /* @__PURE__ */ new Map();
  for (let k = 0; k < events.length; k++) {
    const from = events[k][0];
    const to = k + 1 < events.length ? events[k + 1][0] : duration;
    String(events[k][1]).padStart(digits, "0").split("").forEach((d, p) => {
      const key = `${p}:${d}`;
      const list = digitIntervals.get(key) ?? [];
      const last = list[list.length - 1];
      if (last && last[1] >= from - 1e-6) last[1] = to;
      else list.push([from, to]);
      digitIntervals.set(key, list);
    });
  }
  const scoreMarkup = [`<path d="${pixelText2(label, 6, hudY, glyph)}" fill="${theme.muted}"/>`];
  for (const [key, intervals] of digitIntervals) {
    const [p, d] = key.split(":");
    const cls = tl.track(toggleFrames(intervals, duration));
    scoreMarkup.push(`<path class="${cls}" d="${pixelText2(d, digitsX + Number(p) * advance, hudY, glyph)}" fill="${theme.ink}"/>`);
  }
  const readyText = "READY!";
  const readyClass = tl.track([
    [0, "opacity:1"],
    [PACE.intro - 0.05, "opacity:1"],
    [PACE.intro + 0.15, "opacity:0"],
    [duration - 0.3, "opacity:0"],
    [duration, "opacity:1"]
  ]);
  const readyColor = dark ? PAC_YELLOW : "#c99a00";
  scoreMarkup.push(
    `<path class="${readyClass}" d="${pixelText2(readyText, (width - pixelWidth(readyText, glyph)) / 2, hudY, glyph)}" fill="${readyColor}"/>`
  );
  const defs = [
    `<path id="gb" d="${ghostPath(SKIRT_A)}"><animate attributeName="d" values="${ghostPath(SKIRT_A)};${ghostPath(SKIRT_B)}" calcMode="discrete" dur=".34s" repeatCount="indefinite"/></path>`,
    `<g id="gf"><circle cx="-2.4" cy="-2.2" r="1.15" fill="currentColor"/><circle cx="2.4" cy="-2.2" r="1.15" fill="currentColor"/><path d="M-4.7 3.4l1.57-1.6 1.57 1.6 1.56-1.6 1.57 1.6 1.57-1.6 1.56 1.6" fill="none" stroke="currentColor" stroke-width=".9"/></g>`,
    `<g id="ge"><ellipse cx="-2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/><ellipse cx="2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/></g>`
  ].join("");
  const css = `.c{transform-box:fill-box;transform-origin:center}
${tl.css()}`;
  const body = [
    `<g class="${floorClass}">${floor.join("")}</g>`,
    `<g>${dots.join("")}</g>`,
    ...ghostMarkup,
    pac,
    ...popups,
    ...scoreMarkup
  ].join("\n");
  return { width, height, css, defs, body };
}
var pacman = { id: "pacman", title: "Pac-Man", render: render3 };

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
      for (const turn of TURN_ORDER) {
        const d = (heading[cur] + turn) % 4;
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
  const extra = eats.length > 0 ? coda(playSteps) : 0;
  for (let i = 0; i < extra; i++) chaseTail();
  return { cols, rows, path, eats, playSteps, maxLength };
}
var BODY = 11;
var OUTLINE = 1.2;
var HEAD = 13;
var TAPER = [0.6, 0.72, 0.84, 0.93];
var POP = 0.22;
function snakeAngle(dir) {
  return dir * 90;
}
function stepSeconds(foodCount, steps) {
  const target = 20 + foodCount * 0.12;
  const raw = steps > 0 ? target / steps : 0.1;
  return Math.round(Math.min(0.14, Math.max(0.06, raw)) * 50) / 50;
}
function isDark2(theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
function mixColors(a, b) {
  const parse = (hex2) => [1, 3, 5].map((i) => parseInt(hex2.slice(i, i + 2), 16));
  const [ra, ga, ba] = parse(a);
  const [rb, gb, bb] = parse(b);
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex((ra + rb) / 2)}${hex((ga + gb) / 2)}${hex((ba + bb) / 2)}`;
}
function render4(ctx) {
  const { grid, theme } = ctx;
  const margin = 22;
  const layout = makeLayout(grid, { left: margin, top: margin });
  const width = layout.left * 2 + layout.gridWidth;
  const height = layout.top * 2 + layout.gridHeight;
  let s = 0.1;
  const sim = simulateSnake(grid, (playSteps) => {
    s = stepSeconds(activeCells(grid).length, playSteps);
    return Math.ceil((PACE.hold + PACE.restore) / s) + 2;
  });
  const hasPlay = sim.eats.length > 0;
  const play = hasPlay ? Math.round(sim.playSteps * s * 100) / 100 : 3;
  const duration = loopDuration(play);
  const tl = new Timeline(duration);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const jump = fadeEnd + 0.1;
  const at = (step) => PACE.intro + step * s;
  const px = (id) => {
    const [x, y] = cellCenter(layout, id % sim.cols - LANE2, Math.floor(id / sim.cols) - LANE2);
    return [x, y];
  };
  const dirs = [];
  for (let k = 1; k < sim.path.length; k++) {
    const a = sim.path[k - 1];
    const b = sim.path[k];
    const dx = b % sim.cols - a % sim.cols;
    const dy = Math.floor(b / sim.cols) - Math.floor(a / sim.cols);
    dirs.push(dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3);
  }
  const startPos = px(sim.path[0]);
  const headFrames = [[PACE.intro, translate(...startPos)]];
  const turnFrames = [];
  let angle = snakeAngle(dirs[0] ?? 0);
  const startAngle = angle;
  turnFrames.push([PACE.intro, `transform:rotate(${angle}deg)`]);
  for (let k = 1; k < sim.path.length; k++) {
    const last = k === sim.path.length - 1;
    const turn = last ? 0 : (dirs[k] - dirs[k - 1] + 4) % 4;
    if (last || turn !== 0) headFrames.push([at(k), translate(...px(sim.path[k]))]);
    if (turn !== 0) {
      turnFrames.push([at(k) - 0.3 * s, `transform:rotate(${angle}deg)`]);
      angle += turn === 1 ? 90 : -90;
      turnFrames.push([at(k) + 0.3 * s, `transform:rotate(${angle}deg)`]);
    }
  }
  const endPos = px(sim.path[sim.path.length - 1]);
  const jumpAt = Math.max(jump, at(sim.path.length - 1) + 0.02);
  headFrames.push([jumpAt, translate(...endPos)], [jumpAt, translate(...startPos)]);
  turnFrames.push([jumpAt, `transform:rotate(${angle}deg)`], [jumpAt, `transform:rotate(${startAngle}deg)`]);
  const headTrack = tl.keyframes(headFrames);
  const headPos = tl.useKeyframes(headTrack, 0);
  const headTurn = tl.track(turnFrames);
  const wiggleFrames = [];
  const wiggleStart = PACE.intro + play + 0.05;
  for (let k = 0; k < 8; k++) {
    wiggleFrames.push([wiggleStart + k * 0.13, `transform:rotate(${k % 2 === 0 ? -16 : 16}deg)`]);
  }
  wiggleFrames.push([wiggleStart + 8 * 0.13, "transform:rotate(0deg)"]);
  const headWiggle = tl.track(hasPlay ? [[0, "transform:rotate(0deg)"], ...wiggleFrames] : [[0, "transform:rotate(0deg)"]]);
  const blink = [[0, "opacity:1"]];
  if (hasPlay) {
    for (let k = 0; k < 3; k++) {
      const t = PACE.intro + play + 0.1 + k * 0.36;
      blink.push([t, "opacity:1"], [t + 0.12, "opacity:.3"], [t + 0.24, "opacity:1"]);
    }
  }
  blink.push([restore, "opacity:1"], [fadeEnd, "opacity:0"], [duration - 0.3, "opacity:0"], [duration, "opacity:1"]);
  const snakeFade = tl.track(blink);
  const growth = sim.eats.filter((e) => e.grew);
  const growTime = (m) => at(growth[m - 1].step);
  const taperShape = (j) => j < TAPER.length ? TAPER[j] : 1;
  const dark = isDark2(theme);
  const rim = dark ? theme.ink : "#000";
  const tube = [];
  const shadow = [];
  for (let i = growth.length; i >= 1; i--) {
    const frames = [[0, "opacity:0;transform:scale(.2)"]];
    for (let j = 0; j <= TAPER.length; j++) {
      const m = i + j;
      if (m > growth.length) break;
      const start = growTime(m);
      const next = m + 1 <= growth.length ? growTime(m + 1) : Infinity;
      const end = Math.min(start + POP, next);
      const from = j === 0 ? "opacity:0;transform:scale(.2)" : `opacity:1;transform:scale(${fmt(taperShape(j - 1))})`;
      const to = `opacity:1;transform:scale(${fmt(taperShape(j))})`;
      frames.push([start, from], [end, to]);
    }
    frames.push([fadeEnd, frames[frames.length - 1][1]], [fadeEnd + 0.01, "opacity:0"]);
    const look = tl.track(frames);
    const pos = tl.useKeyframes(headTrack, i * s);
    const bridge = tl.useKeyframes(headTrack, (i - 0.5) * s);
    const fill = levelColor(theme, growth[i - 1].cell);
    const joint = i === 1 ? fill : mixColors(levelColor(theme, growth[i - 2].cell), fill);
    const piece = (cls, size, color) => `<g class="${cls}"><rect class="${look}" x="${fmt(-size / 2)}" y="${fmt(-size / 2)}" width="${size}" height="${size}" rx="${fmt(size * 0.3)}" fill="${color}"/></g>`;
    tube.push(piece(pos, BODY, fill), piece(bridge, BODY, joint));
    shadow.push(piece(pos, BODY + 2 * OUTLINE, rim), piece(bridge, BODY + 2 * OUTLINE, rim));
  }
  const baseCells = [];
  const foodCells = [];
  const eatTime = /* @__PURE__ */ new Map();
  for (const e of sim.eats) eatTime.set(e.cell, at(e.step));
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
      const rest = `fill:${fill};opacity:1;transform:scale(1)`;
      const cls = tl.track([
        [0, rest],
        [te - 0.6 * s, rest],
        [te - 0.1 * s, `fill:${theme.accent};opacity:1;transform:scale(1.25)`],
        [te + 0.5 * s, `fill:${theme.accent};opacity:0;transform:scale(1.9)`],
        [restore, `fill:${fill};opacity:0;transform:scale(1)`],
        [restore + PACE.restore, rest]
      ]);
      foodCells.push(cellRect(layout, cell, fill, `class="c ${cls}"`));
    }
  }
  const head = `<g class="${headPos}"><g class="${headTurn}"><g class="${headWiggle}">
<rect x="${-HEAD / 2}" y="${-HEAD / 2}" width="${HEAD}" height="${HEAD}" rx="4" fill="${theme.accent}" stroke="${theme.ink}" stroke-opacity=".3" stroke-width=".8"/>
<circle cx="2.4" cy="-3" r="2.1" fill="#fff"/><circle cx="2.4" cy="3" r="2.1" fill="#fff"/>
<circle cx="3.1" cy="-3" r="1.05" fill="#111"/><circle cx="3.1" cy="3" r="1.05" fill="#111"/>
<path d="M6.5 0H10.5M10.5 0l2.2-1.7M10.5 0l2.2 1.7" stroke="#e5484d" stroke-width="1.1" stroke-linecap="round" fill="none" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.55;.6;.8;.85" dur="1.4s" repeatCount="indefinite"/></path>
</g></g></g>`;
  const css = `.c{transform-box:fill-box;transform-origin:center}
${tl.css()}`;
  const bodyMarkup = [
    `<g>${baseCells.join("")}</g>`,
    `<g>${foodCells.join("")}</g>`,
    `<g class="${snakeFade}"><g opacity="${dark ? 0.5 : 0.6}">${shadow.join("")}</g>${tube.join("")}${head}</g>`
  ].join("\n");
  return { width, height, css, body: bodyMarkup };
}
var snake = { id: "snake", title: "Snake", render: render4 };

// src/games/index.ts
var GAMES = {
  snake,
  pacman,
  breakout,
  invaders,
  asteroids
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
    accent: "#f5b53d"
  },
  "github-light": {
    name: "github-light",
    background: null,
    empty: "#eff2f5",
    levels: ["#aceebb", "#4ac26b", "#2da44e", "#116329"],
    ink: "#1f2328",
    muted: "#59636e",
    accent: "#bf8700"
  },
  neon: {
    name: "neon",
    background: "#0b0614",
    empty: "#1a1029",
    levels: ["#3b1d6e", "#6a2fd0", "#b14dff", "#ff4df0"],
    ink: "#f4ecff",
    muted: "#8c7aa8",
    accent: "#23f0ff"
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
var COLOR_KEYS = ["background", "empty", "ink", "muted", "accent"];
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
  const levels = params.get("levels");
  if (levels) {
    const list = levels.split(",").map((s) => s.trim());
    if (list.length !== 4) throw new Error(`levels needs exactly 4 colours, got ${list.length}`);
    overrides.levels = list;
  }
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
