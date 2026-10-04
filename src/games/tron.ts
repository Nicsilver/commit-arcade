import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { Bursts } from "../fx.ts";
import type { BurstShape } from "../fx.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid } from "../grid.ts";
import { arcadeLayout, banner, hud, spriteColor, stageClearLines } from "../kit.ts";
import type { ClearEvent } from "../kit.ts";
import { createRng } from "../rng.ts";
import type { Rng } from "../rng.ts";
import { cellCenter, cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const ARENA_TOP = -1;
const ARENA_BOTTOM = 9;
const FINALE_STEP = 0.058;
/** Seconds the race for the days should take at a comfortable pace. */
const HUNT_SPAN = 24;
const BASE_STEP_MIN = 0.07;
const BASE_STEP_MAX = 0.13;
/** Share of the days left at which the cycles speed up. */
const ENDGAME_SHARE = 0.12;
const CRASH_AFTER = 0.9;
const LAP_AFTER = 1.7;
const LAP_TICKS = 70;
/** Ticks after the last day within which the rival must have crashed, whatever it takes. */
const CRASH_DEADLINE = 90;
/** Steps ahead a cycle must be able to keep driving after a move to count it as safe. */
const ESCAPE = 36;
/** Cells a cycle should be able to reach before the other one does, or it risks being walled in. */
const TERRITORY = 45;
const CUT_COOLDOWN = 24;
/** Margin, in cells, that keeps a crash's blast inside the canvas. */
const CRASH_MARGIN_COLS = 1;
const CRASH_TOP_ROW = 1;
const CRASH_BOTTOM_ROW = 7;

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
  /** Cells of trail a cycle keeps behind it. */
  trail: number;
  /** Times one cycle cut across the cell just ahead of the other's nose. */
  nearMisses: number;
  /** Moves that had nowhere safe to go; always zero unless a cycle got boxed in. */
  collisions: number;
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

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function collapse(head: number[], tail: number[], from: number): void {
  let j0 = tail.findIndex((t) => t > from);
  if (j0 < 0) j0 = tail.length;
  let prev = 0;
  for (let i = 0; i < tail.length; i++) {
    let t = tail[i];
    if (i >= j0) t = Math.min(t, from + (i - j0) * 0.01);
    t = Math.max(t, head[i] + 0.001, prev);
    tail[i] = t;
    prev = t;
  }
}

/**
 * One whole race, tick by tick. Both cycles take one step per tick, head
 * for the days they can reach before the other, and never enter a cell whose
 * trail is still there. Trails fade from the tail after `trail` cells, so
 * cells come back into play. Once the last day is gone the rival rides into the
 * player's wall while the player takes a victory lap.
 */
function race(grid: Grid, rng: Rng): TronSim {
  const width = grid.width;
  const arena: Arena = { c0: -1, c1: width, cols: width + 2, rows: ARENA_BOTTOM - ARENA_TOP + 1 };
  const total = arena.cols * arena.rows;
  const trail = clamp(Math.round(total * 0.06), 8, 36);
  const days = new Map<number, Cell>();
  for (const c of activeCells(grid)) days.set(idOf(arena, c.x, c.y), c);
  const dayTotal = days.size;

  const visit = new Int32Array(total).fill(-1_000_000);
  const owner = new Int8Array(total).fill(-1);
  const free = (c: number, t: number) => visit[c] + trail < t;
  const live = (c: number, t: number) => visit[c] + trail >= t;

  const startRow = Math.floor(grid.height / 2);
  const cells: number[][] = [[idOf(arena, -1, startRow)], [idOf(arena, width, startRow)]];
  const dirs = [0, 2];
  cells.forEach((cs, k) => {
    visit[cs[0]] = 0;
    owner[cs[0]] = k;
  });

  const derez: { tick: number; cell: Cell; by: 0 | 1 }[] = [];
  const fast = new Set<number>();
  let nearMisses = 0;
  let collisions = 0;
  let lastCut = -CUT_COOLDOWN;
  let doneAt = -1;
  let crashTick = -1;
  let crashPoint = { x: 0, y: 0 };

  const crashAllowed = (id: number) => {
    const col = colOf(arena, id);
    const row = rowOf(arena, id);
    return col >= CRASH_MARGIN_COLS && col <= width - 1 - CRASH_MARGIN_COLS && row >= CRASH_TOP_ROW && row <= CRASH_BOTTOM_ROW;
  };

  /** How many steps a cycle can keep driving from `cell` (reached on tick `t`) without meeting a trail. */
  const escape = (cell: number, dir: number, t: number, near: number[][] = []): number => {
    const used = new Set<number>([cell]);
    let budget = 20000;
    const walk = (c: number, d: number, depth: number): number => {
      if (depth >= ESCAPE || budget-- <= 0) return depth;
      let best = depth;
      for (const turn of [0, 1, 3]) {
        const nd = (d + turn) % 4;
        const n = neighbour(arena, c, nd);
        if (n < 0 || used.has(n) || !free(n, t + depth + 1) || (depth < near.length && near[depth].includes(n))) continue;
        used.add(n);
        best = Math.max(best, walk(n, nd, depth + 1));
        used.delete(n);
        if (best >= ESCAPE) return best;
      }
      return best;
    };
    return walk(cell, dir, 0);
  };

  /** Breadth-first search over cells that are free by the time the cycle gets there. */
  const search = (start: number, t: number, goal: (c: number, depth: number) => number | null): number => {
    const dist = new Int16Array(total).fill(-1);
    dist[start] = 0;
    let queue = [start];
    let best = Infinity;
    let firstDepth = -1;
    for (let d = 0; queue.length; d++) {
      if (firstDepth >= 0 && d > firstDepth + 5) break;
      const next: number[] = [];
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

  /** Cells this cycle gets to first if both race outward from where they are. */
  const territory = (cell: number, rival: number, t: number): number => {
    const owner2 = new Int8Array(total).fill(-1);
    owner2[cell] = 0;
    owner2[rival] = 1;
    let queue: number[] = [cell, rival];
    let mine = 1;
    for (let d = 0; queue.length && d < 40; d++) {
      const next: number[] = [];
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

  const seekDays = (cell: number, t: number, rival: number): number => {
    const rivalCol = colOf(arena, rival);
    const rivalRow = rowOf(arena, rival);
    return search(cell, t, (c, d) => {
      const day = days.get(c);
      if (!day) return null;
      const closer = Math.abs(colOf(arena, c) - rivalCol) + Math.abs(rowOf(arena, c) - rivalRow) < d - 1;
      return d + (closer ? 5 : 0) - 0.4 * day.level;
    });
  };

  const seekWall = (cell: number, t: number): number =>
    search(cell, t, (c, d) => {
      for (let nd = 0; nd < 4; nd++) {
        const n = neighbour(arena, c, nd);
        if (n >= 0 && owner[n] === 0 && live(n, t + d + 1) && crashAllowed(n)) return d;
      }
      return null;
    });

  /** Distance to the lane just ahead of the other cycle's nose, when it can be reached before the nose gets there. */
  const intercept = (cell: number, t: number, rival: number, rivalDir: number, rivalMoved: boolean): number => {
    const line: number[] = [];
    let c = rival;
    for (let i = 0; i < 4; i++) {
      c = neighbour(arena, c, rivalDir);
      if (c < 0) break;
      line.push(c);
    }
    const base = rivalMoved ? t : t - 1;
    return search(cell, t, (c2, d) => {
      const k = line.indexOf(c2) + 1;
      if (k < 2) return null;
      const gap = base + k - (t + d);
      return gap === 1 || gap === 2 ? d : null;
    });
  };

  const step = (k: 0 | 1, t: number, finale: boolean) => {
    const me = cells[k];
    const head = me[me.length - 1];
    const dir = dirs[k];
    const other = cells[1 - k];
    const rival = other[other.length - 1];
    const rivalDir = dirs[1 - k];
    const rivalAlive = !(k === 0 && crashTick >= 0);

    if (finale && k === 1) {
      const ahead = neighbour(arena, head, dir);
      const hitWall = ahead >= 0 && live(ahead, t) && owner[ahead] === 0 && crashAllowed(ahead);
      const late = t > doneAt + CRASH_DEADLINE && (ahead < 0 || live(ahead, t));
      if ((hitWall && t >= doneAt + Math.ceil(CRASH_AFTER / FINALE_STEP)) || late) {
        crashTick = t - 1;
        const [ac, ar] = ahead >= 0 ? [colOf(arena, ahead), rowOf(arena, ahead)] : [colOf(arena, head) + DX[dir], rowOf(arena, head) + DY[dir]];
        crashPoint = { x: (colOf(arena, head) + ac) / 2, y: (rowOf(arena, head) + ar) / 2 };
        return;
      }
    }

    const options: { n: number; d: number }[] = [];
    for (const turn of [0, 1, 3]) {
      const d = (dir + turn) % 4;
      const n = neighbour(arena, head, d);
      if (n >= 0 && free(n, t)) options.push({ n, d });
    }
    if (options.length === 0) {
      collisions++;
      const d = dir;
      const n = neighbour(arena, head, d);
      options.push({ n: n >= 0 ? n : head, d });
    }

    const ahead1 = rivalAlive ? neighbour(arena, rival, rivalDir) : -1;
    const rivalMoved = other.length > me.length;
    const reach1: number[] = [];
    const reach2: number[] = [];
    if (rivalAlive) {
      for (const turn of [0, 1, 3]) {
        const d1 = (rivalDir + turn) % 4;
        const n1 = neighbour(arena, rival, d1);
        if (n1 < 0) continue;
        reach1.push(n1);
        for (const turn2 of [0, 1, 3]) {
          const n2 = neighbour(arena, n1, (d1 + turn2) % 4);
          if (n2 >= 0) reach2.push(n2);
        }
      }
    }
    /** Whether the other cycle has any move left once `taken` is blocked. */
    const rivalHasMove = (taken: number) => {
      if (!rivalAlive) return true;
      const was = visit[taken];
      visit[taken] = t;
      const ok = [0, 1, 3].some((turn) => {
        const n = neighbour(arena, rival, (rivalDir + turn) % 4);
        return n >= 0 && free(n, rivalMoved ? t + 1 : t);
      });
      visit[taken] = was;
      return ok;
    };
    /** Whether the other cycle still has a way out once `taken` is blocked. */
    const rivalEscapes = (taken: number) => {
      const was = visit[taken];
      visit[taken] = t;
      const ok = [1, 3].some((turn) => {
        const nd = (rivalDir + turn) % 4;
        const n = neighbour(arena, rival, nd);
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
      const roomy = !rivalAlive || territory(o.n, rival, t) >= TERRITORY;
      const safe = room >= ESCAPE && roomy;
      let score: number;
      if (hunting) {
        score = days.has(o.n) ? -0.4 * (days.get(o.n)?.level ?? 0) : seekDays(o.n, t, rival);
        if (!Number.isFinite(score)) score = 400;
      } else if (seeking) {
        score = seekWall(o.n, t);
        if (!Number.isFinite(score)) score = 400;
      } else {
        score = (ESCAPE - room) * 0.6;
      }
      score += (o.d === dir ? -0.25 : 0) + rng() * 0.7;
      if (hunting && o.n === ahead1 && t - lastCut >= CUT_COOLDOWN && rivalEscapes(o.n)) score -= 12;
      else if (hunting && rivalAlive && t - lastCut >= CUT_COOLDOWN && Math.abs(colOf(arena, rival) - colOf(arena, head)) + Math.abs(rowOf(arena, rival) - rowOf(arena, head)) <= 10 && Number.isFinite(intercept(o.n, t, rival, rivalDir, rivalMoved))) score -= 6;
      if (!rivalHasMove(o.n)) score += 1000;
      const better =
        (safe && !bestSafe) || (safe === bestSafe && (safe ? score < bestScore : room > bestEscape || (room === bestEscape && score < bestScore)));
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

  const limit = 4000;
  for (let t = 1; t < limit; t++) {
    if (days.size > 0 && days.size <= dayTotal * ENDGAME_SHARE) fast.add(t);
    const order: (0 | 1)[] = t % 2 ? [0, 1] : [1, 0];
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
  const base = clamp(HUNT_SPAN / Math.max(doneAt, 1), BASE_STEP_MIN, BASE_STEP_MAX);
  const times = [0];
  for (let t = 1; t <= lastTick; t++) {
    times.push(times[t - 1] + (t > doneAt ? FINALE_STEP : fast.has(t) ? base * 0.72 : base));
  }
  const crashTime = times[crashTick] + FINALE_STEP * 0.5;
  const end = crashTime + LAP_AFTER;
  let keep = lastTick + 1;
  while (keep > 1 && times[keep - 2] > end + PACE.hold + 0.1) keep--;

  const make = (cs: number[], tCollapse: number): Cycle => {
    const head = times.slice(0, cs.length);
    const tail = head.map((_, i) => (i + trail < head.length ? head[i + trail] : Infinity));
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
    collisions,
  };
}

/**
 * Plays races until one is clean: nobody got boxed in and the cycles cut each
 * other off at least once. The cycles read the board well but cannot see each
 * other's next move, so a few races end in a trap; those are simply replayed.
 */
export function simulateTron(grid: Grid, rng: Rng): TronSim {
  const base = Math.floor(rng() * 1e9);
  let best: TronSim | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const sim = race(grid, createRng(`${base}:${attempt}`));
    if (sim.collisions === 0 && (sim.nearMisses >= 1 || attempt >= 5)) return sim;
    const better = !best || sim.collisions < best.collisions || (sim.collisions === best.collisions && sim.nearMisses > best.nearMisses);
    if (better) best = sim;
  }
  return best!;
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

/** Days per clear counter; each clear restyles one group, while every group costs an animated element. */
const CLEAR_GROUP = 14;
const TRAIL_WIDTH = 4.4;
const CORE_WIDTH = 1.7;

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark(theme);
  const pal = paletteFor(theme);
  const hasPlay = activeCells(grid).length > 0;
  const sim = hasPlay ? simulateTron(grid, ctx.rng) : null;
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

  const glowing = pal.glowStrength > 0;
  const trailAlpha = dark ? 0.9 : 1;
  const filter = glowing
    ? `<filter id="tron-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 0.9)}" result="a"/>` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(theme.glow * 2.6)}" result="b"/>` +
      `<feMerge><feMergeNode in="b"/><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    : "";
  const glow = glowing ? ` filter="url(#tron-glow)"` : "";

  const bursts = new Bursts(duration);
  const pixels = [
    [-14, -14], [0, -18], [14, -14], [-18, 0], [18, 0], [-14, 14], [0, 18], [14, 14],
  ].map(([dx, dy]) => ({ dx, dy, size: 4.4 }));
  const crackle = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2 + 0.2;
    const r = 26 + ((i * 7) % 5) * 5;
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, size: 4 + (i % 3) };
  });
  const burstShapes: Record<string, BurstShape> = {
    derez: { life: 0.55, sparks: pixels },
    crash: { life: 1.1, sparks: crackle, ring: 28, ringWidth: 2.6, flash: 9, flashColor: "#ffffff" },
    crashRing: { life: 0.8, sparks: [], ring: 40, ringWidth: 1.8 },
  };
  for (const [id, shape] of Object.entries(burstShapes)) bursts.define(id, shape);

  const burstDef = (id: string, shape: BurstShape) => {
    const parts: string[] = [];
    if (shape.flash) parts.push(`<circle r="${fmt(shape.flash)}" fill="${shape.flashColor ?? "#fff"}"/>`);
    if (shape.ring) parts.push(`<circle r="${fmt(shape.ring)}" fill="none" stroke="currentColor" stroke-width="${shape.ringWidth ?? 1.6}"/>`);
    for (const s of shape.sparks) {
      parts.push(`<rect x="${fmt(s.dx - s.size / 2)}" y="${fmt(s.dy - s.size / 2)}" width="${fmt(s.size)}" height="${fmt(s.size)}" fill="currentColor"/>`);
    }
    return `<g id="fx-${id}">${parts.join("")}</g>`;
  };

  const cells: string[] = [];
  for (const column of grid.cells) for (const cell of column) if (cell) cells.push(cellRect(layout, cell, theme.empty));

  const body: string[] = [];
  const clears: ClearEvent[] = [];
  const dayMarkup: string[] = [];
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

  if (sim) {
    const point = (id: number): [number, number] => cellCenter(layout, ...cellCoord(sim.arena, id));
    const jumpAt = restore + 0.3;

    const trailBodies: string[] = [];
    sim.cycles.forEach((cy, which) => {
      const color = which === 0 ? pal.player : pal.rival;
      const core = dark ? "#ffffff" : mix(color, "#ffffff", 0.55);
      const n = cy.cells.length;
      const dirsOf = (i: number) => directionOf(sim.arena, cy.cells[i - 1], cy.cells[i]);
      const dtAt = (i: number) => (i + 1 < n ? cy.head[i + 1] - cy.head[i] : i > 0 ? cy.head[i] - cy.head[i - 1] : 1);

      // The whole path the cycle will ever drive is drawn once per layer, and a dash window slides along it from
      // the tail to the head. A stroked path unions its own overlaps, so the halo layers cannot stack at corners.
      const pts = cy.cells.map(point);
      const d: string[] = [`M${fmt(pts[0][0])} ${fmt(pts[0][1])}`];
      for (let i = 1; i < n; i++) {
        const straight = i + 1 < n && (pts[i + 1][0] - pts[i][0]) * (pts[i][1] - pts[i - 1][1]) === (pts[i + 1][1] - pts[i][1]) * (pts[i][0] - pts[i - 1][0]);
        if (!straight) d.push(`L${fmt(pts[i][0])} ${fmt(pts[i][1])}`);
      }
      const path = d.join("");
      const pitch = layout.pitch;
      const total = (n - 1) * pitch;

      // Head and tail as (time, distance along the path) lines, with the straight stretches dropped.
      const line = (times: number[]): [number, number][] => {
        const all = times.map((time, i): [number, number] => [T(time), i * pitch]).filter(([time]) => Number.isFinite(time));
        return all.filter((pt, i) => {
          if (i === 0 || i === all.length - 1) return true;
          const [t0, a0] = all[i - 1];
          const [t1, a1] = all[i + 1];
          return Math.abs((pt[1] - a0) * (t1 - pt[0]) - (a1 - pt[1]) * (pt[0] - t0)) > 1e-7;
        });
      };
      const at = (pts: [number, number][], time: number): [number, number] => {
        const same = pts.filter(([pt]) => Math.abs(pt - time) < 1e-9);
        if (same.length) return [same[0][1], same[same.length - 1][1]];
        if (time < pts[0][0]) return [0, 0];
        if (time > pts[pts.length - 1][0]) return [total, total];
        const i = pts.findIndex(([pt]) => pt > time);
        const [t0, a0] = pts[i - 1];
        const [t1, a1] = pts[i];
        const v = a0 + ((a1 - a0) * (time - t0)) / (t1 - t0);
        return [v, v];
      };
      const heads = line(cy.head);
      const tails = line(cy.tail);
      const knots = [...new Set([0, duration, ...heads.map(([pt]) => pt), ...tails.map(([pt]) => pt)])].sort((p, q) => p - q);
      const window = (s: number, e: number) =>
        `visibility:${e - s > 1e-6 ? "visible" : "hidden"};stroke-dasharray:${fmt(e - s)}px ${fmt(total + 2 * TRAIL_WIDTH)}px;stroke-dashoffset:${fmt(-s)}px`;
      const slide: Frame[] = [];
      for (const time of knots) {
        const [e0, e1] = at(heads, time);
        const [s0, s1] = at(tails, time);
        slide.push([time, window(s0, e0)]);
        if (s0 !== s1 || e0 !== e1) slide.push([time, window(s1, e1)]);
      }
      const keys = tl.keyframes(slide);
      const stroke = (width: number, color: string, opacity: number, cap: string, join: string) =>
        `<path class="${tl.useKeyframes(keys, 0)}" d="${path}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${fmt(width)}" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`;
      trailBodies.push(stroke(TRAIL_WIDTH, color, trailAlpha, "square", "miter"), stroke(CORE_WIDTH, core, 1, "square", "miter"));

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
          rotFrames.push([T(cy.head[i]) - 0.12 * dt, `transform:rotate(${angle}deg)`]);
          angle += turn === 1 ? 90 : -90;
          rotFrames.push([T(cy.head[i]) + 0.12 * dt, `transform:rotate(${angle}deg)`]);
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
    trailMarkup.push(trailBodies.join(""));

    // Days: still ones are plain rects that read how many of their group have been cleared; the clearing flash
    // is played on a few shared rects.
    const cleared = new Map<Cell, number>();
    for (const e of sim.derez) cleared.set(e.cell, T(e.t));
    const days: { cell: Cell; te: number }[] = [];
    for (const column of grid.cells) {
      for (const cell of column) {
        if (!cell || cell.level === 0) continue;
        const te = cleared.get(cell);
        if (te === undefined) throw new Error("a day was never reached");
        days.push({ cell, te });
      }
    }
    days.sort((p, q) => p.te - q.te);
    const flashes: Play[] = [];
    const half = layout.cell / 2;
    for (let first = 0; first < days.length; first += CLEAR_GROUP) {
      const members = days.slice(first, first + CLEAR_GROUP);
      const counter: Frame[] = [[0, "opacity:1;--n:0"]];
      members.forEach(({ te }, i) => counter.push([te, `opacity:1;--n:${i}`], [te, `opacity:1;--n:${i + 1}`]));
      counter.push([restore, `opacity:1;--n:${members.length}`], [restore, "opacity:0;--n:0"], [fadeEnd, "opacity:1;--n:0"]);
      const rects = members.map(({ cell }, i) => cellRect(layout, cell, levelColor(theme, cell), `class="k" style="--i:${i + 1}"`));
      dayMarkup.push(`<g class="${tl.track(counter)}" style="--n:0">${rects.join("")}</g>`);
    }
    for (const { cell, te } of days) {
      const fill = levelColor(theme, cell);
      const flashFill = dark ? mix(spriteColor(theme, cell), "#ffffff", 0.75) : spriteColor(theme, cell);
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      const look = (scale: number, opacity: number, color: string) => `opacity:${opacity};${translate(cx, cy, `scale(${scale})`)};fill:${color}`;
      flashes.push({
        frames: [
          [te, look(1, 1, fill)],
          [te + 0.05, look(1.15, 1, flashFill)],
          [te + 0.22, look(1.5, 0, flashFill)],
        ],
      });
      bursts.play("derez", cx, cy, te, spriteColor(theme, cell));
      clears.push({ t: te, cell });
    }
    for (const frames of pooled(flashes)) {
      dayMarkup.push(`<rect class="${tl.track(frames)}" x="${fmt(-half)}" y="${fmt(-half)}" width="${layout.cell}" height="${layout.cell}" rx="${layout.radius}"/>`);
    }
    const [cx, cy] = cellCenter(layout, sim.crash.x, sim.crash.y);
    const tc = T(sim.crash.t);
    bursts.play("crash", cx, cy, tc, pal.rival);
    bursts.play("crashRing", cx, cy, tc + 0.12, pal.player);
  } else {
    for (const column of grid.cells) {
      for (const cell of column) if (cell && cell.level > 0) dayMarkup.push(cellRect(layout, cell, levelColor(theme, cell)));
    }
    const [x, y] = cellCenter(layout, -1, 3);
    const [x2] = cellCenter(layout, grid.width, 3);
    cycleMarkup.push(`<g transform="translate(${fmt(x)} ${fmt(y)})"><use href="#cyc0"/></g>`);
    cycleMarkup.push(`<g transform="translate(${fmt(x2)} ${fmt(y)}) rotate(180)"><use href="#cyc1"/></g>`);
  }

  const defs =
    filter +
    `<g id="cyc0">${cycleDef(pal.player)}</g><g id="cyc1">${cycleDef(pal.rival)}</g>` +
    Object.entries(burstShapes).map(([id, shape]) => burstDef(id, shape)).join("");

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
    `<g${glow}>${trailMarkup.join("")}${cycleMarkup.join("")}${sim ? bursts.markup(tl) : ""}</g>`,
    bar,
    end,
  );
  return { width, height, css: `.k{opacity:clamp(0,calc(var(--i) - var(--n)),1)}\n${tl.css()}`, defs, body: body.join("\n") };
}

interface Play {
  /** Absolute-time frames; the first is when the thing appears and the last leaves it hidden. */
  frames: Frame[];
}

/**
 * Packs one-shot things onto as few elements as possible: an element with its own animation costs style work
 * on every frame even while it sits hidden, so a slot is reused as soon as its previous thing is over.
 */
function pooled(plays: Play[]): Frame[][] {
  const slots: { free: number; last: string; frames: Frame[] }[] = [];
  for (const play of [...plays].sort((p, q) => p.frames[0][0] - q.frames[0][0])) {
    const [start] = play.frames[0];
    const [end, rest] = play.frames[play.frames.length - 1];
    let slot = slots.find((s) => s.free <= start);
    if (!slot) {
      slot = { free: 0, last: rest, frames: [[0, rest]] };
      slots.push(slot);
    }
    slot.frames.push([start, slot.last], ...play.frames);
    slot.free = end;
    slot.last = rest;
  }
  return slots.map((s) => s.frames);
}

function cellCoord(a: Arena, id: number): [number, number] {
  return [colOf(a, id), rowOf(a, id)];
}

export const tron: Game = { id: "tron", title: "Tron", render };
