import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { Bursts } from "../fx.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid } from "../grid.ts";
import { arcadeLayout, banner, hud, spriteColor, stageClearLines } from "../kit.ts";
import type { ClearEvent } from "../kit.ts";
import { cellCenter, cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const ARENA_TOP = -1;
const ARENA_BOTTOM = 9;
/** Cells of trail a cycle keeps behind it before the tail starts to fade. */
const TRAIL = 40;
const FINALE_STEP = 0.058;
const FILL_STEP_MIN = 0.07;
const FILL_STEP_MAX = 0.16;
const CRASH_AFTER = 0.9;
const LAP_AFTER = 1.7;
/** Lowest row a crash may happen in, so the blast stays inside the canvas. */
const CRASH_ROW = 8;

interface Arena {
  c0: number;
  c1: number;
  cols: number;
  rows: number;
}

export interface Cycle {
  /** Lattice cells in driving order; index 0 is where the cycle starts. */
  cells: number[];
  /** Seconds after the start of play at which the cycle's centre reaches each cell. */
  head: number[];
  /** Index of the last day this cycle derezzes. */
  lastDay: number;
  /** Seconds after play starts at which each cell's trail starts to fade, infinite while it stays. */
  tail: number[];
}

export interface TronSim {
  arena: Arena;
  cycles: [Cycle, Cycle];
  derez: { t: number; cell: Cell; by: 0 | 1 }[];
  /** Where and when the rival hits a trail; the point sits between two cells. */
  crash: { t: number; x: number; y: number };
  /** When the last day is gone. */
  harvestEnd: number;
  /** When the stage is clear: the victory lap has had its run. */
  end: number;
}

const idOf = (a: Arena, col: number, row: number) => (col - a.c0) * a.rows + (row - ARENA_TOP);
const colOf = (a: Arena, id: number) => Math.floor(id / a.rows) + a.c0;
const rowOf = (a: Arena, id: number) => (id % a.rows) + ARENA_TOP;

function neighbour(a: Arena, id: number, dir: number): number {
  const col = colOf(a, id) + DX[dir];
  const row = rowOf(a, id) + DY[dir];
  if (col < a.c0 || col > a.c1 || row < ARENA_TOP || row > ARENA_BOTTOM) return -1;
  return idOf(a, col, row);
}

function directionOf(a: Arena, from: number, to: number): number {
  const dx = colOf(a, to) - colOf(a, from);
  const dy = rowOf(a, to) - rowOf(a, from);
  return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
}

interface Route {
  cells: number[];
  last: number;
}

/** A serpentine over the rows of one half that hold days, starting and turning in the margin lanes. */
function harvest(a: Arena, side: 0 | 1, lo: number, hi: number, active: Map<number, Cell>, width: number): Route {
  const startCol = side === 0 ? -1 : width;
  const rows: number[] = [];
  for (let r = 0; r < 7; r++) {
    for (let c = lo; c <= hi; c++) {
      if (active.has(idOf(a, c, r))) {
        rows.push(r);
        break;
      }
    }
  }
  if (rows.length === 0) return { cells: [idOf(a, startCol, 3)], last: 0 };
  const cells: number[] = [];
  let col = startCol;
  let row = rows[0];
  cells.push(idOf(a, col, row));
  let right = side === 0;
  rows.forEach((_, i) => {
    const end = right ? (side === 0 ? hi : width) : side === 0 ? -1 : lo;
    while (col !== end) {
      col += col < end ? 1 : -1;
      cells.push(idOf(a, col, row));
    }
    if (i + 1 < rows.length) {
      while (row !== rows[i + 1]) {
        row++;
        cells.push(idOf(a, col, row));
      }
    }
    right = !right;
  });
  let last = 0;
  cells.forEach((c, i) => {
    if (active.has(c)) last = i;
  });
  return { cells: cells.slice(0, last + 1), last };
}

/**
 * A long, mostly straight path through free cells, used for the filler laps
 * and the victory lap. Straight on is always tried first.
 */
function wander(a: Arena, start: number, dir: number, steps: number, blocked: Set<number>): number[] {
  const path: number[] = [];
  const used = new Set<number>([start]);
  const stack: { cell: number; dir: number; options: number[]; next: number }[] = [];
  const run = (cell: number, d: number) => {
    let n = 0;
    let c = cell;
    while (n < 14) {
      c = neighbour(a, c, d);
      if (c < 0 || blocked.has(c) || used.has(c)) break;
      n++;
    }
    return n;
  };
  const optionsFor = (cell: number, d: number) => {
    const turns = [(d + 1) % 4, (d + 3) % 4]
      .filter((nd) => run(cell, nd) > 0)
      .sort((p, q) => run(cell, q) - run(cell, p));
    return [...(run(cell, d) > 0 ? [d] : []), ...turns];
  };
  stack.push({ cell: start, dir, options: optionsFor(start, dir), next: 0 });
  let best: number[] = [];
  let budget = 150_000;
  while (stack.length && budget-- > 0) {
    const top = stack[stack.length - 1];
    if (path.length > best.length) best = path.slice();
    if (path.length >= steps) break;
    if (top.next >= top.options.length) {
      stack.pop();
      const gone = path.pop();
      if (gone !== undefined) used.delete(gone);
      continue;
    }
    const d = top.options[top.next++];
    const to = neighbour(a, top.cell, d);
    path.push(to);
    used.add(to);
    stack.push({ cell: to, dir: d, options: optionsFor(to, d), next: 0 });
  }
  return path.length >= best.length ? path : best;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function stepTimes(count: number, segments: { to: number; dt: number }[]): number[] {
  const t = [0];
  let seg = 0;
  for (let i = 1; i < count; i++) {
    while (seg + 1 < segments.length && i > segments[seg].to) seg++;
    t.push(t[i - 1] + segments[seg].dt);
  }
  return t;
}

function tailTimes(head: number[], trail: number): number[] {
  return head.map((_, i) => (i + trail < head.length ? head[i + trail] : Infinity));
}

/**
 * Plans the whole game: two cycles split the graph between them, each
 * sweeping its half row by row, then the rival rides into the player's wall
 * while the player takes a victory lap. No cycle ever enters a cell that any
 * trail has used, so nothing crashes before the finale.
 */
export function simulateTron(grid: Grid): TronSim {
  const width = grid.width;
  const arena: Arena = { c0: -1, c1: width, cols: width + 2, rows: ARENA_BOTTOM - ARENA_TOP + 1 };
  const active = new Map<number, Cell>();
  for (const c of activeCells(grid)) active.set(idOf(arena, c.x, c.y), c);

  let bestSplit = { m: Math.floor(width / 2) - 1, cost: Infinity, diff: Infinity };
  let routes: [Route, Route] | null = null;
  for (let m = -1; m < width; m++) {
    const p = harvest(arena, 0, 0, m, active, width);
    const r = harvest(arena, 1, m + 1, width - 1, active, width);
    const cost = Math.max(p.last, r.last);
    const diff = Math.abs(p.last - r.last);
    if (cost < bestSplit.cost || (cost === bestSplit.cost && diff < bestSplit.diff)) {
      bestSplit = { m, cost, diff };
      routes = [p, r];
    }
  }
  const [routeP, routeR] = routes!;
  const longest = Math.max(routeP.last, routeR.last, 1);
  const harvestSpan = clamp(longest * 0.115, 7, 34);
  const dts = [routeP, routeR].map((r) => clamp(harvestSpan / Math.max(r.last, 1), FILL_STEP_MIN, FILL_STEP_MAX));

  const planned = new Set<number>([...routeP.cells, ...routeR.cells]);
  const cells: number[][] = [routeP.cells.slice(), routeR.cells.slice()];
  const dirs = [0, 2];
  const lasts = [routeP.last, routeR.last];
  const harvestEnd = Math.max(routeP.last * dts[0], routeR.last * dts[1]);
  const filler = [0, 0];
  for (const k of [0, 1] as const) {
    const gap = harvestEnd - lasts[k] * dts[k];
    const steps = Math.round(gap / dts[k]);
    const cs = cells[k];
    const d = cs.length > 1 ? directionOf(arena, cs[cs.length - 2], cs[cs.length - 1]) : dirs[k];
    dirs[k] = d;
    if (steps > 0) {
      const extra = wander(arena, cs[cs.length - 1], d, steps, planned);
      for (const c of extra) {
        cs.push(c);
        planned.add(c);
      }
      filler[k] = extra.length;
      if (extra.length) dirs[k] = directionOf(arena, cs[cs.length - 2], cs[cs.length - 1]);
    }
  }

  // The player's lap first, so the rival can aim at a wall that is really there.
  const lapSteps = 150;
  const lap = wander(arena, cells[0][cells[0].length - 1], dirs[0], lapSteps, planned);
  const playerCells = cells[0].concat(lap);
  const paced = (k: number, count: number) =>
    stepTimes(count, [
      { to: lasts[k] + filler[k], dt: dts[k] },
      { to: Infinity, dt: FINALE_STEP },
    ]);
  const playerHead = paced(0, playerCells.length);
  const playerTail = tailTimes(playerHead, TRAIL);
  const playerIndex = new Map<number, number>();
  playerCells.forEach((c, i) => playerIndex.set(c, i));

  const rivalStart = cells[1][cells[1].length - 1];
  const rivalClock = paced(1, cells[1].length)[cells[1].length - 1];
  const blocked = new Set<number>([...playerCells, ...cells[1]]);
  const minSteps = Math.ceil(CRASH_AFTER / FINALE_STEP);
  const maxSteps = 70;

  const wallAt = (cell: number, time: number) => {
    const j = playerIndex.get(cell);
    if (j === undefined) return false;
    return playerHead[j] + 0.05 <= time && time <= playerTail[j] - 0.2;
  };

  interface Found {
    path: number[];
    hit: number;
  }
  // Iterative deepening finds the shortest detour that still ends in a wall of the player's trail.
  const search = (limit: number): Found | null => {
    const path = [rivalStart];
    const on = new Set<number>(path);
    let budget = 60_000;
    const walk = (cell: number, d: number, depth: number): Found | null => {
      if (budget-- <= 0) return null;
      const ahead = neighbour(arena, cell, d);
      const time = rivalClock + (depth + 0.5) * FINALE_STEP;
      if (depth >= minSteps && ahead >= 0 && rowOf(arena, ahead) <= CRASH_ROW && wallAt(ahead, time)) return { path: path.slice(), hit: ahead };
      if (depth >= limit) return null;
      for (const turn of [0, 1, 3]) {
        const nd = (d + turn) % 4;
        const to = neighbour(arena, cell, nd);
        if (to < 0 || blocked.has(to) || on.has(to)) continue;
        path.push(to);
        on.add(to);
        const hit = walk(to, nd, depth + 1);
        path.pop();
        on.delete(to);
        if (hit) return hit;
      }
      return null;
    };
    return walk(rivalStart, dirs[1], 0);
  };
  let finaleR: Found | null = null;
  for (let limit = minSteps; limit <= maxSteps && !finaleR; limit += 2) finaleR = search(limit);
  if (!finaleR) {
    // Nowhere to make a real crash: ride straight on until something stops the cycle.
    let c = rivalStart;
    const path = [c];
    for (;;) {
      const n = neighbour(arena, c, dirs[1]);
      if (n < 0 || blocked.has(n) || path.length > 16) break;
      path.push(n);
      c = n;
    }
    finaleR = { path, hit: neighbour(arena, c, dirs[1]) };
  }
  const rivalExtra = finaleR.path.slice(1);
  const rivalCells = cells[1].concat(rivalExtra);
  const rivalHead = paced(1, rivalCells.length);
  const crashTime = rivalHead[rivalHead.length - 1] + FINALE_STEP * 0.5;
  const last = rivalCells[rivalCells.length - 1];
  const crashDir = rivalCells.length > 1 ? directionOf(arena, rivalCells[rivalCells.length - 2], last) : dirs[1];
  const crash = {
    t: crashTime,
    x: colOf(arena, last) + DX[crashDir] * 0.5,
    y: rowOf(arena, last) + DY[crashDir] * 0.5,
  };
  const end = crashTime + LAP_AFTER;
  const need = (t: number, head: number[]) => {
    let n = head.length;
    while (n > 1 && head[n - 2] >= t) n--;
    return n;
  };
  const playerKeep = need(end + PACE.hold + 0.15, playerHead);
  const playerFinal = playerCells.slice(0, playerKeep);
  const playerHeadFinal = playerHead.slice(0, playerKeep);

  const rivalTailNormal = tailTimes(rivalHead, TRAIL);
  const firstAlive = rivalTailNormal.findIndex((t) => t > crashTime);
  const j0 = firstAlive < 0 ? rivalCells.length : firstAlive;
  const rivalTail = rivalTailNormal.map((t, i) => Math.min(t, crashTime + 0.15 + Math.max(0, i - j0) * 0.012));

  const player: Cycle = { cells: playerFinal, head: playerHeadFinal, lastDay: lasts[0], tail: tailTimes(playerHeadFinal, TRAIL) };
  const rival: Cycle = { cells: rivalCells, head: rivalHead, lastDay: lasts[1], tail: rivalTail };

  const derez: TronSim["derez"] = [];
  [player, rival].forEach((cy, by) => {
    cy.cells.forEach((c, i) => {
      const cell = active.get(c);
      if (cell && i <= cy.lastDay) derez.push({ t: cy.head[Math.max(0, i - 1)], cell, by: by as 0 | 1 });
    });
  });
  derez.sort((p, q) => p.t - q.t);
  return { arena, cycles: [player, rival], derez, crash, harvestEnd, end };
}

interface Palette {
  player: string;
  rival: string;
  grid: string;
  gridOpacity: number;
  border: string;
  glowStrength: number;
}

function isDark(theme: Theme): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

function mix(a: string, b: string, k: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

function paletteFor(theme: Theme): Palette {
  if (theme.name === "neon") {
    return { player: "#23f0ff", rival: "#ff9a1f", grid: "#5b34a8", gridOpacity: 0.55, border: "#23f0ff", glowStrength: 1 };
  }
  if (isDark(theme)) {
    return { player: "#2fd8ff", rival: "#ff8a2b", grid: "#2b6a9c", gridOpacity: 0.4, border: "#2fd8ff", glowStrength: 1 };
  }
  return { player: "#0969da", rival: "#e5580c", grid: "#cfd6de", gridOpacity: 0.8, border: "#0969da", glowStrength: 0 };
}

const TRAIL_WIDTH = 4.4;
const CORE_WIDTH = 1.7;

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark(theme);
  const pal = paletteFor(theme);
  const hasPlay = activeCells(grid).length > 0;
  const sim = hasPlay ? simulateTron(grid) : null;
  const play = sim ? Math.round(sim.end * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const T = (t: number) => PACE.intro + t;
  const arena = sim?.arena ?? { c0: -1, c1: grid.width, cols: grid.width + 2, rows: ARENA_BOTTOM - ARENA_TOP + 1 };

  const half = layout.gap / 2;
  const gx0 = layout.left + arena.c0 * layout.pitch - half;
  const gx1 = layout.left + (arena.c1 + 1) * layout.pitch - half;
  const gy0 = layout.top + ARENA_TOP * layout.pitch - half;
  const gy1 = layout.top + (ARENA_BOTTOM + 1) * layout.pitch - half;
  const lines: string[] = [];
  for (let c = arena.c0; c <= arena.c1 + 1; c++) lines.push(`M${fmt(layout.left + c * layout.pitch - half)} ${fmt(gy0)}V${fmt(gy1)}`);
  for (let r = ARENA_TOP; r <= ARENA_BOTTOM + 1; r++) lines.push(`M${fmt(gx0)} ${fmt(layout.top + r * layout.pitch - half)}H${fmt(gx1)}`);
  const gridMarkup =
    `<path d="${lines.join("")}" fill="none" stroke="${pal.grid}" stroke-opacity="${pal.gridOpacity}" stroke-width="1"/>` +
    `<rect x="${fmt(gx0)}" y="${fmt(gy0)}" width="${fmt(gx1 - gx0)}" height="${fmt(gy1 - gy0)}" rx="3" fill="none" stroke="${pal.border}" stroke-opacity="${dark ? 0.55 : 0.5}" stroke-width="1.6"/>`;

  const filter = pal.glowStrength > 0
    ? `<filter id="tron-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 0.9)}" result="a"/>` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 2.6)}" result="b"/>` +
      `<feMerge><feMergeNode in="b"/><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    : "";
  const glow = pal.glowStrength > 0 ? ` filter="url(#tron-glow)"` : "";

  const bursts = new Bursts(duration);
  const pixels = [
    [-14, -14], [0, -18], [14, -14], [-18, 0], [18, 0], [-14, 14], [0, 18], [14, 14],
  ].map(([dx, dy]) => ({ dx, dy, size: 4.4 }));
  bursts.define("derez", { life: 0.55, sparks: pixels });
  const crackle = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2 + 0.2;
    const r = 26 + ((i * 7) % 5) * 5;
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, size: 4 + (i % 3) };
  });
  bursts.define("crash", { life: 1.1, sparks: crackle, ring: 28, ringWidth: 2.6, flash: 9, flashColor: "#ffffff" });
  bursts.define("crashRing", { life: 0.8, sparks: [], ring: 40, ringWidth: 1.8 });

  const cells: string[] = [];
  for (const column of grid.cells) for (const cell of column) if (cell) cells.push(cellRect(layout, cell, theme.empty));

  const body: string[] = [];
  const clears: ClearEvent[] = [];
  const dayMarkup: string[] = [];
  const burstMarkup: string[] = [];
  const trailMarkup: string[] = [];
  const cycleMarkup: string[] = [];

  const cycleDef = (color: string) => {
    const edge = dark ? "#ffffff" : theme.ink;
    return (
      `<g transform="scale(1.3)">` +
      `<path d="M-10 -3.4H5Q10.5 -3.4 10.5 0T5 3.4H-10Z" fill="${color}" stroke="${edge}" stroke-opacity="${dark ? 0.9 : 0.7}" stroke-width="1"/>` +
      `<rect x="-11.5" y="-4.6" width="4" height="9.2" rx="1.6" fill="${mix(color, "#000000", 0.45)}"/>` +
      `<rect x="5" y="-4.2" width="4" height="8.4" rx="1.6" fill="${mix(color, "#000000", 0.45)}"/>` +
      `<ellipse cx="-0.5" cy="0" rx="4.4" ry="2" fill="#ffffff" fill-opacity=".92"/>` +
      `<rect x="9" y="-1.2" width="2.6" height="2.4" fill="#ffffff"/></g>`
    );
  };
  const defs = filter + `<g id="cyc0">${cycleDef(pal.player)}</g><g id="cyc1">${cycleDef(pal.rival)}</g>` + bursts.defs();

  if (sim) {
    const point = (id: number): [number, number] => cellCenter(layout, ...cellCoord(sim.arena, id));
    const jumpAt = restore + 0.3;

    const trailGroups: string[] = [];
    sim.cycles.forEach((cy, which) => {
      const color = which === 0 ? pal.player : pal.rival;
      const core = dark ? "#ffffff" : mix(color, "#ffffff", 0.55);
      const n = cy.cells.length;
      const dirsOf = (i: number) => directionOf(sim.arena, cy.cells[i - 1], cy.cells[i]);
      const dtAt = (i: number) => (i + 1 < n ? cy.head[i + 1] - cy.head[i] : i > 0 ? cy.head[i] - cy.head[i - 1] : 1);

      let a = 0;
      while (a < n - 1) {
        let b = a + 1;
        const d = dirsOf(b);
        while (b + 1 < n && dirsOf(b + 1) === d) b++;
        const [sx, sy] = point(cy.cells[a]);
        const len = (b - a) * layout.pitch;
        const ext = len + TRAIL_WIDTH;
        const gOf = (i: number) => ((i - a) * layout.pitch + TRAIL_WIDTH) / ext;
        const fixedHead = (t: number) => {
          if (t <= cy.head[a]) return 0;
          if (t >= cy.head[b]) return 1;
          let i = a;
          while (i + 1 < b && cy.head[i + 1] <= t) i++;
          const f = (t - cy.head[i]) / (cy.head[i + 1] - cy.head[i]);
          return gOf(i) + (gOf(i + 1) - gOf(i)) * f;
        };
        const tailPos = (t: number) => {
          if (t <= cy.tail[a]) return 0;
          let i = a;
          while (i < b && cy.tail[i + 1] <= t) i++;
          if (i >= b) return 1;
          const span = cy.tail[i + 1] - cy.tail[i];
          const f = Number.isFinite(span) && span > 0 ? (t - cy.tail[i]) / span : 0;
          return ((i - a + f) * layout.pitch) / ext;
        };
        const times = new Set<number>([cy.head[a], cy.head[b]]);
        for (let i = a + 1; i < b; i++) if (Math.abs(dtAt(i) - dtAt(i - 1)) > 1e-6) times.add(cy.head[i]);
        let tailEnds = false;
        for (let i = a; i <= b; i++) {
          const t = cy.tail[i];
          if (!Number.isFinite(t)) break;
          if (i === a || i === b || Math.abs((cy.tail[Math.min(i + 1, n - 1)] - t) - (t - cy.tail[Math.max(i - 1, 0)])) > 1e-6) times.add(t);
          if (i === b) tailEnds = true;
        }
        const css = (g: number, dd: number) => `transform:translate(${fmt(dd * ext)}px,0) scale(${fmt(Math.max(0, g - dd))},1)`;
        const frames: Frame[] = [[0, css(0, 0)]];
        const sorted = [...times].sort((p, q) => p - q);
        for (const t of sorted) {
          if (t === cy.head[a]) frames.push([T(t), css(0, 0)]);
          frames.push([T(t), css(fixedHead(t), tailPos(t))]);
        }
        if (tailEnds && Number.isFinite(cy.tail[b])) frames.push([T(cy.tail[b]), css(1, 1)]);
        const cls = tl.track(frames);
        const angle = d * 90;
        trailGroups.push(
          `<g transform="translate(${fmt(sx - (TRAIL_WIDTH / 2) * DX[d])} ${fmt(sy - (TRAIL_WIDTH / 2) * DY[d])}) rotate(${angle})"><g class="${cls}">` +
            `<rect x="0" y="${-TRAIL_WIDTH / 2}" width="${fmt(ext)}" height="${TRAIL_WIDTH}" rx="1" fill="${color}" fill-opacity="${dark ? 0.9 : 1}"/>` +
            `<rect x="0" y="${-CORE_WIDTH / 2}" width="${fmt(ext)}" height="${CORE_WIDTH}" fill="${core}"/></g></g>`,
        );
        a = b;
      }

      const start = point(cy.cells[0]);
      const end = point(cy.cells[n - 1]);
      const posFrames: Frame[] = [[0, translate(start[0], start[1])]];
      const angleOf = (i: number) => (i + 1 < n ? directionOf(sim.arena, cy.cells[i], cy.cells[i + 1]) : dirsOf(i)) * 90;
      const startAngle = n > 1 ? angleOf(0) : which === 0 ? 0 : 180;
      let angle = startAngle;
      const rotFrames: Frame[] = [[0, `transform:rotate(${angle}deg)`]];
      for (let i = 0; i < n; i++) {
        const turning = i > 0 && i + 1 < n && directionOf(sim.arena, cy.cells[i - 1], cy.cells[i]) !== directionOf(sim.arena, cy.cells[i], cy.cells[i + 1]);
        const pace = i > 0 && i + 1 < n && Math.abs(dtAt(i) - dtAt(i - 1)) > 1e-6;
        if (i === 0 || i === n - 1 || turning || pace) {
          const [x, y] = point(cy.cells[i]);
          posFrames.push([T(cy.head[i]), translate(x, y)]);
        }
        if (turning) {
          const dIn = directionOf(sim.arena, cy.cells[i - 1], cy.cells[i]);
          const dOut = directionOf(sim.arena, cy.cells[i], cy.cells[i + 1]);
          const turn = (dOut - dIn + 4) % 4;
          const dt = dtAt(i);
          rotFrames.push([T(cy.head[i]) - 0.3 * dt, `transform:rotate(${angle}deg)`]);
          angle += turn === 1 ? 90 : -90;
          rotFrames.push([T(cy.head[i]) + 0.3 * dt, `transform:rotate(${angle}deg)`]);
        }
      }
      if (n === 1) posFrames.push([T(0), translate(start[0], start[1])]);
      posFrames.push([jumpAt, translate(end[0], end[1])], [jumpAt, translate(start[0], start[1])]);
      rotFrames.push([jumpAt, `transform:rotate(${angle}deg)`], [jumpAt, `transform:rotate(${startAngle}deg)`]);
      const crashAt = which === 1 ? T(sim.crash.t) : Infinity;
      const vis: Frame[] = [[0, "opacity:1"]];
      if (which === 1) {
        vis.push([crashAt, "opacity:1"], [crashAt + 0.001, "opacity:0"], [duration - 0.35, "opacity:0"], [duration, "opacity:1"]);
      } else {
        vis.push([restore - 0.2, "opacity:1"], [restore + 0.1, "opacity:0"], [duration - 0.35, "opacity:0"], [duration, "opacity:1"]);
      }
      const pos = tl.track(posFrames);
      const rot = tl.track(rotFrames);
      const visClass = tl.track(vis);
      cycleMarkup.push(`<g class="${visClass}"><g class="${pos}"><g class="${rot}"><use href="#cyc${which}"/></g></g></g>`);
    });
    const trailFade = tl.track([
      [0, "opacity:1"],
      [restore, "opacity:1"],
      [fadeEnd, "opacity:0"],
      [duration, "opacity:0"],
    ]);
    trailMarkup.push(`<g class="${trailFade}">${trailGroups.join("")}</g>`);

    const cleared = new Map<Cell, number>();
    for (const e of sim.derez) cleared.set(e.cell, T(e.t));
    for (const column of grid.cells) {
      for (const cell of column) {
        if (!cell || cell.level === 0) continue;
        const fill = levelColor(theme, cell);
        const flashFill = dark ? mix(spriteColor(theme, cell), "#ffffff", 0.75) : spriteColor(theme, cell);
        const te = cleared.get(cell);
        if (te === undefined) throw new Error("a day was never reached");
        const cls = tl.track([
          [0, `opacity:1;transform:scale(1);fill:${fill}`],
          [te, `opacity:1;transform:scale(1);fill:${fill}`],
          [te + 0.05, `opacity:1;transform:scale(1.15);fill:${flashFill}`],
          [te + 0.22, `opacity:0;transform:scale(1.5);fill:${flashFill}`],
          [restore, `opacity:0;transform:scale(1);fill:${fill}`],
          [fadeEnd, `opacity:1;transform:scale(1);fill:${fill}`],
        ]);
        dayMarkup.push(cellRect(layout, cell, fill, `class="d ${cls}"`));
        const [cx, cy] = cellCenter(layout, cell.x, cell.y);
        burstMarkup.push(bursts.use("derez", cx, cy, te, spriteColor(theme, cell)));
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
  const end = sim
    ? banner(tl, {
        theme,
        lines: stageClearLines(grid),
        cx: width / 2,
        cy: layout.top + layout.gridHeight / 2,
        from: T(sim.end) + 0.1,
        to: restore,
      })
    : "";
  body.push(
    `<g>${gridMarkup}</g>`,
    `<g>${cells.join("")}</g>`,
    `<g>${dayMarkup.join("")}</g>`,
    `<g${glow}>${trailMarkup.join("")}${cycleMarkup.join("")}${burstMarkup.join("")}</g>`,
    bar,
    end,
  );
  return { width, height, css: `.d{transform-box:fill-box;transform-origin:center}
${tl.css()}\n${bursts.css()}`, defs, body: body.join("\n") };
}

function cellCoord(a: Arena, id: number): [number, number] {
  return [colOf(a, id), rowOf(a, id)];
}

export const tron: Game = { id: "tron", title: "Tron", render };
