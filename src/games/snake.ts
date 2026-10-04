import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines } from "../kit.ts";
import type { ClearEvent } from "../kit.ts";
import { cellCenter, cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** Straight on first, so equally short routes come out with the fewest wiggles. */
const TURN_ORDER = [0, 1, 3];
/** The walkable area is the graph plus a one-cell lane on every side. */
const LANE = 1;
const GROWTH_SHARE = 1 / 3;
/** Long enough to read as a snake, short enough not to wall off the graph it is still eating. */
const MAX_LENGTH = 56;
const CANDIDATES = 12;

export interface SnakeEat {
  /** Index into `path` of the step that lands on the cell. */
  step: number;
  cell: Cell;
  /** False once the length cap is reached: the cell is eaten but no segment is added. */
  grew: boolean;
}

export interface SnakeSim {
  cols: number;
  rows: number;
  /** Head position after every step, as `y * cols + x` in lane-padded coordinates. Index 0 is the start. */
  path: number[];
  eats: SnakeEat[];
  /** Step on which the last cell is eaten. */
  playSteps: number;
  maxLength: number;
}

class Trapped extends Error {}

/**
 * Plays a whole game of snake on the graph. `coda` is asked how many extra
 * steps to keep moving once the last cell is gone, so the body never has to
 * pile up behind a head that has stopped.
 */
export function simulateSnake(grid: Grid, coda: (playSteps: number, eats: SnakeEat[]) => number = () => 0): SnakeSim {
  const cols = grid.width + 2 * LANE;
  const rows = grid.height + 2 * LANE;
  const total = cols * rows;
  const food = new Map<number, Cell>();
  for (const c of activeCells(grid)) food.set((c.y + LANE) * cols + c.x + LANE, c);

  let maxLength = Math.max(1, Math.min(MAX_LENGTH, Math.floor(total * GROWTH_SHARE)));
  const body = [0];
  const path = [0];
  const eats: SnakeEat[] = [];
  let lastDir = 0;
  let playSteps = 0;
  const stepLimit = total * 60;

  const dirOf = (from: number, to: number) => {
    const dx = (to % cols) - (from % cols);
    const dy = Math.floor(to / cols) - Math.floor(from / cols);
    return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
  };

  const advance = (to: number, grow: boolean) => {
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

  /**
   * Time-aware breadth-first search. A body cell is open to the head once the
   * snake will have moved on from it by the time the head arrives.
   */
  const explore = () => {
    const length = body.length;
    const occupant = new Int16Array(total).fill(-1);
    body.forEach((cell, i) => (occupant[cell] = i));
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
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (dist[n] >= 0) continue;
        const o = occupant[n];
        // The neck is never enterable on the first step: head and neck would swap places.
        if (o >= 0 && (t <= length - 1 - o || (o === 1 && t === 1))) continue;
        dist[n] = t;
        parent[n] = cur;
        heading[n] = d;
        queue.push(n);
      }
    }
    return { dist, parent, queue };
  };

  const routeTo = (parent: Int32Array, target: number) => {
    const route: number[] = [];
    for (let c = target; c !== body[0]; c = parent[c]) route.push(c);
    return route.reverse();
  };

  const reachesTail = (snake: number[]) => {
    if (snake.length < 3) return true;
    const blocked = new Uint8Array(total);
    for (const c of snake) blocked[c] = 1;
    const tail = snake[snake.length - 1];
    const tx = tail % cols;
    const ty = Math.floor(tail / cols);
    const seen = new Uint8Array(total);
    const stack = [snake[0]];
    seen[snake[0]] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      if (Math.abs(cx - tx) + Math.abs(cy - ty) === 1) return true;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
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
        const nx = (body[0] % cols) + DX[d];
        const ny = Math.floor(body[0] / cols) + DY[d];
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) return advance(ny * cols + nx, false);
      }
    }
    const { dist, parent } = explore();
    const tail = body[body.length - 1];
    if (dist[tail] > 0) return advance(routeTo(parent, tail)[0], false);
    // Unreachable tail: take any open neighbour rather than freeze.
    for (let k = 0; k < 4; k++) {
      const d = (lastDir + [0, 1, 3, 2][k]) % 4;
      const nx = (body[0] % cols) + DX[d];
      const ny = Math.floor(body[0] / cols) + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (dist[n] === 1) return advance(n, false);
    }
    throw new Trapped("snake has nowhere to go");
  };

  let stalled = 0;
  while (food.size > 0) {
    const { dist, parent, queue } = explore();
    let chosen: number[] | null = null;
    let fallback: number[] | null = null;
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
    // Growing into a corner is what traps a snake; after a long fruitless chase it stops growing.
    if (++stalled > total * 2) maxLength = Math.min(maxLength, body.length);
    chaseTail();
  }

  const extra = eats.length > 0 ? coda(playSteps, eats) : 0;
  for (let i = 0; i < extra; i++) chaseTail();
  return { cols, rows, path, eats, playSteps, maxLength };
}

const BODY = 13;
const OUTLINE = 1.5;
const HEAD = 16;
/** Width of the body towards the tail, one entry per half segment so the taper has no visible steps. */
const TAPER = [0.6, 0.64, 0.7, 0.76, 0.82, 0.88, 0.93, 0.97];
const POP = 0.22;
/** Share of the cells eaten before the snake speeds up. */
const SPEED_UP_AT = 0.55;
const SPEED_UP_RATIO = 0.55;
const MIN_STEP = 0.04;
/** Shortest game that still gets a second gear; below this the first one is already brisk. */
const MIN_PLAY_FOR_SPEED_UP = 10;
const EAT_HOLD = 0.15;
/** Glow rings around the body as (reach in glow radii past the outline, opacity), widest first. */
const HALO: [number, number][] = [
  [1.6, 0.07],
  [1.2, 0.08],
  [0.8, 0.09],
  [0.45, 0.1],
  [0.15, 0.12],
];
const EAT_FADE = 0.3;

interface Phase {
  /** Path step on which this speed starts. */
  from: number;
  /** Seconds per step. */
  s: number;
}

function snakeAngle(dir: number): number {
  return dir * 90;
}

/** Even hundredths so the half-step lag of the joints is still a whole hundredth. */
function roundStep(s: number): number {
  return Math.round(s * 50) / 50;
}

function planPhases(foodCount: number, sim: Pick<SnakeSim, "playSteps" | "eats">): Phase[] {
  const steps = sim.playSteps;
  const target = 20 + foodCount * 0.12;
  const raw = steps > 0 ? target / steps : 0.1;
  const s = Math.min(0.14, Math.max(0.06, roundStep(raw)));
  const boundary = sim.eats[Math.floor(sim.eats.length * SPEED_UP_AT)]?.step ?? steps;
  if (sim.eats.length < 8 || boundary >= steps || boundary * s < MIN_PLAY_FOR_SPEED_UP) return [{ from: 0, s }];
  const fast = Math.max(MIN_STEP, roundStep(s * SPEED_UP_RATIO));
  return fast >= s ? [{ from: 0, s }] : [{ from: 0, s }, { from: boundary, s: fast }];
}

function isDark(theme: Theme): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

function mixColors(a: string, b: string): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ra, ga, ba] = parse(a);
  const [rb, gb, bb] = parse(b);
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex((ra + rb) / 2)}${hex((ga + gb) / 2)}${hex((ba + bb) / 2)}`;
}

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark(theme);

  let phases: Phase[] = [{ from: 0, s: 0.1 }];
  const sim = simulateSnake(grid, (playSteps, eats) => {
    phases = planPhases(activeCells(grid).length, { playSteps, eats });
    return Math.ceil((PACE.hold + PACE.restore) / phases[phases.length - 1].s);
  });
  const hasPlay = sim.eats.length > 0;
  const lastStep = sim.path.length - 1;

  const starts: number[] = [PACE.intro];
  for (let j = 1; j < phases.length; j++) {
    starts[j] = starts[j - 1] + (phases[j].from - phases[j - 1].from) * phases[j - 1].s;
  }
  const atIn = (j: number, step: number) => starts[j] + (step - phases[j].from) * phases[j].s;
  const phaseOf = (step: number) => {
    let j = 0;
    while (j + 1 < phases.length && phases[j + 1].from <= step) j++;
    return j;
  };
  const at = (step: number) => atIn(phaseOf(step), step);

  const play = hasPlay ? Math.round((at(sim.playSteps) - PACE.intro) * 100) / 100 : 3;
  const duration = loopDuration(play);
  const tl = new Timeline(duration);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const jumpAt = Math.max(fadeEnd + 0.05, at(lastStep) + 0.02);

  const px = (id: number): [number, number] =>
    cellCenter(layout, (id % sim.cols) - LANE, Math.floor(id / sim.cols) - LANE);
  const dirs: number[] = [];
  for (let k = 1; k < sim.path.length; k++) {
    const a = sim.path[k - 1];
    const b = sim.path[k];
    const dx = (b % sim.cols) - (a % sim.cols);
    const dy = Math.floor(b / sim.cols) - Math.floor(a / sim.cols);
    dirs.push(dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3);
  }

  const moveFrames = (lo: number, hi: number, timeOf: (step: number) => number, stops: number[] = []): Frame[] => {
    const frames: Frame[] = [];
    for (let k = lo; k <= hi; k++) {
      if (k === lo || k === hi || dirs[k - 1] !== dirs[k] || stops.includes(k)) {
        frames.push([timeOf(k), translate(...px(sim.path[k]))]);
      }
    }
    return frames;
  };

  const startPos = px(sim.path[0]);
  const endPos = px(sim.path[lastStep]);
  const headFrames = moveFrames(0, lastStep, at, phases.slice(1).map((p) => p.from));
  headFrames.push([jumpAt, translate(...endPos)], [jumpAt, translate(...startPos)]);
  const headTrack = tl.keyframes(headFrames);
  const headPos = tl.useKeyframes(headTrack, 0);

  const startAngle = snakeAngle(dirs[0] ?? 0);
  let angle = startAngle;
  const turnFrames: Frame[] = [[0, `transform:rotate(${angle}deg)`]];
  for (let k = 1; k < lastStep; k++) {
    const turn = (dirs[k] - dirs[k - 1] + 4) % 4;
    if (turn === 0) continue;
    const j = phaseOf(k);
    turnFrames.push([at(k) - 0.3 * phases[j].s, `transform:rotate(${angle}deg)`]);
    angle += turn === 1 ? 90 : -90;
    turnFrames.push([at(k) + 0.3 * phases[j].s, `transform:rotate(${angle}deg)`]);
  }
  turnFrames.push([jumpAt, `transform:rotate(${angle}deg)`], [jumpAt, `transform:rotate(${startAngle}deg)`]);
  const headTurn = tl.track(turnFrames);

  const wiggleStart = PACE.intro + play + 0.05;
  const wiggleFrames: Frame[] = [[0, "transform:rotate(0deg)"]];
  if (hasPlay) {
    for (let k = 0; k < 8; k++) {
      wiggleFrames.push([wiggleStart + k * 0.13, `transform:rotate(${k % 2 === 0 ? -16 : 16}deg)`]);
    }
    wiggleFrames.push([wiggleStart + 8 * 0.13, "transform:rotate(0deg)"]);
  }
  const headWiggle = tl.track(wiggleFrames);

  // The jump back to the start happens while the snake is invisible; fading in only after it keeps the
  // head from crawling over the restored graph.
  const snakeFade = tl.track([
    [0, "opacity:1"],
    [restore - 0.4, "opacity:1"],
    [restore - 0.1, "opacity:0"],
    [jumpAt, "opacity:0"],
    [duration, "opacity:1"],
  ]);

  const growth = sim.eats.filter((e) => e.grew);
  const growTimes = growth.map((g) => at(g.step));
  const taperShape = (e: number) => (e < TAPER.length ? TAPER[e] : 1);
  const rim = dark ? theme.surface : theme.ink;
  const rimOpacity = dark ? 1 : 0.8;
  const fills = growth.map((g) => spriteColor(theme, g.cell));
  const fillOf = (i: number) => fills[i - 1];
  const jointOf = (i: number) => (i === 1 ? fills[0] : mixColors(fills[i - 2], fills[i - 1]));

  // The body is drawn as dashes of one stroked route through the cell centres, so it is an exact tube around
  // the path at every instant. Pieces that were slid along the path as separate shapes cut corners differently
  // depending on where they sat relative to the turn, and the corner pulsed as the snake moved.
  const pitch = Math.abs(px(1)[0] - px(0)[0]);
  const routeLength = lastStep * pitch;
  const corners: [number, number][] = [];
  for (let k = 0; k <= lastStep; k++) {
    if (k === 0 || k === lastStep || dirs[k - 1] !== dirs[k]) corners.push(px(sim.path[k]));
  }
  // Every leg is horizontal or vertical, so H and V keep the path short; it is repeated once per body piece.
  const pathOf = (points: [number, number][]) =>
    points
      .map(([x, y], i) => (i === 0 ? `M${fmt(x)} ${fmt(y)}` : y === points[i - 1][1] ? `H${fmt(x)}` : `V${fmt(y)}`))
      .join("");
  const forward = pathOf(corners);
  const backward = pathOf([...corners].reverse());
  const dash = pitch / 2;
  const gapTail = routeLength + 1000;
  // Each piece is its own copy of the route rather than a <use> of a shared one: Chrome restyles a <use>'s whole
  // cloned subtree whenever an inherited property such as the dash offset changes, which made the body several
  // times more expensive per frame than the copies are.
  const forwardPath = (attrs: string) =>
    `<path d="${forward}" fill="none" stroke-dasharray="${fmt(dash)} ${fmt(gapTail)}" stroke-linecap="round" stroke-linejoin="round" ${attrs}/>`;
  const backwardPath = (attrs: string) => `<path d="${backward}" fill="none" stroke-linejoin="round" ${attrs}/>`;

  // Head position in path steps. Pieces trail the head by whole and half steps, which is a distance along the
  // path rather than a time lag, so they stay right through the speed-up without a second copy of the body.
  const knots: [number, number][] = [[at(0), 0]];
  for (const p of phases.slice(1)) knots.push([at(p.from), p.from]);
  knots.push([at(lastStep), lastStep]);
  const headStep = (t: number) => {
    if (t <= knots[0][0]) return 0;
    for (let k = 1; k < knots.length; k++) {
      const [t1, s1] = knots[k];
      if (t > t1) continue;
      const [t0, s0] = knots[k - 1];
      return s0 + ((t - t0) / (t1 - t0)) * (s1 - s0);
    }
    return lastStep;
  };
  const grownBy = (t: number) => growTimes.filter((g) => g <= t).length;
  const vanish = fadeEnd + 0.01;
  const sampleTimes = (extra: number[]) =>
    [...new Set([0, ...knots.map((k) => k[0]), ...extra, fadeEnd, vanish])].filter((t) => t <= vanish).sort((a, b) => a - b);
  // At a growth instant the old and new state share a time, which the timeline plays as a jump.
  const statesAt = (t: number): number[] => {
    const m = grownBy(t);
    return growTimes[m - 1] === t ? [m - 1, m] : [m];
  };

  // The tail tapers and pops in as it grows, so its last few half segments are drawn one by one: slot e is
  // always the e-th half segment from the tail tip and takes over the piece that held slot e - 2 on each growth.
  const popEnds = growTimes.map((g, k) => Math.min(g + POP, growTimes[k + 1] ?? Infinity));
  const tailTimes = sampleTimes([...growTimes, ...popEnds]);
  const tailSlot = (e: number, size: number, color: (i: number) => string | null): string => {
    const frames: Frame[] = [];
    for (const t of tailTimes) {
      for (const m of statesAt(t)) {
        const i = m - Math.floor(e / 2);
        const offset = `stroke-dashoffset:${fmt(dash / 2 - (headStep(t) - (m - e / 2)) * pitch)}px`;
        const stroke = color(Math.max(i, 1));
        const paint = stroke ? `;stroke:${stroke}` : "";
        if (i < 1 || t >= vanish) {
          frames.push([t, `opacity:0;stroke-width:${fmt(size * 0.2)};${offset}${paint}`]);
          continue;
        }
        const g = growTimes[m - 1];
        const end = popEnds[m - 1];
        const f = t >= end ? 1 : (t - g) / (end - g);
        const from = e < 2 ? 0.2 : taperShape(e - 2);
        const opacity = e < 2 ? f : 1;
        frames.push([t, `opacity:${fmt(opacity)};stroke-width:${fmt(size * (from + (taperShape(e) - from) * f))};${offset}${paint}`]);
      }
    }
    return tl.track(frames);
  };
  const tailTube: string[] = [];
  const tailRim: string[] = [];
  if (growth.length > 0) {
    for (let e = 0; e < TAPER.length; e++) {
      tailTube.push(forwardPath(`class="${tailSlot(e, BODY, (i) => (e % 2 ? jointOf(i) : fillOf(i)))}"`));
      tailRim.push(forwardPath(`class="${tailSlot(e, BODY + 2 * OUTLINE, () => null)}" stroke="${rim}"`));
    }
  }

  // Ahead of the tail every piece is full width and keeps its colour. They all hang off one moving dash origin
  // at the head (the zero-length first dash leaves a dot there, which the head covers), so the only thing each
  // piece animates is the moment it joins. Pieces are stacked head over tail so each round cap overlaps the
  // piece behind, as the tail pieces do.
  const mainCount = (m: number) => Math.max(0, m - TAPER.length / 2);
  const mainTube: string[] = [];
  for (let i = mainCount(growth.length); i >= 1; i--) {
    const joins = growTimes[i + TAPER.length / 2 - 1];
    const shown = tl.track([
      [0, "opacity:0"],
      [joins, "opacity:0"],
      [joins, "opacity:1"],
      [fadeEnd, "opacity:1"],
      [vanish, "opacity:0"],
    ]);
    for (const [lag, color] of [[i, fillOf(i)], [i - 0.5, jointOf(i)]] as const) {
      const pattern = [0, lag * pitch - dash / 2, dash, gapTail].map(fmt).join(" ");
      mainTube.push(backwardPath(`class="${shown}" stroke="${color}" stroke-dasharray="${pattern}"`));
    }
  }

  // The outline is one colour under a group opacity, so ahead of the tail it can be a single stroke along the
  // reversed route whose dash starts at the head and grows by a step on every growth.
  const rimFrames = (m: number) =>
    `stroke-dasharray:${mainCount(m) > 0 ? fmt(mainCount(m) * pitch + dash / 2) : 0} ${fmt(gapTail)}`;
  const mainRim =
    mainCount(growth.length) > 0
      ? backwardPath(`class="${tl.track([
          [0, rimFrames(0)],
          ...growTimes.flatMap((g, k): Frame[] => [[g, rimFrames(k)], [g, rimFrames(k + 1)]]),
          [fadeEnd, rimFrames(growth.length)],
          [vanish, rimFrames(0)],
        ])}" stroke="${rim}" stroke-width="${BODY + 2 * OUTLINE}"`)
      : "";
  // A blur filter over the body would cover the whole route's bounding box and be redrawn every frame, so the
  // body glows with two soft-edged wide strokes instead and only the small head keeps the real filter.
  const haloFrames = (m: number, opacity: number) =>
    `opacity:${m > 0 ? opacity : 0};stroke-dasharray:${fmt(Math.max(0, m - 2.5) * pitch)} ${fmt(gapTail)}`;
  const halos =
    theme.glow > 0 && growth.length > 0
      ? HALO.map(([reach, opacity]) =>
            backwardPath(
              `class="${tl.track([
                [0, haloFrames(0, opacity)],
                ...growTimes.flatMap((g, k): Frame[] => [[g, haloFrames(k, opacity)], [g, haloFrames(k + 1, opacity)]]),
                [fadeEnd, haloFrames(growth.length, opacity)],
                [vanish, haloFrames(0, opacity)],
              ])}" stroke="${theme.sprites[1]}" stroke-linecap="round" stroke-width="${fmt(BODY + 2 * (OUTLINE + reach * theme.glow))}"`,
            ),
          )
          .join("")
      : "";
  const followHead = tl.keyframes(
    sampleTimes([]).map((t): Frame => [t, `stroke-dashoffset:${fmt((headStep(t) - lastStep) * pitch)}px`]),
  );
  const mainGroup = (inner: string) => (inner ? `<g class="${tl.useKeyframes(followHead, 0)}">${inner}</g>` : "");

  const baseCells: string[] = [];
  const foodCells: string[] = [];
  const pops: string[] = [];
  const eatTime = new Map<Cell, number>();
  for (const e of sim.eats) eatTime.set(e.cell, at(e.step));
  // Pops are short and never many at once, so a few shared elements play all of them in turn: every element
  // on the page costs style work on every frame, even while it sits invisible between its moments.
  const popSlots: { free: number; frames: Frame[]; x: number; y: number }[] = [];
  const popLook = (x: number, y: number, s: number, o: number) => `opacity:${o};${translate(x, y, `scale(${s})`)}`;
  const addPop = (te: number, x: number, y: number) => {
    let slot = popSlots.find((p) => p.free <= te);
    if (!slot) {
      slot = { free: 0, frames: [[0, popLook(x, y, 2.3, 0)]], x, y };
      popSlots.push(slot);
    }
    slot.frames.push(
      [te, popLook(slot.x, slot.y, 2.3, 0)],
      [te, popLook(x, y, 0.6, 1)],
      [te + EAT_HOLD, popLook(x, y, 1, 1)],
      [te + EAT_HOLD + EAT_FADE, popLook(x, y, 2.3, 0)],
    );
    Object.assign(slot, { free: te + EAT_HOLD + EAT_FADE, x, y });
  };
  const bigTrack = tl.keyframes([
    [0, "opacity:1;transform:scale(.5)"],
    [0.2, "opacity:1;transform:scale(1.4)"],
    [0.7, "opacity:0;transform:scale(3.2)"],
  ]);
  const lastEat = sim.eats[sim.eats.length - 1]?.cell;
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      baseCells.push(cellRect(layout, cell, theme.empty));
      if (cell.level === 0) continue;
      const te = eatTime.get(cell);
      const fill = levelColor(theme, cell);
      if (te === undefined) {
        foodCells.push(cellRect(layout, cell, fill));
        continue;
      }
      const cls = tl.track([
        [0, "opacity:1"],
        [te, "opacity:1"],
        [te, "opacity:0"],
        [restore, "opacity:0"],
        [restore + PACE.restore, "opacity:1"],
      ]);
      foodCells.push(cellRect(layout, cell, fill, `class="${cls}"`));
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      if (cell !== lastEat) {
        addPop(te, cx, cy);
        continue;
      }
      pops.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><use class="${tl.useKeyframes(bigTrack, te)}" href="#pop-big"/></g>`);
    }
  }

  for (const slot of [...popSlots].sort((a, b) => a.free - b.free)) {
    pops.push(`<use class="${tl.track(slot.frames)}" href="#pop"/>`);
  }

  const spark = (n: number, radius: number, size: number) =>
    Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2 + 0.3;
      const fill = k % 2 ? theme.accent : flash;
      return `<circle cx="${fmt(Math.cos(a) * radius)}" cy="${fmt(Math.sin(a) * radius)}" r="${size}" fill="${fill}"/>`;
    }).join("");
  const flash = dark ? "#ffffff" : theme.accent;
  const defs =
    glowDefs(theme) +
    `<g id="pop"><circle r="7" fill="none" stroke="${flash}" stroke-width="1.4"/>${spark(8, 7, 1.7)}</g>` +
    `<g id="pop-big"><circle r="8" fill="none" stroke="${flash}" stroke-width="2"/><circle r="5" fill="none" stroke="${theme.accent}" stroke-width="2"/>${spark(12, 8, 2.1)}</g>`;

  const clears: ClearEvent[] = sim.eats.map((e) => ({ t: at(e.step), cell: e.cell }));
  const bar = hud(tl, grid, { theme, title: "SNAKE", clears, resetAt: restore, width });
  const end = hasPlay
    ? banner(tl, {
        theme,
        lines: stageClearLines(grid),
        cx: width / 2,
        cy: layout.top + layout.gridHeight / 2,
        from: PACE.intro + play + 0.1,
        to: restore,
      })
    : "";

  const head = `<g class="${headPos}"${glowAttr(theme)}><g class="${headTurn}"><g class="${headWiggle}">
<rect x="${-HEAD / 2}" y="${-HEAD / 2}" width="${HEAD}" height="${HEAD}" rx="${HEAD * 0.42}" fill="${theme.accent}" stroke="${rim}" stroke-opacity="${rimOpacity}" stroke-width="${OUTLINE}"/>
<circle cx="2.6" cy="-3.4" r="2.4" fill="#fff"/><circle cx="2.6" cy="3.4" r="2.4" fill="#fff"/>
<circle cx="3.4" cy="-3.4" r="1.2" fill="#111"/><circle cx="3.4" cy="3.4" r="1.2" fill="#111"/>
<path d="M7.5 0H11.5M11.5 0l2.4-1.8M11.5 0l2.4 1.8" stroke="#e5484d" stroke-width="1.2" stroke-linecap="round" fill="none" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.55;.6;.8;.85" dur="1.4s" repeatCount="indefinite"/></path>
</g></g></g>`;

  const bodyMarkup = [
    `<g>${baseCells.join("")}</g>`,
    `<g>${foodCells.join("")}</g>`,
    `<g class="${snakeFade}">${mainGroup(halos)}<g opacity="${rimOpacity}">${tailRim.join("")}${mainGroup(mainRim)}</g>` +
      `${tailTube.join("")}<g stroke-width="${BODY}" stroke-linecap="round">${mainGroup(mainTube.join(""))}</g>${head}</g>`,
    `<g>${pops.join("")}</g>`,
    bar,
    end,
  ].join("\n");
  return { width, height, css: tl.css(), defs, body: bodyMarkup };
}

export const snake: Game = { id: "snake", title: "Snake", render };
