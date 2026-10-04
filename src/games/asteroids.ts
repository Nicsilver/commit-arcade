import { fmt, Timeline, type Frame } from "../anim.ts";
import { loopDuration, PACE, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { activeCells, type Cell, type Grid } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { createRng, type Rng } from "../rng.ts";
import { cellCenter, cellRect, levelColor, type Layout } from "../svg.ts";

const CLEARANCE = 8;
const NOSE = 11;
const BULLET_SPEED = 800;
const SAUCER_SPEED = 300;
const SAUCER_LANE = 186;
const MAX_PLAY = 80;
const THRUST_EASE = "cubic-bezier(.5,0,.2,1)";
const TURN_EASE = "cubic-bezier(.4,0,.2,1)";
const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** How long final fragments drift before they have faded out. */
const DEBRIS_LIFE = 0.85;
const ROCK_RADIUS = 6.5;
/** Debris and rocks stay inside this box (inset from the canvas, below the score bar). */
const BOUNDS = { left: 6, right: 6, top: 28, bottom: 8 };
/** Busy days that split count for three shots, so cap the total on big graphs. */
const SHOT_BUDGET = 1.25;

interface Pt {
  x: number;
  y: number;
}

interface Pose {
  t: number;
  x: number;
  y: number;
  /** Radians, unwrapped so interpolation always turns the short way. */
  a: number;
  /** Easing of the segment that starts at this pose. */
  ease: string;
}

interface Bullet {
  t0: number;
  t1: number;
  from: Pt;
  to: Pt;
}

export interface Hit {
  cell: Cell;
  t: number;
  /** Where the bullet strikes the cell's edge. */
  point: Pt;
  /** Direction of the bullet, radians. */
  dir: number;
  /** A busy day breaks into two medium rocks instead of shattering at once. */
  split: boolean;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A medium rock: it drifts, bounces softly off the box and waits to be shot again. */
export interface Rock {
  cell: Cell;
  /** Contributions credited when this rock is shot. */
  share: number;
  /** Spawn time, and when its shot lands (Infinity until it is shot). */
  t0: number;
  t1: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Degrees, and degrees per second. */
  phi: number;
  spin: number;
  radii: number[];
  /** Earliest time the ship goes after it, so the drift is seen. */
  ripe: number;
  box: Box;
}

export interface RockHit {
  rock: Rock;
  t: number;
  point: Pt;
  dir: number;
}

export interface SaucerPlan {
  /** Position keyframes in play time. */
  path: { t: number; x: number; y: number }[];
  tIn: number;
  tOut: number;
}

export interface AsteroidsPlay {
  layout: Layout;
  width: number;
  height: number;
  poses: Pose[];
  burns: [number, number][];
  bullets: Bullet[];
  hits: Hit[];
  rocks: Rock[];
  rockHits: RockHit[];
  /** One entry per share of a day's contributions, in the order the score should count them. */
  clears: ClearEvent[];
  saucer: SaucerPlan | null;
  /** Seconds until the last rock has shattered and its fragments have faded. */
  play: number;
}

function wrapDelta(d: number): number {
  const twoPi = Math.PI * 2;
  return ((((d + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

function fold(v: number, lo: number, hi: number): number {
  const span = hi - lo;
  let u = (v - lo) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u > span ? 2 * span - u : u);
}

export function rockAt(rock: Rock, t: number): Pt {
  const dt = Math.max(0, t - rock.t0);
  return {
    x: fold(rock.x + rock.vx * dt, rock.box.x0, rock.box.x1),
    y: fold(rock.y + rock.vy * dt, rock.box.y0, rock.box.y1),
  };
}

/** Times at which a rock turns around at the edge of its box, between spawn and `until`. */
function rockBounces(rock: Rock, until: number): number[] {
  const out: number[] = [];
  for (const [p, v, lo, hi] of [
    [rock.x, rock.vx, rock.box.x0, rock.box.x1],
    [rock.y, rock.vy, rock.box.y0, rock.box.y1],
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

/** Entry parameter of the ray/segment `a + t*d` into a box, for t in [0, tMax], or null. */
function slab(a: Pt, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number, tMax: number): number | null {
  let lo = 0;
  let hi = tMax;
  for (const [o, d, min, max] of [
    [a.x, dx, x0, x1],
    [a.y, dy, y0, y1],
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

function nearSegment(a: Pt, b: Pt, p: Pt, r: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y) < r;
}

class Field {
  readonly grid: Grid;
  readonly layout: Layout;
  readonly alive: boolean[][];

  constructor(grid: Grid, layout: Layout) {
    this.grid = grid;
    this.layout = layout;
    this.alive = grid.cells.map((col) => col.map((c) => c !== null && c.level > 0));
  }

  free(i: number, j: number): boolean {
    return i < 0 || j < 0 || i >= this.grid.width || j >= this.grid.height || !this.alive[i][j];
  }

  node(i: number, j: number): Pt {
    const [x, y] = cellCenter(this.layout, i, j);
    return { x, y };
  }

  /** First live cell along the ray, walking the cell grid so each cast stays cheap. */
  cast(o: Pt, dx: number, dy: number): { cell: Cell; dist: number } | null {
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
      [v0, dv, H],
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
        if (t !== null) return { cell: this.grid.cells[i][j]!, dist: t };
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
  blocked(a: Pt, b: Pt): boolean {
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
}

interface Candidate {
  cell: Cell;
  rock: Rock | null;
  dist: number;
  angle: number;
  delta: number;
  cost: number;
}

export function planAsteroids(grid: Grid, layout: Layout, size: { width: number; height: number }, seed: number, tempo: number): AsteroidsPlay {
  const rng = createRng(seed);
  const field = new Field(grid, layout);
  const cells = activeCells(grid);
  const total = cells.length;
  const W = grid.width;
  const H = grid.height;
  const NJ = H + 2;
  const { width, height } = size;
  const center: Pt = { x: layout.left + layout.gridWidth / 2, y: layout.top + layout.gridHeight / 2 };
  const box = rockBox(width, height);

  const gap = 0.17 / tempo;
  const aimSpeed = 10 * tempo;
  const turnSpeed = 7 * tempo;

  const splitting = chooseSplits(cells, rng);

  const poses: Pose[] = [];
  const burns: [number, number][] = [];
  const bullets: Bullet[] = [];
  const hits: Hit[] = [];
  const rocks: Rock[] = [];
  const rockHits: RockHit[] = [];
  const clears: ClearEvent[] = [];
  const inFlight: Hit[] = [];
  const reserved = new Set<Cell>();
  let saucer: SaucerPlan | null = null;
  let lastEvent = 0;

  const id = (i: number, j: number) => (i + 1) * NJ + (j + 1);

  const dijkstra = (si: number, sj: number) => {
    const n = (W + 2) * NJ;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[id(si, sj)] = 0;
    for (;;) {
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
      const uj = (u % NJ) - 1;
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

  const pathTo = (prev: Int32Array, i: number, j: number): Pt[] => {
    const pts: Pt[] = [];
    for (let k = id(i, j); k >= 0; k = prev[k]) {
      pts.push(field.node(Math.floor(k / NJ) - 1, (k % NJ) - 1));
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
  const looseRocks = (now: number) => rocks.filter((r) => r.t1 === Infinity && r.t0 <= now);

  const visibleFrom = (p: Pt, now: number): number => {
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

  // Standing spot: roomy, central, and connected to the open ring so the ship
  // can always leave it.
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

  const segment = (t0: number, t1: number, x: number, y: number, a: number, ease: string) => {
    const last = poses[poses.length - 1];
    if (last.t < t0 - 1e-9) poses.push({ ...last, t: t0, ease: "linear" });
    poses[poses.length - 1].ease = ease;
    poses.push({ t: t1, x, y, a, ease: "linear" });
  };

  const spawnRocks = (h: Hit) => {
    const [cx, cy] = cellCenter(layout, h.cell.x, h.cell.y);
    const third = Math.floor(h.cell.count / 3);
    [-1, 1].forEach((side, k) => {
      // Heading back toward the shooter keeps the rock in the line of fire
      // instead of sliding out of sight behind the days around it.
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
        box,
      });
    });
  };

  const land = (now: number) => {
    for (let k = inFlight.length - 1; k >= 0; k--) {
      const h = inFlight[k];
      if (h.t <= now) {
        field.alive[h.cell.x][h.cell.y] = false;
        if (h.split) spawnRocks(h);
        inFlight.splice(k, 1);
      }
    }
  };

  const flyPath = (points: Pt[], target: { i: number; j: number }) => {
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const delta = wrapDelta(Math.atan2(b.y - a.y, b.x - a.x) - angle);
      if (Math.abs(delta) > 0.02) {
        const dur = Math.max(0.12, Math.abs(delta) / turnSpeed);
        angle += delta;
        segment(t, t + dur, a.x, a.y, angle, TURN_EASE);
        t += dur;
      }
      const dur = (0.28 + Math.hypot(b.x - a.x, b.y - a.y) / 360) / tempo;
      segment(t, t + dur, b.x, b.y, angle, THRUST_EASE);
      burns.push([t, t + dur * 0.42]);
      t += dur;
    }
    pos = points[points.length - 1];
    node = target;
  };

  const flyTo = (i: number, j: number): boolean => {
    const { dist, prev } = dijkstra(node.i, node.j);
    if (!Number.isFinite(dist[id(i, j)]) || (i === node.i && j === node.j)) return false;
    flyPath(pathTo(prev, i, j), { i, j });
    return true;
  };

  const relocate = (): boolean => {
    const { dist } = dijkstra(node.i, node.j);
    const options: { i: number; j: number }[] = [];
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
      const score = visibleFrom(field.node(o.i, o.j), t) - dist[id(o.i, o.j)] * 0.008 + rng() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return flyTo(best.i, best.j);
  };

  /**
   * Turns the ship and fires one bullet over `dist` pixels; returns when and where it lands.
   * The ship keeps its place, so the time spent turning is part of the cost of the shot.
   */
  const fire = (aim: number, dist: number) => {
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

  const rockClear = (aim: number, dist: number): boolean => {
    const h = field.cast(pos, Math.cos(aim), Math.sin(aim));
    return !h || h.dist > dist - 0.5;
  };

  /** Aim at where the rock will be when the bullet gets there, trying the middle and then each flank. */
  const leadRock = (rock: Rock) => {
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

  const pickShot = (lastSign: number): Candidate | null => {
    let best: Candidate | null = null;
    const loose = looseRocks(t).map((r) => ({ r, p: rockAt(r, t + 0.25) }));
    for (const c of liveCells()) {
      const [cx, cy] = cellCenter(layout, c.x, c.y);
      const len = Math.hypot(cx - pos.x, cy - pos.y);
      const hit = field.cast(pos, (cx - pos.x) / len, (cy - pos.y) / len);
      if (!hit || reserved.has(hit.cell)) continue;
      const aim = Math.atan2(cy - pos.y, cx - pos.x);
      const end = { x: pos.x + Math.cos(aim) * hit.dist, y: pos.y + Math.sin(aim) * hit.dist };
      if (loose.some(({ p }) => nearSegment(pos, end, p, ROCK_RADIUS + 1))) continue;
      const delta = wrapDelta(aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign ? 0.12 : 0;
      const cost = Math.abs(delta) + reversal + hit.dist * 0.0004;
      if (!best || cost < best.cost) best = { cell: hit.cell, rock: null, dist: hit.dist, angle: aim, delta, cost };
    }
    for (const { r } of loose) {
      if (r.ripe > t) continue;
      const lead = leadRock(r);
      if (!lead) continue;
      const delta = wrapDelta(lead.aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign ? 0.12 : 0;
      // Ripe rocks beat fresh targets so they are not left drifting about.
      const cost = Math.abs(delta) + reversal + lead.dist * 0.0004 - 1.2;
      if (!best || cost < best.cost) best = { cell: r.cell, rock: r, dist: lead.dist, angle: lead.aim, delta, cost };
    }
    if (!best || best.rock) return best;
    // A little scatter so the stream of shots doesn't look machined.
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
    const picks: { i: number; d: number }[] = [];
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
    const wobble = (u: number) => SAUCER_LANE + 2.6 * Math.sin(u * 2.9);
    const sampleAt = (u: number): Pt => ({ x: x0 + dir * SAUCER_SPEED * u, y: wobble(u) });
    const aimAt = (p: Pt) => {
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
    // The first bullet is aimed behind the saucer and flies on until it runs out of range.
    const reach = 260;
    segment(t, fire1, spot.x, spot.y, angle + wrapDelta(first.a - angle), TURN_EASE);
    angle += wrapDelta(first.a - angle);
    bullets.push({
      t0: fire1,
      t1: fire1 + reach / BULLET_SPEED,
      from: first.m,
      to: { x: first.m.x + Math.cos(first.a) * reach, y: first.m.y + Math.sin(first.a) * reach },
    });
    segment(fire1, fire2, spot.x, spot.y, angle + wrapDelta(second.a - angle), "linear");
    angle += wrapDelta(second.a - angle);
    bullets.push({ t0: fire2, t1: tOut, from: second.m, to: hitPt });
    t = fire2;

    const path: SaucerPlan["path"] = [];
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
    if (!shot.rock && (spotShots >= limit || (spotShots >= 2 && Math.abs(shot.delta) > 1.4))) {
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
      const h: Hit = { cell: shot.cell, t: shotAt.t, point: shotAt.point, dir: shotAt.dir, split };
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
    play: Math.max(end + DEBRIS_LIFE, 2.4),
  };
}

function rockBox(width: number, height: number): Box {
  return { x0: BOUNDS.left + 4, x1: width - BOUNDS.right - 4, y0: BOUNDS.top + 6, y1: height - BOUNDS.bottom - 4 };
}

/** Busy days that will split; on big graphs only as many as the play-length budget allows. */
function chooseSplits(cells: Cell[], rng: Rng): Set<Cell> {
  const eligible = cells.filter((c) => c.level >= 3 && c.count >= 3);
  const room = Math.max(0, Math.floor((cells.length * (SHOT_BUDGET - 1) + 20) / 2));
  const order = eligible.map((c) => ({ c, k: c.level + rng() * 1.5 })).sort((a, b) => b.k - a.k);
  return new Set(order.slice(0, room).map((o) => o.c));
}

export function playAsteroids(ctx: GameContext): AsteroidsPlay {
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

const f1 = (n: number) => String(Math.round(n * 10) / 10);

interface PoolEvent {
  /** Slots are shared only between events with the same key. */
  key: string;
  from: number;
  to: number;
  /** Builds the element, given the class that plays its track. */
  make: (cls: string) => string;
  /** The look at the start of the event first and, last, the invisible look it ends in. */
  frames: Frame[];
}

/**
 * Plays one-shot events on a few shared elements instead of one each: an element that waits
 * invisibly for its moment still costs style work on every frame, and a play has hundreds of
 * shots, sparks and shards. Events that don't overlap take turns on the same element, which holds
 * the look the last one ended in until the next one starts.
 */
function playPooled(tl: Timeline, events: PoolEvent[]): string[] {
  const hold = ";animation-timing-function:step-end";
  const slots: { key: string; free: number; frames: Frame[]; make: PoolEvent["make"] }[] = [];
  for (const ev of [...events].sort((a, b) => a.from - b.from)) {
    const frames = ev.frames.map((f, i): Frame => (i === ev.frames.length - 1 ? [f[0], f[1] + hold] : f));
    let slot = slots.find((s) => s.key === ev.key && s.free <= ev.from);
    if (!slot) {
      slot = { key: ev.key, free: 0, frames: [[0, frames[frames.length - 1][1]]], make: ev.make };
      slots.push(slot);
    }
    slot.frames.push(...frames);
    slot.free = ev.to;
  }
  return slots.map((s) => s.make(tl.track(s.frames)));
}

const SHARD_TEMPLATES = 4;

const SLOTS = 16;
const DRIFT_DISTS = [27, 16, 9];

export function debrisBox(width: number, height: number): Box {
  return { x0: BOUNDS.left + 4, x1: width - BOUNDS.right - 4, y0: BOUNDS.top + 4, y1: height - BOUNDS.bottom - 2 };
}

/**
 * Picks the direction slot and travel distance for a fragment starting at (x, y) so that
 * it ends inside the box. A fragment headed for the edge is turned back in.
 */
export function driftPlan(x: number, y: number, vx: number, vy: number, b: Box): { slot: number; dist: number } {
  const inside = (px: number, py: number) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;
  const slotOf = (dx: number, dy: number) => ((Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * SLOTS) % SLOTS) + SLOTS) % SLOTS;
  let dx = vx;
  let dy = vy;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slot = slotOf(dx, dy);
    const a = (slot / SLOTS) * Math.PI * 2;
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

/** A cell cracked into 2-4 jagged pieces that share their cut lines, each described around its own centroid. */
function shatter(rng: Rng, size: number, count: number) {
  const half = size / 2;
  const c: Pt = { x: (rng() - 0.5) * 3, y: (rng() - 0.5) * 3 };
  const base = rng() * Math.PI * 2;
  const step = (Math.PI * 2) / count;
  const cuts = Array.from({ length: count }, (_, k) => {
    const a = base + k * step + (rng() - 0.5) * 0.6 * step;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const sx = dx === 0 ? Infinity : ((dx > 0 ? half : -half) - c.x) / dx;
    const sy = dy === 0 ? Infinity : ((dy > 0 ? half : -half) - c.y) / dy;
    const s = Math.min(sx, sy);
    const edge: Pt = { x: c.x + dx * s, y: c.y + dy * s };
    const mid: Pt = {
      x: (c.x + edge.x) / 2 - dy * (rng() - 0.5) * 3.2,
      y: (c.y + edge.y) / 2 + dx * (rng() - 0.5) * 3.2,
    };
    return { a: ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), edge, mid };
  }).sort((p, q) => p.a - q.a);

  const corners = [
    { x: half, y: half },
    { x: -half, y: half },
    { x: -half, y: -half },
    { x: half, y: -half },
  ].map((p) => ({ p, a: (Math.atan2(p.y - c.y, p.x - c.x) + Math.PI * 2) % (Math.PI * 2) }));

  return cuts.map((cut, k) => {
    const next = cuts[(k + 1) % count];
    const span = (next.a - cut.a + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    const rim: Pt[] = [cut.edge];
    corners
      .map((q) => ({ p: q.p, off: (q.a - cut.a + Math.PI * 2) % (Math.PI * 2) }))
      .filter((q) => q.off > 1e-6 && q.off < span - 1e-6)
      .sort((p, q) => p.off - q.off)
      .forEach((q) => rim.push(q.p));
    rim.push(next.edge);
    const chipped: Pt[] = [];
    rim.forEach((p, i) => {
      chipped.push(p);
      const n = rim[i + 1];
      if (!n) return;
      const inset = 0.5 + rng() * 1.1;
      const mx = (p.x + n.x) / 2;
      const my = (p.y + n.y) / 2;
      const len = Math.hypot(c.x - mx, c.y - my) || 1;
      chipped.push({ x: mx + ((c.x - mx) / len) * inset, y: my + ((c.y - my) / len) * inset });
    });
    const pts = [c, cut.mid, ...chipped, next.mid];
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return {
      cx: mx,
      cy: my,
      points: pts.map((p) => `${f1(p.x - mx)},${f1(p.y - my)}`).join(" "),
    };
  });
}

/** The corners of a rock after it has turned `deg` degrees, as points around its centre. */
function rockCorners(rock: Rock, deg: number): Pt[] {
  return rock.radii.map((r, k) => {
    const a = (k * Math.PI) / 4 + ((rock.phi + deg) * Math.PI) / 180;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

/** A broken rock as three wedges, each described around its own centroid. */
function rockWedges(rock: Rock, deg: number) {
  const corners = rockCorners(rock, deg);
  return [
    [0, 1, 2],
    [2, 3, 4, 5],
    [5, 6, 7, 0],
  ].map((idx) => {
    const pts = [{ x: 0, y: 0 }, ...idx.map((k) => corners[k])];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { cx, cy, points: pts.map((p) => `${f1(p.x - cx)},${f1(p.y - cy)}`).join(" ") };
  });
}

function renderAsteroids(ctx: GameContext, play: AsteroidsPlay): GameOutput {
  const { theme, grid } = ctx;
  const { layout } = play;
  const rng = createRng(`${play.hits.length}:${play.play}`);
  const D = loopDuration(play.play);
  const tl = new Timeline(D, "a");
  const L = (s: number) => PACE.intro + s;
  const restore = restoreAt(play.play);
  const ink = theme.ink;
  const accent = theme.accent;
  const eps = 0.001;
  const body: string[] = [];
  const defs: string[] = [glowDefs(theme)];
  const dbox = debrisBox(play.width, play.height);

  const driftFrames = (angle: number, dist: number, spin: number): Frame[] => {
    const out: Frame[] = [];
    for (const s of [0, 0.12, 0.3, 0.55, 1]) {
      const e = 1 - (1 - s) * (1 - s);
      const op = s < 0.4 ? 1 : 1 - (s - 0.4) / 0.6;
      out.push([
        s * DEBRIS_LIFE,
        `transform:translate(${fmt(Math.cos(angle) * dist * e)}px,${fmt(Math.sin(angle) * dist * e)}px) rotate(${fmt(spin * e)}deg);opacity:${fmt(op)}`,
      ]);
    }
    return out;
  };
  const drifts = new Map<string, string>();
  const driftClass = (x: number, y: number, vx: number, vy: number, at: number): string => {
    const { slot, dist } = driftPlan(x, y, vx, vy, dbox);
    const variant = Math.floor(rng() * 4);
    const key = `${slot}:${dist}:${variant}`;
    let name = drifts.get(key);
    if (!name) {
      const spin = (variant & 1 ? -1 : 1) * (variant & 2 ? 300 : 190);
      name = tl.keyframes(driftFrames((slot / SLOTS) * Math.PI * 2, dist, spin));
      drifts.set(key, name);
    }
    return tl.useKeyframes(name, L(at));
  };

  const implode = tl.keyframes([
    [0, "transform:scale(2.4);opacity:0;animation-timing-function:ease-in"],
    [0.2, "transform:scale(1.7);opacity:.9"],
    [0.5, "transform:scale(.25);opacity:0"],
  ]);
  const explode = tl.keyframes([
    [0, "transform:scale(.25);opacity:.9;animation-timing-function:ease-out"],
    [0.4, "transform:scale(2.4);opacity:0"],
  ]);

  const rays = (count: number, near: number, far: (k: number) => number, turn: number) =>
    Array.from({ length: count }, (_, k) => {
      const a = (k / count) * Math.PI * 2 + turn;
      const r = far(k);
      return `M${f1(Math.cos(a) * near)} ${f1(Math.sin(a) * near)}L${f1(Math.cos(a) * r)} ${f1(Math.sin(a) * r)}`;
    }).join("");
  defs.push(`<path id="sp" d="${rays(8, 3, (k) => (k % 2 ? 6 : 8.5), 0.2)}" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>`);
  defs.push(`<path id="se" d="${rays(8, 2.5, () => 5.5, 0.2 + Math.PI / 8)}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`);
  defs.push(`<g id="bl"><circle r="4.2" fill="${ink}" opacity=".3"/><circle r="2.2" fill="${ink}"/></g>`);
  defs.push(`<path id="sh" d="M11.2 0L-8.4 -7L-4.8 0L-8.4 7Z"/>`);
  defs.push(`<path id="ufo" d="M-12 2L-5.5 -2.2H5.5L12 2ZM-12 2L-5.5 5.6H5.5L12 2ZM-4.4 -2.2L-2.4 -6H2.4L4.4 -2.2"/>`);

  const level = (cell: Cell) => levelColor(theme, cell);
  for (const hit of play.hits) {
    const c = hit.cell;
    const at = L(hit.t);
    const frames: Frame[] = [
      [0, `fill:${level(c)}`],
      [at, `fill:${level(c)}`],
      [at + eps, `fill:${ink}`],
      [at + 0.07, `fill:${ink}`],
      [at + 0.07 + eps, `fill:${theme.empty}`],
      [restore, `fill:${theme.empty}`],
      [restore + PACE.restore, `fill:${level(c)}`],
    ];
    body.push(cellRect(layout, c, level(c), `class="${tl.track(frames)}"`));
  }
  // Level-0 cells and the partial week stay as plain squares.
  const rest: string[] = [];
  for (const col of grid.cells) {
    for (const c of col) {
      if (c && c.level === 0) rest.push(cellRect(layout, c, theme.empty));
    }
  }
  body.unshift(...rest);

  const sparkEvents: PoolEvent[] = [];
  const spark = (x: number, y: number, scale: number, at: number, color: string) => {
    const t = L(at);
    const look = (k: number, opacity: number, ease = "") =>
      `opacity:${opacity};transform:translate(${f1(x)}px,${f1(y)}px) scale(${fmt(scale * k)})${ease ? `;animation-timing-function:${ease}` : ""}`;
    sparkEvents.push(
      {
        key: `burst:${color}`,
        from: t,
        to: t + 0.3,
        make: (cls) => `<g class="${cls}"><use href="#sp"/><use href="#se" color="${color}"/></g>`,
        frames: [[t, look(0.35, 1, "ease-out")], [t + 0.3, look(1.9, 0)]],
      },
      {
        key: "flash",
        from: t,
        to: t + 0.16,
        make: (cls) => `<circle r="3.4" class="fl ${cls}"/>`,
        frames: [[t, look(0.5, 1, "ease-out")], [t + 0.16, look(1.6, 0)]],
      },
    );
  };

  // A handful of cracked-cell layouts reused with random turns and flips: the pieces still tile the
  // cell, and each distinct piece shape can then share one element across all the shots.
  const shardRng = createRng("asteroids-shards");
  const shardTemplates = new Map<number, ReturnType<typeof shatter>[]>();
  const templatesFor = (count: number) => {
    let list = shardTemplates.get(count);
    if (!list) {
      list = Array.from({ length: SHARD_TEMPLATES }, () => shatter(shardRng, layout.cell, count));
      shardTemplates.set(count, list);
    }
    return list;
  };
  const shardEvents: PoolEvent[] = [];
  const shard = (key: string, points: string, x: number, y: number, angle: number, dist: number, spin: number, turns: number, flip: number, fill: string, at: number) => {
    const bx = Math.round(x * 10) / 10;
    const by = Math.round(y * 10) / 10;
    const mirror = flip < 0 ? " scale(-1,1)" : "";
    const frames: Frame[] = [0, 0.12, 0.3, 0.55, 1].map((s) => {
      const e = 1 - (1 - s) * (1 - s);
      const op = s < 0.4 ? 1 : 1 - (s - 0.4) / 0.6;
      const keep = s === 0 || s === 1 ? `;fill:${fill}` : "";
      return [
        L(at) + s * DEBRIS_LIFE,
        `opacity:${fmt(op)}${keep};transform:translate(${f1(bx + Math.cos(angle) * dist * e)}px,${f1(by + Math.sin(angle) * dist * e)}px) rotate(${f1(turns * 90 + spin * e)}deg)${mirror}`,
      ];
    });
    shardEvents.push({
      key,
      from: L(at),
      to: L(at) + DEBRIS_LIFE,
      make: (cls) => `<polygon class="rd ${cls}" points="${points}"/>`,
      frames,
    });
  };

  const debris: string[] = [];
  const rocksOut: string[] = [];
  for (const hit of play.hits) {
    const c = hit.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    if (!hit.split) {
      const count = c.level >= 4 ? 4 : c.level === 3 ? 3 : 2 + Math.floor(rng() * 2);
      const ti = Math.floor(rng() * SHARD_TEMPLATES);
      const turns = Math.floor(rng() * 4);
      const flip = rng() < 0.5 ? -1 : 1;
      templatesFor(count)[ti].forEach((piece, pi) => {
        const fx = flip * piece.cx;
        const [px, py] = [[fx, piece.cy], [-piece.cy, fx], [-fx, -piece.cy], [piece.cy, -fx]][turns];
        const outward = Math.atan2(py, px);
        const x = cx + px;
        const y = cy + py;
        const { slot, dist } = driftPlan(x, y, Math.cos(outward) * 0.7 + Math.cos(hit.dir) * 0.9, Math.sin(outward) * 0.7 + Math.sin(hit.dir) * 0.9, dbox);
        const variant = Math.floor(rng() * 4);
        const spin = (variant & 1 ? -1 : 1) * (variant & 2 ? 300 : 190);
        shard(`${count}.${ti}.${pi}`, piece.points, x, y, (slot / SLOTS) * Math.PI * 2, dist, spin, turns, flip, spriteColor(theme, c), hit.t);
      });
    }
    spark(hit.point.x, hit.point.y, hit.split ? 1.25 : 1, hit.t, theme.sprites[3]);
  }

  const hitOf = new Map(play.rockHits.map((h) => [h.rock, h]));
  for (const r of play.rocks) {
    const h = hitOf.get(r)!;
    const life = r.t1 - r.t0;
    const pose = (t: number, scale: number, opacity: number): string => {
      const p = rockAt(r, t);
      return `opacity:${opacity};transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) scale(${scale}) rotate(${fmt(r.spin * (t - r.t0))}deg)`;
    };
    const grow = Math.min(0.14, life);
    const frames: Frame[] = [
      [0, pose(r.t0, 0.5, 0)],
      [L(r.t0), pose(r.t0, 0.5, 0)],
      [L(r.t0) + eps, pose(r.t0, 0.5, 1)],
      [L(r.t0 + grow), pose(r.t0 + grow, 1, 1)],
      ...rockBounces(r, r.t1)
        .filter((b) => b > r.t0 + grow)
        .map((b): Frame => [L(b), pose(b, 1, 1)]),
      [L(r.t1), pose(r.t1, 1, 1)],
      [L(r.t1) + eps, pose(r.t1, 1, 0)],
    ];
    const points = rockCorners(r, 0).map((p) => `${f1(p.x)},${f1(p.y)}`).join(" ");
    rocksOut.push(`<polygon class="rock ${tl.track(frames)}" fill="${spriteColor(theme, r.cell)}" points="${points}"/>`);

    const end = rockAt(r, r.t1);
    spark(h.point.x, h.point.y, 1.1, r.t1, theme.sprites[3]);
    const heading = Math.atan2(r.vy, r.vx);
    for (const w of rockWedges(r, r.spin * life)) {
      const x = end.x + w.cx;
      const y = end.y + w.cy;
      const outward = Math.atan2(w.cy, w.cx);
      const vx = Math.cos(outward) + Math.cos(heading) * 0.5;
      const vy = Math.sin(outward) + Math.sin(heading) * 0.5;
      debris.push(
        `<g transform="translate(${f1(x)} ${f1(y)})"><polygon class="rock ${driftClass(x, y, vx, vy, r.t1)}" fill="${spriteColor(theme, r.cell)}" points="${w.points}"/></g>`,
      );
    }
  }
  debris.unshift(...playPooled(tl, shardEvents));
  const sparks = playPooled(tl, sparkEvents);

  const bulletEvents: PoolEvent[] = play.bullets.map((b) => {
    const from = `transform:translate(${fmt(b.from.x)}px,${fmt(b.from.y)}px)`;
    const to = `transform:translate(${fmt(b.to.x)}px,${fmt(b.to.y)}px)`;
    return {
      key: "bullet",
      from: L(b.t0),
      to: L(b.t1) + eps,
      make: (cls) => `<use href="#bl" class="${cls}"/>`,
      frames: [
        [L(b.t0), `opacity:0;${from}`],
        [L(b.t0) + eps, `opacity:1;${from}`],
        [L(b.t1), `opacity:1;${to}`],
        [L(b.t1) + eps, `opacity:0;${to}`],
      ],
    };
  });
  const bulletsOut = playPooled(tl, bulletEvents);

  let saucerOut = "";
  const ringAt = (p: Pt, kf: string, t: number, r = 15) =>
    `<g transform="translate(${f1(p.x)} ${f1(p.y)})"><circle r="${r}" class="ring ${tl.useKeyframes(kf, t)}"/></g>`;
  const rings: string[] = [];
  if (play.saucer) {
    const s = play.saucer;
    const pos = (p: { x: number; y: number }) => `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px)`;
    const first = s.path[0];
    const last = s.path[s.path.length - 1];
    const frames: Frame[] = [
      [0, `opacity:0;${pos(first)}`],
      [L(s.tIn), `opacity:0;${pos(first)}`],
      [L(s.tIn) + eps, `opacity:1;${pos(first)}`],
      ...s.path.map((p): Frame => [L(p.t), `opacity:1;${pos(p)}`]),
      [L(s.tOut) + eps, `opacity:0;${pos(last)}`],
    ];
    const cls = tl.track(frames);
    saucerOut += `<g class="${cls}"><use href="#ufo" class="halo"/><use href="#ufo" class="line"/></g>`;
    saucerOut += spark(last.x, last.y, 1.7, s.tOut, accent);
    rings.push(ringAt(last, explode, L(s.tOut), 9));
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.3 + rng() * 0.4;
      const len = 3.5 + rng() * 3;
      const x = last.x + Math.cos(a) * 3;
      const y = last.y + Math.sin(a) * 3;
      const cls2 = driftClass(x, y, Math.cos(a), Math.sin(a), s.tOut);
      saucerOut += `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1((a * 180) / Math.PI)})"><path class="${k % 2 ? "burn" : "line"} ${cls2}" d="M${f1(-len)} 0H${f1(len)}"/></g>`;
    }
  }

  const poseCss = (p: Pose, ease?: string) =>
    `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) rotate(${fmt((p.a * 180) / Math.PI)}deg)${ease ? `;animation-timing-function:${ease}` : ""}`;
  const poseFrames: Frame[] = play.poses.map((p) => [L(p.t), poseCss(p, p.ease)]);
  const first = play.poses[0];
  const last = play.poses[play.poses.length - 1];
  const warpIn = 0.2;
  const bannerFrom = L(play.play) + 0.05;
  const bannerTo = restore - 0.3;
  const outAt = restore - 0.25;
  poseFrames.push([outAt + 0.38, poseCss(last)], [outAt + 0.381, poseCss(first)]);
  const move = tl.track(poseFrames);

  const flame: Frame[] = [[0, "opacity:0"]];
  for (const [a, b] of play.burns) {
    flame.push([L(a), "opacity:0"], [L(a) + 0.03, "opacity:1"], [L(b), "opacity:1"], [L(b) + 0.05, "opacity:0"]);
  }
  const flameCls = tl.track(flame);

  const shim = (t: number, op: number, sx: number, sy: number): Frame => [t, `opacity:${op};transform:scale(${sx},${sy})`];
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
    shim(outAt + 0.34, 0, 3, 0.05),
  ]);

  rings.push(ringAt(first, implode, warpIn), ringAt(last, explode, outAt + 0.04));

  const ship =
    `<g class="${move}"><g class="${shimmer}">` +
    `<g transform="translate(-4.6 0)"><g class="flick"><path class="burn" opacity=".75" d="M0 -2.4L-5.5 0L0 2.4"/></g></g>` +
    `<g class="${flameCls}"><g transform="translate(-4.6 0)"><g class="flick"><path class="burn" d="M0 -3.4L-10 0L0 3.4"/><path class="burn" d="M0 -1.4L-5.5 0L0 1.4"/></g></g></g>` +
    `<use href="#sh" class="halo"/><use href="#sh" class="hull"/></g></g>`;

  const text = banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: layout.left + layout.gridWidth / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: bannerFrom,
    to: bannerTo,
  });

  const score = hud(tl, grid, {
    theme,
    title: "ASTEROIDS",
    clears: play.clears.map((e) => ({ t: L(e.t), cell: e.cell })),
    resetAt: restore,
    width: play.width,
  });

  const glow = glowAttr(theme);
  const css = [
    tl.css(),
    `.rd{fill-opacity:.55;stroke:${ink};stroke-width:1;stroke-linejoin:round;stroke-opacity:.9}`,
    `.rock{fill-opacity:.5;stroke:${ink};stroke-width:1.3;stroke-linejoin:round}`,
    `.fl{fill:${ink};opacity:0}`,
    `.halo{fill:none;stroke:${ink};stroke-width:4.4;stroke-opacity:.28;stroke-linejoin:round;stroke-linecap:round}`,
    `.hull{fill:${ink};fill-opacity:.22;stroke:${ink};stroke-width:1.7;stroke-linejoin:round}`,
    `.line{fill:none;stroke:${ink};stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}`,
    `.burn{fill:none;stroke:${accent};stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}`,
    `.ring{fill:none;stroke:${ink};stroke-width:1.2;opacity:0}`,
    `.flick{animation:flick .16s steps(1) infinite}`,
    `@keyframes flick{0%{transform:scale(1,1)}33%{transform:scale(.6,.75)}66%{transform:scale(1.25,1.1)}}`,
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
      // One glow group: each filtered group blurs the whole canvas area on every frame.
      `<g${glow}>${rocksOut.join("")}${sparks.join("")}${bulletsOut.join("")}${saucerOut}${rings.join("")}${ship}</g>`,
      text,
    ].join(""),
  };
}

export const asteroids: Game = {
  id: "asteroids",
  title: "Asteroids",
  render(ctx) {
    return renderAsteroids(ctx, playAsteroids(ctx));
  },
};
