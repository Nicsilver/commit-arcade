import { fmt, Timeline, type Frame } from "../anim.ts";
import { loopDuration, PACE, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { activeCells, type Cell, type Grid } from "../grid.ts";
import { createRng, type Rng } from "../rng.ts";
import { cellCenter, cellRect, levelColor, makeLayout, type Layout } from "../svg.ts";

// Open space around the graph: the ship needs somewhere to stand on a fully
// dense graph, and the saucer flies in the taller top margin.
const MARGIN = { left: 26, top: 36, right: 26, bottom: 26 };
const CLEARANCE = 6.5;
const NOSE = 8;
const BULLET_SPEED = 800;
const SAUCER_SPEED = 300;
const SAUCER_LANE = 10;
const MAX_PLAY = 80;
const THRUST_EASE = "cubic-bezier(.5,0,.2,1)";
const TURN_EASE = "cubic-bezier(.4,0,.2,1)";
const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

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
  saucer: SaucerPlan | null;
  /** Seconds from the first shot until the last rock has shattered, plus a beat. */
  play: number;
}

function wrapDelta(d: number): number {
  const twoPi = Math.PI * 2;
  return ((((d + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
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
  dist: number;
  angle: number;
  delta: number;
  cost: number;
}

export function planAsteroids(grid: Grid, layout: Layout, seed: number, tempo: number): AsteroidsPlay {
  const rng = createRng(seed);
  const field = new Field(grid, layout);
  const cells = activeCells(grid);
  const total = cells.length;
  const W = grid.width;
  const H = grid.height;
  const NJ = H + 2;
  const width = layout.left + layout.gridWidth + MARGIN.right;
  const height = layout.top + layout.gridHeight + MARGIN.bottom;
  const center: Pt = { x: layout.left + layout.gridWidth / 2, y: layout.top + layout.gridHeight / 2 };

  const gap = 0.17 / tempo;
  const aimSpeed = 10 * tempo;
  const turnSpeed = 7 * tempo;

  const poses: Pose[] = [];
  const burns: [number, number][] = [];
  const bullets: Bullet[] = [];
  const hits: Hit[] = [];
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

  const visibleFrom = (p: Pt): number => {
    let n = 0;
    for (const c of liveCells()) {
      const [cx, cy] = cellCenter(layout, c.x, c.y);
      const len = Math.hypot(cx - p.x, cy - p.y);
      const h = field.cast(p, (cx - p.x) / len, (cy - p.y) / len);
      if (h && h.cell === c) n++;
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

  const land = (now: number) => {
    for (let k = inFlight.length - 1; k >= 0; k--) {
      const h = inFlight[k];
      if (h.t <= now) {
        field.alive[h.cell.x][h.cell.y] = false;
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
      const score = visibleFrom(field.node(o.i, o.j)) - dist[id(o.i, o.j)] * 0.008 + rng() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return flyTo(best.i, best.j);
  };

  const shoot = (aim: number, hit: { cell: Cell; dist: number }): Hit => {
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
    const h: Hit = { cell: hit.cell, t: t + flight, point: to, dir: aim };
    hits.push(h);
    inFlight.push(h);
    reserved.add(hit.cell);
    return h;
  };

  const pickShot = (lastSign: number): Candidate | null => {
    let best: Candidate | null = null;
    for (const c of liveCells()) {
      const [cx, cy] = cellCenter(layout, c.x, c.y);
      const len = Math.hypot(cx - pos.x, cy - pos.y);
      const hit = field.cast(pos, (cx - pos.x) / len, (cy - pos.y) / len);
      if (!hit || reserved.has(hit.cell)) continue;
      const aim = Math.atan2(cy - pos.y, cx - pos.x);
      const delta = wrapDelta(aim - angle);
      const reversal = Math.abs(delta) > 0.05 && Math.sign(delta) !== lastSign ? 0.12 : 0;
      const cost = Math.abs(delta) + reversal + hit.dist * 0.0004;
      if (!best || cost < best.cost) best = { cell: hit.cell, dist: hit.dist, angle: aim, delta, cost };
    }
    if (!best) return null;
    // A little scatter so the stream of shots doesn't look machined.
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
    const picks: { i: number; d: number }[] = [];
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
    const reach = (first.m.y + 8) / -Math.sin(first.a);
    segment(t, fire1, spot.x, spot.y, angle + wrapDelta(first.a - angle), TURN_EASE);
    angle += wrapDelta(first.a - angle);
    bullets.push({
      t0: fire1,
      t1: fire1 + reach / BULLET_SPEED,
      from: first.m,
      to: { x: first.m.x + Math.cos(first.a) * reach, y: -8 },
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
    if (spotShots >= limit || (spotShots >= 2 && Math.abs(shot.delta) > 1.4)) {
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
    play: Math.max(end + 0.25, 2.4),
  };
}

export function playAsteroids(ctx: GameContext): AsteroidsPlay {
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

// 5x7 pixel capitals for the closing banner.
const GLYPHS: Record<string, string[]> = {
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
};

function glyphPath(rows: string[], px: number): string {
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

const f1 = (n: number) => String(Math.round(n * 10) / 10);

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
  const defs: string[] = [];

  const driftTime = 1.35;
  const driftFrames = (angle: number, dist: number, spin: number): Frame[] => {
    const out: Frame[] = [];
    for (const s of [0, 0.12, 0.3, 0.55, 1]) {
      const e = 1 - (1 - s) * (1 - s);
      const op = s < 0.4 ? 1 : 1 - (s - 0.4) / 0.6;
      out.push([
        s * driftTime,
        `transform:translate(${fmt(Math.cos(angle) * dist * e)}px,${fmt(Math.sin(angle) * dist * e)}px) rotate(${fmt(spin * e)}deg);opacity:${fmt(op)}`,
      ]);
    }
    return out;
  };
  const SLOTS = 16;
  const drift: string[] = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    for (const dist of [15, 27]) {
      for (const spin of [1, -1]) {
        drift.push(tl.keyframes(driftFrames((slot / SLOTS) * Math.PI * 2, dist, spin * (170 + rng() * 150))));
      }
    }
  }
  const burst = tl.keyframes([
    [0, "transform:scale(.35);opacity:1;animation-timing-function:ease-out"],
    [0.3, "transform:scale(1.9);opacity:0"],
  ]);
  const implode = tl.keyframes([
    [0, "transform:scale(2.4);opacity:0;animation-timing-function:ease-in"],
    [0.2, "transform:scale(1.7);opacity:.9"],
    [0.5, "transform:scale(.25);opacity:0"],
  ]);
  const explode = tl.keyframes([
    [0, "transform:scale(.25);opacity:.9;animation-timing-function:ease-out"],
    [0.4, "transform:scale(2.4);opacity:0"],
  ]);

  const rays = Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    return `M${f1(Math.cos(a) * 3)} ${f1(Math.sin(a) * 3)}L${f1(Math.cos(a) * (k % 2 ? 5.5 : 7.5))} ${f1(Math.sin(a) * (k % 2 ? 5.5 : 7.5))}`;
  }).join("");
  defs.push(`<path id="sp" d="${rays}" fill="none" stroke="${accent}" stroke-width="1.2" stroke-linecap="round"/>`);
  defs.push(
    `<g id="bl"><circle r="3.4" fill="${ink}" opacity=".28"/><circle r="1.7" fill="${ink}"/></g>`,
  );
  defs.push(`<path id="sh" d="M8 0L-6 -5L-3.4 0L-6 5Z"/>`);
  defs.push(`<path id="ufo" d="M-10 1.5L-4.5 -1.8H4.5L10 1.5ZM-10 1.5L-4.5 4.6H4.5L10 1.5ZM-3.6 -1.8L-2 -5H2L3.6 -1.8"/>`);

  const level = (cell: Cell) => levelColor(theme, cell);
  for (const hit of play.hits) {
    const c = hit.cell;
    const frames: Frame[] = [
      [0, `fill:${level(c)}`],
      [L(hit.t), `fill:${level(c)}`],
      [L(hit.t) + eps, `fill:${theme.empty}`],
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

  const debris: string[] = [];
  const sparks: string[] = [];
  const bulletsOut: string[] = [];
  for (const hit of play.hits) {
    const c = hit.cell;
    const [cx, cy] = cellCenter(layout, c.x, c.y);
    const count = c.level >= 4 ? 4 : c.level === 3 ? 3 : 2 + Math.floor(rng() * 2);
    for (const piece of shatter(rng, layout.cell, count)) {
      const outward = Math.atan2(piece.cy, piece.cx);
      const vx = Math.cos(outward) * 0.7 + Math.cos(hit.dir) * 0.9;
      const vy = Math.sin(outward) * 0.7 + Math.sin(hit.dir) * 0.9;
      const slot = (Math.round((Math.atan2(vy, vx) / (Math.PI * 2)) * SLOTS) + SLOTS * 2) % SLOTS;
      const variant = slot * 4 + (rng() < 0.5 ? 0 : 2) + (rng() < 0.5 ? 0 : 1);
      const cls = tl.useKeyframes(drift[variant], L(hit.t));
      debris.push(
        `<g transform="translate(${f1(cx + piece.cx)} ${f1(cy + piece.cy)})"><polygon class="r${c.level} ${cls}" points="${piece.points}"/></g>`,
      );
    }
    sparks.push(
      `<g transform="translate(${f1(hit.point.x)} ${f1(hit.point.y)})"><use href="#sp" class="${tl.useKeyframes(burst, L(hit.t))}"/></g>`,
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
      [L(b.t1) + eps, `opacity:0;${to}`],
    ]);
    bulletsOut.push(`<use href="#bl" class="${cls}"/>`);
  }

  let saucerOut = "";
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
    saucerOut += `<g class="${cls}"><use href="#ufo" class="glow"/><use href="#ufo" class="line"/></g>`;
    const at = `translate(${f1(last.x)} ${f1(last.y)})`;
    saucerOut += `<g transform="${at} scale(1.35)"><use href="#sp" class="${tl.useKeyframes(burst, L(s.tOut))}"/></g>`;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3 + rng() * 0.4;
      const len = 3 + rng() * 3;
      const slot = (Math.round((a / (Math.PI * 2)) * SLOTS) + SLOTS) % SLOTS;
      const cls2 = tl.useKeyframes(drift[slot * 4 + 2 + (k % 2)], L(s.tOut));
      saucerOut += `<g transform="${at} rotate(${f1((a * 180) / Math.PI)})"><path class="line ${cls2}" d="M${f1(-len)} 0H${f1(len)}"/></g>`;
    }
  }

  const poseFrames: Frame[] = play.poses.map((p) => [
    L(p.t),
    `transform:translate(${fmt(p.x)}px,${fmt(p.y)}px) rotate(${fmt((p.a * 180) / Math.PI)}deg);animation-timing-function:${p.ease}`,
  ]);
  const first = play.poses[0];
  const last = play.poses[play.poses.length - 1];
  const warpIn = 0.2;
  const spinAt = L(play.play) + 0.05;
  const spinEnd = spinAt + 0.85;
  const outAt = restore - 0.4;
  poseFrames.push(
    [spinAt, `transform:translate(${fmt(last.x)}px,${fmt(last.y)}px) rotate(${fmt((last.a * 180) / Math.PI)}deg);animation-timing-function:cubic-bezier(.3,.6,.3,1)`],
    [spinEnd, `transform:translate(${fmt(last.x)}px,${fmt(last.y)}px) rotate(${fmt((last.a * 180) / Math.PI + 720)}deg)`],
  );
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

  const ringAt = (p: Pt | Pose, kf: string, t: number) =>
    `<g transform="translate(${f1(p.x)} ${f1(p.y)})"><circle r="12" class="ring ${tl.useKeyframes(kf, t)}"/></g>`;
  const rings = ringAt(first, implode, warpIn) + ringAt(last, explode, outAt + 0.04);

  const ship =
    `<g class="${move}"><g class="${shimmer}">` +
    `<g class="${flameCls}"><g transform="translate(-3.4 0)"><g class="flick"><path class="burn" d="M0 -2.4L-7 0L0 2.4"/><path class="burn" d="M0 -1L-3.6 0L0 1"/></g></g></g>` +
    `<use href="#sh" class="glow"/><use href="#sh" class="line"/></g></g>`;

  const px = 4;
  const word = "GAME CLEAR";
  const advance = (ch: string) => (ch === " " ? 3 * px : 6 * px);
  const wordWidth = [...word].reduce((s, ch) => s + advance(ch), 0) - px;
  const tx = layout.left + layout.gridWidth / 2 - wordWidth / 2;
  const ty = layout.top + layout.gridHeight / 2 - (7 * px) / 2;
  for (const ch of Object.keys(GLYPHS)) defs.push(`<path id="g${ch}" d="${glyphPath(GLYPHS[ch], px)}"/>`);
  let text = "";
  let cursor = tx;
  let n = 0;
  for (const ch of word) {
    if (ch !== " ") {
      const cls = tl.visible(L(play.play) + 0.2 + n * 0.055, restore + 0.1, 0.001);
      text +=
        `<g class="${cls}"><use href="#g${ch}" x="${f1(cursor + 2)}" y="${f1(ty + 2)}" fill="${accent}"/>` +
        `<use href="#g${ch}" x="${f1(cursor)}" y="${f1(ty)}" fill="${ink}"/></g>`;
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
    `@keyframes flick{0%{transform:scale(1,1)}33%{transform:scale(.6,.75)}66%{transform:scale(1.25,1.1)}}`,
  ].join("\n");

  return {
    width: play.width,
    height: play.height,
    css,
    defs: defs.join(""),
    body: [...body, ...debris, ...sparks, ...bulletsOut, saucerOut, rings, ship, text].join(""),
  };
}

export const asteroids: Game = {
  id: "asteroids",
  title: "Asteroids",
  render(ctx) {
    return renderAsteroids(ctx, playAsteroids(ctx));
  },
};
