import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid } from "../grid.ts";
import { cellCenter, cellRect, levelColor, makeLayout } from "../svg.ts";
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
export function simulateSnake(grid: Grid, coda: (playSteps: number) => number = () => 0): SnakeSim {
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

  const extra = eats.length > 0 ? coda(playSteps) : 0;
  for (let i = 0; i < extra; i++) chaseTail();
  return { cols, rows, path, eats, playSteps, maxLength };
}

const BODY = 11;
const OUTLINE = 1.2;
const HEAD = 13;
const TAPER = [0.6, 0.72, 0.84, 0.93];
const POP = 0.22;

function snakeAngle(dir: number): number {
  return dir * 90;
}

function stepSeconds(foodCount: number, steps: number): number {
  const target = 20 + foodCount * 0.12;
  const raw = steps > 0 ? target / steps : 0.1;
  // Even hundredths so the half-step lag of the joints is still a whole hundredth.
  return Math.round(Math.min(0.14, Math.max(0.06, raw)) * 50) / 50;
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
  const at = (step: number) => PACE.intro + step * s;

  const px = (id: number): [number, number] => {
    const [x, y] = cellCenter(layout, (id % sim.cols) - LANE, Math.floor(id / sim.cols) - LANE);
    return [x, y];
  };
  const dirs: number[] = [];
  for (let k = 1; k < sim.path.length; k++) {
    const a = sim.path[k - 1];
    const b = sim.path[k];
    const dx = (b % sim.cols) - (a % sim.cols);
    const dy = Math.floor(b / sim.cols) - Math.floor(a / sim.cols);
    dirs.push(dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3);
  }

  const startPos = px(sim.path[0]);
  const headFrames: Frame[] = [[PACE.intro, translate(...startPos)]];
  const turnFrames: Frame[] = [];
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

  const wiggleFrames: Frame[] = [];
  const wiggleStart = PACE.intro + play + 0.05;
  for (let k = 0; k < 8; k++) {
    wiggleFrames.push([wiggleStart + k * 0.13, `transform:rotate(${k % 2 === 0 ? -16 : 16}deg)`]);
  }
  wiggleFrames.push([wiggleStart + 8 * 0.13, "transform:rotate(0deg)"]);
  const headWiggle = tl.track(hasPlay ? [[0, "transform:rotate(0deg)"], ...wiggleFrames] : [[0, "transform:rotate(0deg)"]]);

  const blink: Frame[] = [[0, "opacity:1"]];
  if (hasPlay) {
    for (let k = 0; k < 3; k++) {
      const t = PACE.intro + play + 0.1 + k * 0.36;
      blink.push([t, "opacity:1"], [t + 0.12, "opacity:.3"], [t + 0.24, "opacity:1"]);
    }
  }
  blink.push([restore, "opacity:1"], [fadeEnd, "opacity:0"], [duration - 0.3, "opacity:0"], [duration, "opacity:1"]);
  const snakeFade = tl.track(blink);

  const growth = sim.eats.filter((e) => e.grew);
  const growTime = (m: number) => at(growth[m - 1].step);
  const taperShape = (j: number) => (j < TAPER.length ? TAPER[j] : 1);
  const dark = isDark(theme);
  const rim = dark ? theme.ink : "#000";
  const tube: string[] = [];
  const shadow: string[] = [];
  for (let i = growth.length; i >= 1; i--) {
    const frames: Frame[] = [[0, "opacity:0;transform:scale(.2)"]];
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
    const piece = (cls: string, size: number, color: string) =>
      `<g class="${cls}"><rect class="${look}" x="${fmt(-size / 2)}" y="${fmt(-size / 2)}" width="${size}" height="${size}" rx="${fmt(size * 0.3)}" fill="${color}"/></g>`;
    tube.push(piece(pos, BODY, fill), piece(bridge, BODY, joint));
    shadow.push(piece(pos, BODY + 2 * OUTLINE, rim), piece(bridge, BODY + 2 * OUTLINE, rim));
  }

  const baseCells: string[] = [];
  const foodCells: string[] = [];
  const eatTime = new Map<Cell, number>();
  for (const e of sim.eats) eatTime.set(e.cell, at(e.step));
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
      const rest = `fill:${fill};opacity:1;transform:scale(1)`;
      const cls = tl.track([
        [0, rest],
        [te - 0.6 * s, rest],
        [te - 0.1 * s, `fill:${theme.accent};opacity:1;transform:scale(1.25)`],
        [te + 0.5 * s, `fill:${theme.accent};opacity:0;transform:scale(1.9)`],
        [restore, `fill:${fill};opacity:0;transform:scale(1)`],
        [restore + PACE.restore, rest],
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

  const css = `.c{transform-box:fill-box;transform-origin:center}\n${tl.css()}`;
  const bodyMarkup = [
    `<g>${baseCells.join("")}</g>`,
    `<g>${foodCells.join("")}</g>`,
    `<g class="${snakeFade}"><g opacity="${dark ? 0.5 : 0.6}">${shadow.join("")}</g>${tube.join("")}${head}</g>`,
  ].join("\n");
  return { width, height, css, body: bodyMarkup };
}

export const snake: Game = { id: "snake", title: "Snake", render };
