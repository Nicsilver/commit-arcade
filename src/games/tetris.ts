import { fmt, Timeline, type Frame } from "../anim.ts";
import { loopDuration, PACE, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import type { Cell } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, stageClearLines, type ClearEvent } from "../kit.ts";
import { pixelText } from "../pixel-font.ts";
import type { Rng } from "../rng.ts";
import { cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";

export type Kind = "I" | "O" | "T" | "S" | "Z" | "J" | "L" | "x";

/** Tetromino shapes in their spawn orientation, as (x, y) cells inside an n x n box, y pointing down. */
export const SHAPES: Record<Exclude<Kind, "x">, { n: number; cells: [number, number][] }> = {
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

export const KINDS = Object.keys(SHAPES) as Exclude<Kind, "x">[];

/** Rotates cells a quarter turn clockwise inside their box. */
export function turn(cells: [number, number][], n: number, times = 1): [number, number][] {
  let out = cells;
  for (let k = 0; k < ((times % 4) + 4) % 4; k++) out = out.map(([x, y]) => [n - 1 - y, x] as [number, number]);
  return out;
}

/** Leftover shapes for boards whose gaps cannot be filled by tetrominoes alone. */
const FILLERS: [number, number][][] = [
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [0, 1]],
  [[0, 0], [1, 0], [1, 1]],
  [[1, 0], [0, 1], [1, 1]],
  [[0, 0], [0, 1], [1, 1]],
];

interface Orient {
  kind: Kind;
  /** Offsets with y pointing up, relative to the leftmost cell (lowest one on ties). */
  cells: [number, number][];
  size: number;
}

function normalise(kind: Kind, raw: [number, number][]): Orient {
  const up = raw.map(([x, y]) => [x, -y] as [number, number]);
  const first = up.reduce((a, b) => (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? b : a));
  const cells = up.map(([x, y]) => [x - first[0], y - first[1]] as [number, number]);
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { kind, cells, size: cells.length };
}

function orientations(kind: Kind, base: [number, number][], n: number): Orient[] {
  const seen = new Set<string>();
  const out: Orient[] = [];
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

const TETRO: Orient[] = KINDS.flatMap((k) => orientations(k, SHAPES[k].cells, SHAPES[k].n));
const FILL: Orient[] = FILLERS.flatMap((cells) => orientations("x", cells, Math.max(...cells.flat()) + 1));

export interface Placement {
  kind: Kind;
  /** Dropped after everything else: the I that completes the four-row clear. */
  last?: boolean;
  /** Cells as [column, row]; rows count up from the floor of the whole game, cleared rows included. */
  cells: [number, number][];
}

export interface Solution {
  /** Rows cleared over the whole game; every column ends up this tall. */
  rows: number;
  /** Drops in the order they fall. */
  placements: Placement[];
  /** Cells that had to be filled with pieces smaller than a tetromino. */
  filler: number;
}

export interface SolveOptions {
  /** Search nodes one tiling attempt may visit. */
  budget?: number;
  /** Search nodes all attempts together may visit. */
  limit?: number;
}

/**
 * Plans a game that ends with an empty board.
 *
 * Columns are solid stacks without holes. A full row is removed the moment it forms,
 * so each column loses exactly one cell per cleared row and every column has to end up
 * the same total height `rows`. That makes the gaps between each stack and that height
 * a region to tile exactly with tetrominoes. A tiling is only playable if its pieces can
 * be dropped one at a time from above, each resting on what is already there.
 */
export function solveBoard(heights: number[], rng: Rng, opts: SolveOptions = {}): Solution {
  const W = heights.length;
  const total = heights.reduce((a, b) => a + b, 0);
  const maxH = Math.max(0, ...heights);
  if (total === 0) return { rows: 0, placements: [], filler: 0 };

  const attempts: { rows: number; slack: number; well: number; cost: number }[] = [];
  for (let rows = maxH; rows <= maxH + 9; rows++) {
    const cells = W * rows - total;
    if (cells < 0) continue;
    for (let slack = cells % 4; slack <= 7 && slack <= cells; slack += 4) {
      const cost = (slack > 0 ? 20 + slack * 3 : 0) + (rows - maxH) * (W / 4) * 0.5 + (slack > 3 ? 12 : 0);
      // The last drop can be an I down a four-deep well: a four-row clear to finish on.
      const deep = Array.from({ length: W }, (_, c) => c).filter((c) => rows - heights[c] >= 4);
      for (const c of shuffle(rng, deep).slice(0, 30)) attempts.push({ rows, slack, well: c, cost });
      attempts.push({ rows, slack, well: -1, cost: cost + 4 });
    }
  }
  attempts.sort((a, b) => a.cost - b.cost);

  const budget = opts.budget ?? 8000;
  const limit = opts.limit ?? 150_000;
  const shared = { nodes: 0 };
  const failed = attempts.map(() => new Set<string>());
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

/** Last resort: drop single blocks into every gap, lowest first. */
function emergency(heights: number[], rows: number): Solution {
  const placements: Placement[] = [];
  for (let r = 1; r <= rows; r++) {
    heights.forEach((h, c) => {
      if (h < r) placements.push({ kind: "x", cells: [[c, r]] });
    });
  }
  return { rows, placements, filler: placements.length };
}

interface Tiling {
  pieces: Placement[];
}

/**
 * Exact cover of the gaps by tetrominoes, one column at a time. The state that matters
 * is which cells in the next few columns earlier pieces already took, so failures are
 * remembered and the search stays small even on a ragged skyline.
 */
function tile(
  heights: number[],
  K: number,
  slackStart: number,
  wc: number,
  rng: Rng,
  budget: number,
  failed: Set<string>,
  shared: { nodes: number },
): Tiling | null {
  const W = heights.length;
  const covered = new Int32Array(W + 4);
  const pieces: Placement[] = [];
  const recent: Kind[] = [];
  let nodes = 0;
  let aborted = false;

  if (wc >= 0) for (let r = K - 3; r <= K; r++) covered[wc] |= 1 << r;

  const dfs = (start: number, slack: number): boolean => {
    let c = start;
    let r = 0;
    for (; c < W; c++) {
      r = heights[c] + 1;
      while (r <= K && (covered[c] >> r) & 1) r++;
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

    const options: { o: Orient; score: number }[] = [];
    const pool = slack > 0 ? TETRO.concat(FILL.filter((o) => o.size <= slack)) : TETRO;
    for (const o of pool) {
      let ok = true;
      for (const [dx, dy] of o.cells) {
        const col = c + dx;
        const row = r + dy;
        if (col >= W || row <= heights[col] || row > K || (covered[col] >> row) & 1) {
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
      const cells: [number, number][] = o.cells.map(([dx, dy]) => [c + dx, r + dy]);
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

/**
 * Orders the pieces of a tiling so each can be dropped from above: a piece goes after
 * the ones directly under it, lowest first otherwise. Returns null when pieces lock
 * each other in place or the stack would reach past the top of the board.
 */
function sequence(heights: number[], pieces: Placement[]): Placement[] | null {
  const owner = new Map<string, number>();
  pieces.forEach((p, i) => p.cells.forEach(([c, r]) => owner.set(`${c}:${r}`, i)));
  const after: number[][] = pieces.map(() => []);
  const waiting = pieces.map(() => 0);
  pieces.forEach((p, i) => {
    for (const [c, r] of p.cells) {
      const above = owner.get(`${c}:${r + 1}`);
      if (above !== undefined && above !== i && !after[i].includes(above)) {
        after[i].push(above);
        waiting[above]++;
      }
    }
  });
  const low = pieces.map((p) => (p.last ? Infinity : Math.min(...p.cells.map((c) => c[1]))));
  const left = pieces.map((p) => Math.min(...p.cells.map((c) => c[0])));
  const ready = pieces.map((_, i) => i).filter((i) => waiting[i] === 0);
  const order: Placement[] = [];
  const h = heights.slice();
  while (ready.length > 0) {
    let best = 0;
    for (let k = 1; k < ready.length; k++) {
      const a = ready[k];
      const b = ready[best];
      if (low[a] < low[b] || (low[a] === low[b] && left[a] < left[b])) best = k;
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
// ---- game ----

const ROWS = 7;
const TARGET_PLAY = 40;

interface BlockState {
  dy: number;
  fill: string;
  opacity: number;
}

interface PoseState {
  x: number;
  y: number;
  rot: number;
  opacity: number;
}

/** Keyframes for one element, built by pinning the current state and tweening to a new one. */
class Track<S extends object> {
  readonly frames: Frame[] = [];
  readonly state: S;
  private readonly css: (s: S) => string;
  private last = 0;

  constructor(state: S, css: (s: S) => string) {
    this.state = state;
    this.css = css;
  }

  pin(t: number, ease?: string): void {
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

  set(t: number, patch: Partial<S>): void {
    this.pin(t);
    Object.assign(this.state, patch);
    this.frames.push([Math.max(t, this.last) + 0.001, this.css(this.state)]);
    this.last = Math.max(t, this.last) + 0.001;
  }

  tween(t0: number, t1: number, patch: Partial<S>, ease = "linear"): void {
    this.pin(t0, ease);
    Object.assign(this.state, patch);
    const end = Math.max(t1, this.last + 0.001);
    this.frames.push([end, this.css(this.state)]);
    this.last = end;
  }
}

const blockCss = (s: BlockState) => `transform:translate(0,${fmt(s.dy)}px);fill:${s.fill};opacity:${s.opacity}`;
const poseCss = (s: PoseState) => `opacity:${s.opacity};transform:translate(${fmt(s.x)}px,${fmt(s.y)}px) rotate(${fmt(s.rot)}deg)`;

type Move = "L" | "R" | "D" | "CW" | "CCW";

interface Block {
  day: boolean;
  cell: Cell | null;
  /** Column, and physical row counted up from the floor of the board. */
  c: number;
  p: number;
  /** Row the block first settles in, before any row is cleared. */
  rest: number;
  color: string;
  track: Track<BlockState>;
  /** Top-left corner: the day's own square, or the block's place inside its piece. */
  x: number;
  y: number;
}

interface PieceOp {
  type: "piece";
  kind: Kind;
  blocks: Block[];
  n: number;
  /** Box position and rotation the piece starts in and ends in. */
  start: { bx: number; bj: number };
  goal: { bx: number; bj: number };
  moves: Move[];
  pose: Track<PoseState> | null;
}

interface ClearOp {
  type: "clear";
  rows: number;
  cleared: Block[];
  shifted: Block[];
}

type Op = PieceOp | ClearOp;

export interface TetrisPlay {
  layout: ReturnType<typeof arcadeLayout>;
  ops: Op[];
  rows: number;
  filler: number;
  pieces: number;
  /** One event per active day, when the row that holds it is swept. */
  clears: ClearEvent[];
  lines: { t: number; total: number }[];
  /** Start of every four-row clear. */
  tetrises: number[];
  gravityEnd: number;
  play: number;
  days: Block[];
}

interface State {
  bx: number;
  bj: number;
  r: number;
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const out = items.slice();
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}

/**
 * Moves a piece from the lane above the board to its resting place, shifting and
 * rotating on the way. Cheapest path wins, and moving sideways costs more the lower
 * the piece is, so the manoeuvring happens up top and the last stretch is a drop.
 */
function planPath(
  spawn: [number, number][],
  n: number,
  target: [number, number][],
  occ: (Block | null)[][],
  rng: Rng,
  canRotate: boolean,
): { start: State; goal: State; moves: Move[] } {
  const W = occ.length;
  const turns = [0, 1, 2, 3].map((r) => turn(spawn, n, r));
  const order = (cells: [number, number][]) => cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const t0 = order(target);
  const goals: State[] = [];
  for (let r = 0; r < (canRotate ? 4 : 1); r++) {
    const c0 = order(turns[r]);
    const dx = t0[0][0] - c0[0][0];
    const dy = t0[0][1] - c0[0][1];
    if (c0.every((c, i) => c[0] + dx === t0[i][0] && c[1] + dy === t0[i][1])) goals.push({ bx: dx, bj: dy, r });
  }
  const key = (s: State) => ((s.bx + 12) * 24 + (s.bj + 6)) * 4 + s.r;
  const goalKeys = new Set(goals.map(key));

  const blocked = (s: State): boolean => {
    for (const [x, y] of turns[s.r]) {
      const col = s.bx + x;
      const j = s.bj + y;
      if (col < 0 || col >= W || j < -1 || j > ROWS - 1) return true;
      if (j >= 0 && occ[col][ROWS - j]) return true;
    }
    return false;
  };

  const minY = (r: number) => Math.min(...turns[r].map((c) => c[1]));
  const search = (start: State) => {
    if (blocked(start)) return null;
    const dist = new Map<number, number>([[key(start), 0]]);
    const from = new Map<number, { prev: State; move: Move }>();
    const open: { cost: number; s: State }[] = [{ cost: 0, s: start }];
    const closed = new Set<number>();
    while (open.length > 0) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k].cost < open[bi].cost) bi = k;
      const { cost, s } = open.splice(bi, 1)[0];
      const sk = key(s);
      if (closed.has(sk)) continue;
      closed.add(sk);
      if (goalKeys.has(sk)) {
        const moves: Move[] = [];
        let k = sk;
        let cur = s;
        while (from.has(k)) {
          const step = from.get(k)!;
          moves.push(step.move);
          cur = step.prev;
          k = key(cur);
        }
        return { goal: s, moves: moves.reverse() };
      }
      const low = 0.03 * Math.max(0, s.bj + 2);
      const next: [State, Move, number][] = [
        [{ bx: s.bx - 1, bj: s.bj, r: s.r }, "L", 1 + low],
        [{ bx: s.bx + 1, bj: s.bj, r: s.r }, "R", 1 + low],
        [{ bx: s.bx, bj: s.bj + 1, r: s.r }, "D", 0.35],
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
    const start: State = { bx: ref.bx + off, bj: -1 - minY(0), r: 0 };
    const found = search(start);
    if (found) return { start, goal: found.goal, moves: found.moves };
  }
  const start: State = { bx: ref.bx, bj: -1 - minY(ref.r), r: ref.r };
  const found = search(start);
  if (found) return { start, goal: found.goal, moves: found.moves };
  return { start: ref, goal: ref, moves: [] };
}

interface Palette {
  kinds: Record<Kind, string>;
  flash: string;
}

const PALETTES: Record<string, Record<Kind, string>> = {
  dark: { I: "#22d3ee", O: "#ffd23f", T: "#b565ff", S: "#3be07a", Z: "#ff4b4b", J: "#4f80ff", L: "#ff9a1f", x: "#8b949e" },
  light: { I: "#0aa6c7", O: "#e5a400", T: "#8f45e6", S: "#1fa648", Z: "#dc2f2f", J: "#2f5fe0", L: "#ee7c0a", x: "#7d8590" },
  neon: { I: "#23f0ff", O: "#fff04d", T: "#c68bff", S: "#39ff88", Z: "#ff4d6d", J: "#5a8cff", L: "#ffa11a", x: "#a08cc4" },
};

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  return (0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
}

function paletteFor(theme: Theme): Palette {
  const light = luminance(theme.surface) > 0.6;
  const kinds = PALETTES[theme.name === "neon" ? "neon" : light ? "light" : "dark"];
  return { kinds, flash: light ? theme.ink : "#ffffff" };
}

export function planTetris(ctx: GameContext, theme: Theme, layout: ReturnType<typeof arcadeLayout>): TetrisPlay {
  const { grid, rng } = ctx;
  const W = grid.width;
  const { pitch, cell: size } = layout;
  const pal = paletteFor(theme);
  const days: Block[] = [];
  const occ: (Block | null)[][] = Array.from({ length: W }, () => Array<Block | null>(ROWS + 2).fill(null));
  const heights: number[] = [];

  for (let c = 0; c < W; c++) {
    const col = grid.cells[c].filter((d): d is Cell => d !== null && d.level > 0).sort((a, b) => a.y - b.y);
    heights.push(col.length);
    col.forEach((cell, idx) => {
      const [x, y] = [layout.left + c * pitch, layout.top + cell.y * pitch];
      const fill = levelColor(theme, cell);
      const block: Block = { day: true, cell, c, p: col.length - idx, rest: col.length - idx, color: fill, track: new Track({ dy: 0, fill, opacity: 1 }, blockCss), x, y };
      days.push(block);
      occ[c][block.p] = block;
    });
  }

  const ops: Op[] = [];
  let cleared = 0;
  const completeRows = (): number => {
    let n = 0;
    for (let p = 1; p <= ROWS; p++) {
      if (occ.every((col) => col[p] !== null)) n++;
      else break;
    }
    return n;
  };
  const clearRows = (rows: number) => {
    const done: Block[] = [];
    const moved: Block[] = [];
    for (let c = 0; c < W; c++) {
      for (let p = 1; p <= rows; p++) done.push(occ[c][p]!);
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
    const cells = placement.cells.map(([c, r]): [number, number] => [c, ROWS - (r - cleared)]);
    let spawn: [number, number][];
    let n: number;
    if (filler) {
      const minC = Math.min(...cells.map((c) => c[0]));
      const minJ = Math.min(...cells.map((c) => c[1]));
      spawn = cells.map(([c, j]) => [c - minC, j - minJ]);
      n = Math.max(...spawn.flat()) + 1;
    } else {
      const shape = SHAPES[placement.kind as Exclude<Kind, "x">];
      spawn = shape.cells;
      n = shape.n;
    }
    const path = planPath(spawn, n, cells, occ, rng, !filler);
    const color = pal.kinds[placement.kind];
    const blocks = cells.map(([c, j]): Block => {
      const block: Block = {
        day: false,
        cell: null,
        c,
        p: ROWS - j,
        rest: ROWS - j,
        color,
        track: new Track({ dy: 0, fill: color, opacity: 1 }, blockCss),
        x: (c - path.goal.bx - (n - 1) / 2) * pitch - size / 2,
        y: (j - path.goal.bj - (n - 1) / 2) * pitch - size / 2,
      };
      occ[c][block.p] = block;
      return block;
    });
    ops.push({ type: "piece", kind: placement.kind, blocks, n, start: path.start, goal: path.goal, moves: path.moves, pose: null });
    const rows = completeRows();
    if (rows > 0) clearRows(rows);
  }

  const play: TetrisPlay = {
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
    days,
  };
  return play;
}

const TIMING = { spawn: 0.05, lateral: 0.04, rotate: 0.055, downBase: 0.05, downPer: 0.03, settle: 0.1, gap: 0.03 };
const sweepOf = (W: number) => Math.min(0.4, W * 0.0075);
const CLEAR_HOLD = 0.16;
const CLEAR_VANISH = 0.1;
const CLEAR_TAIL = 0.26;
const DROP_EASE = "cubic-bezier(.5,0,.9,.7)";

interface Segment {
  type: "lat" | "rot" | "down";
  n: number;
  dir: number;
}

function segments(moves: Move[]): Segment[] {
  const out: Segment[] = [];
  for (const m of moves) {
    const type = m === "L" || m === "R" ? "lat" : m === "D" ? "down" : "rot";
    const dir = m === "L" || m === "CCW" ? -1 : 1;
    const last = out[out.length - 1];
    if (type !== "rot" && last && last.type === type && last.dir === dir) last.n++;
    else out.push({ type, n: 1, dir });
  }
  return out;
}

function segmentSeconds(s: Segment, speed: number): number {
  if (s.type === "lat") return Math.min(0.18, TIMING.lateral * s.n) / speed;
  if (s.type === "rot") return TIMING.rotate / speed;
  return (TIMING.downBase + TIMING.downPer * s.n) / speed;
}

function pieceSeconds(op: PieceOp, speed: number): number {
  let t = TIMING.spawn / speed;
  for (const s of segments(op.moves)) t += segmentSeconds(s, speed);
  return t + (TIMING.settle + TIMING.gap) / speed;
}

const clearSeconds = (W: number) => sweepOf(W) + CLEAR_HOLD + CLEAR_VANISH + CLEAR_TAIL;

/** Gravity first: every column's days slide to the floor, bottom ones leading, the wave running left to right. */
function dropDays(play: TetrisPlay): number {
  const { pitch } = play.layout;
  let end = 0;
  for (const b of play.days) {
    const d = ROWS - b.cell!.y - b.rest;
    if (d <= 0) continue;
    const s = b.c * 0.024 + (b.rest - 1) * 0.02;
    const dur = 0.2 + 0.08 * Math.sqrt(d);
    b.track.tween(s, s + dur, { dy: d * pitch + 2 }, "cubic-bezier(.55,0,.85,.55)");
    b.track.tween(s + dur, s + dur + 0.07, { dy: d * pitch }, "ease-out");
    end = Math.max(end, s + dur + 0.07);
  }
  return end;
}

function pieceSpeedFactor(i: number, total: number): number {
  return 0.85 + (0.45 * i) / Math.max(1, total - 1);
}

/** Lays the plan out in time: pieces drop one after another and full rows sweep away. */
function schedule(play: TetrisPlay, theme: Theme, width: number): void {
  const { pitch, cell: size, left, top } = play.layout;
  const pal = paletteFor(theme);
  const W = width;
  const pieces = play.ops.filter((o): o is PieceOp => o.type === "piece");
  const start = play.gravityEnd > 0 ? play.gravityEnd + 0.3 : 0.3;
  const clearsTotal = play.ops.filter((o) => o.type === "clear").length * clearSeconds(W);
  const base = pieces.reduce((sum, op, i) => sum + pieceSeconds(op, pieceSpeedFactor(i, pieces.length)), 0);
  const free = Math.max(6, TARGET_PLAY - start - clearsTotal);
  const sp = Math.min(1.8, Math.max(0.75, base / free));

  let t = start;
  let linesTotal = 0;
  let index = 0;
  const S = sweepOf(W);
  for (const op of play.ops) {
    if (op.type === "piece") {
      const speed = sp * pieceSpeedFactor(index++, pieces.length);
      const n = op.n;
      const px = (bx: number) => left + (bx + (n - 1) / 2) * pitch + size / 2;
      const py = (bj: number) => top + (bj + (n - 1) / 2) * pitch + size / 2;
      const net = op.moves.reduce((sum, m) => sum + (m === "CW" ? 1 : m === "CCW" ? -1 : 0), 0);
      const pose = new Track<PoseState>({ x: px(op.start.bx), y: py(op.start.bj), rot: -net * 90, opacity: 0 }, poseCss);
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
      pose.tween(t, t + (TIMING.settle * 0.4) / speed, { y: rest + 1.8 }, "ease-out");
      pose.tween(t + (TIMING.settle * 0.4) / speed, t + TIMING.settle / speed, { y: rest }, "ease-in-out");
      t += (TIMING.settle + TIMING.gap) / speed;
      op.pose = pose;
    } else {
      const sweepEnd = t + S;
      const vanish = sweepEnd + CLEAR_HOLD;
      for (const b of op.cleared) {
        const ts = t + (b.c * S) / W;
        b.track.set(ts, { fill: pal.flash });
        b.track.tween(vanish, vanish + CLEAR_VANISH, { opacity: 0 });
        if (b.day) play.clears.push({ t: ts + 0.02, cell: b.cell! });
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

export function playTetris(ctx: GameContext): TetrisPlay {
  const layout = arcadeLayout(ctx.grid);
  const play = planTetris(ctx, ctx.theme, layout);
  play.gravityEnd = dropDays(play);
  schedule(play, ctx.theme, ctx.grid.width);
  const restore = PACE.hold + play.play;
  for (const b of play.days) {
    b.track.set(restore, { dy: 0, opacity: 0, fill: b.color });
    b.track.tween(restore + 0.002, restore + PACE.restore, { opacity: 1 });
  }
  return play;
}

function renderTetris(ctx: GameContext, play: TetrisPlay): GameOutput {
  const { theme, grid } = ctx;
  const { layout } = play;
  const W = grid.width;
  const shift = PACE.intro;
  const L = (s: number) => PACE.intro + s;
  const D = loopDuration(play.play);
  const restore = restoreAt(play.play);
  const tl = new Timeline(D, "t");
  const pal = paletteFor(theme);
  const eps = 0.001;
  const emit = (frames: Frame[]) => tl.track(frames.map(([t, css]): Frame => [t + shift, css]));

  const tiles: string[] = [];
  for (const col of grid.cells) {
    for (const c of col) if (c) tiles.push(cellRect(layout, c, theme.empty));
  }

  const dayEls = play.days.map((b) => cellRect(layout, b.cell!, b.color, `class="${emit(b.track.frames)}"`));

  const pieceEls: string[] = [];
  for (const op of play.ops) {
    if (op.type !== "piece") continue;
    const kids = op.blocks.map(
      (b) => `<use href="#tb" x="${fmt(b.x)}" y="${fmt(b.y)}" fill="${b.color}" class="${emit(b.track.frames)}"/>`,
    );
    pieceEls.push(`<g class="${emit(op.pose!.frames)}">${kids.join("")}</g>`);
  }

  const bands: string[] = [];
  const tetrisText = pixelText("TETRIS!", 3);
  const sweep = sweepOf(W);
  const fourRows = 4 * layout.pitch - layout.gap;
  for (const t0 of play.tetrises) {
    const at = t0 + sweep;
    const cls = tl.track([
      [0, "opacity:0"],
      [L(at), "opacity:0"],
      [L(at) + eps, "opacity:.55"],
      [L(at) + 0.3, "opacity:0"],
    ]);
    bands.push(
      `<rect class="${cls}" x="${fmt(layout.left)}" y="${fmt(layout.top + (ROWS - 4) * layout.pitch)}" width="${fmt(layout.gridWidth)}" height="${fmt(fourRows)}" rx="2" fill="${pal.flash}"/>`,
    );
    const blink: Frame[] = [[0, "opacity:0"]];
    for (let k = 0; k < 3; k++) {
      blink.push([L(at) + k * 0.3, "opacity:0"], [L(at) + k * 0.3 + eps, "opacity:1"], [L(at) + k * 0.3 + 0.18, "opacity:1"], [L(at) + k * 0.3 + 0.18 + eps, "opacity:0"]);
    }
    bands.push(
      `<path class="${tl.track(blink)}" d="${tetrisText.d}" transform="translate(${fmt(layout.left + layout.gridWidth / 2 - tetrisText.width / 2)} ${fmt(layout.top + ((ROWS - 4) * layout.pitch - tetrisText.height) / 2)})" fill="${theme.accent}"${glowAttr(theme)}/>`,
    );
  }

  const counter = linesReadout(tl, play, theme, restore);

  const text = banner(tl, {
    theme,
    lines: stageClearLines(grid),
    cx: layout.left + layout.gridWidth / 2,
    cy: layout.top + layout.gridHeight / 2,
    from: L(play.play) + 0.05,
    to: restore - 0.1,
  });
  const score = hud(tl, grid, {
    theme,
    title: "TETRIS",
    clears: play.clears.map((e) => ({ t: L(e.t), cell: e.cell })),
    resetAt: restore,
    width: layout.width,
  });

  const defs = [
    glowDefs(theme),
    `<g id="tb"><rect width="${layout.cell}" height="${layout.cell}" rx="2.4"/>` +
      `<path d="M1.4 1.4h9.2v2.2H1.4z" fill="#fff" fill-opacity=".42"/><path d="M1.4 3.6h2.2v7H1.4z" fill="#fff" fill-opacity=".22"/>` +
      `<path d="M3.6 10.6h7v-2.2h-7z" fill="#000" fill-opacity=".24"/><path d="M8.4 3.6h2.2v5h-2.2z" fill="#000" fill-opacity=".14"/></g>`,
  ].join("");

  return {
    width: layout.width,
    height: layout.height,
    css: tl.css(),
    defs,
    body: [...tiles, ...dayEls, counter, `<g${glowAttr(theme)}>${pieceEls.join("")}</g>`, ...bands, score, text].join(""),
  };
}

/** LINES counter under the graph, one opacity track per digit that is ever shown. */
function linesReadout(tl: Timeline, play: TetrisPlay, theme: Theme, restore: number): string {
  const scale = 2;
  const advance = 6 * scale;
  const label = pixelText("LINES", scale);
  const { layout } = play;
  const x = layout.left + layout.gridWidth - label.width - 3 * advance;
  const y = layout.top + layout.gridHeight + 12;
  const events = [{ t: 0, value: 0 }, ...play.lines.map((l) => ({ t: PACE.intro + l.t, value: l.total })), { t: restore, value: 0 }];
  const out: string[] = [`<path d="${label.d}" transform="translate(${fmt(x)} ${fmt(y)})" fill="${theme.muted}"/>`];
  const digitsX = x + label.width + advance;
  for (let pos = 0; pos < 2; pos++) {
    const shown = events.map((e) => ({ t: e.t, ch: pos === 0 && e.value < 10 ? " " : String(e.value).padStart(2, "0")[pos] }));
    const runs: { t: number; ch: string }[] = [];
    for (const s of shown) if (!runs.length || runs[runs.length - 1].ch !== s.ch) runs.push(s);
    for (const ch of new Set(runs.map((r) => r.ch).filter((c) => c !== " "))) {
      const glyph = pixelText(ch, scale);
      const frames: Frame[] = [];
      runs.forEach((r, i) => {
        if (i > 0) frames.push([r.t, runs[i - 1].ch === ch ? "opacity:1" : "opacity:0"]);
        frames.push([r.t, r.ch === ch ? "opacity:1" : "opacity:0"]);
      });
      out.push(`<path class="${tl.track(frames)}" d="${glyph.d}" transform="translate(${fmt(digitsX + pos * advance)} ${fmt(y)})" fill="${theme.ink}"/>`);
    }
  }
  return `<g class="lines">${out.join("")}</g>`;
}

export const tetris: Game = {
  id: "tetris",
  title: "Tetris",
  render(ctx) {
    return renderTetris(ctx, playTetris(ctx));
  },
};
