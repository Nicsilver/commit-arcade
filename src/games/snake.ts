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
  const growTime = (m: number) => at(growth[m - 1].step);
  const taperShape = (e: number) => (e < TAPER.length ? TAPER[e] : 1);
  const rim = dark ? theme.surface : theme.ink;
  const rimOpacity = dark ? 1 : 0.8;

  // The body is drawn as short dashes of one stroked route through the cell centres, so it is an exact tube
  // around the path at every instant. Pieces that were slid along the path as separate shapes cut corners
  // differently depending on where they sat relative to the turn, and the corner pulsed as the snake moved.
  const pitch = Math.abs(px(1)[0] - px(0)[0]);
  const reach = Math.ceil(lastStep * pitch) + pitch;
  const route: string[] = [];
  for (let k = 0; k <= lastStep; k++) {
    if (k === 0 || k === lastStep || dirs[k - 1] !== dirs[k]) {
      const [x, y] = px(sim.path[k]);
      route.push(`${route.length ? "L" : "M"}${fmt(x)} ${fmt(y)}`);
    }
  }
  const dash = pitch / 2;
  // A dash starts at -offset along the route; the gap is longer than the route so the pattern never repeats.
  const along = (steps: number) => `stroke-dashoffset:${fmt(dash / 2 - steps * pitch)}px`;

  // Each speed gets its own copy of the body. Segment i trails the head by i steps, which is a fixed time lag
  // only while the speed is constant, so a copy is shown for exactly the stretch its lag is right for.
  const copies = phases.map((phase, j) => {
    const lo = j === 0 ? 0 : Math.max(0, phase.from - growth.length - 2);
    const hi = j + 1 < phases.length ? phases[j + 1].from : lastStep;
    const tLo = atIn(j, lo);
    const frames: Frame[] =
      tLo >= 0
        ? [[tLo, along(lo)], [atIn(j, hi), along(hi)]]
        : [[0, along(lo - tLo / phase.s)], [atIn(j, hi), along(hi)]];
    return { track: tl.keyframes(frames), s: phase.s };
  });
  const gates = copies.map((_, j) => {
    if (copies.length === 1) return "";
    const switchAt = starts[1];
    return tl.track(
      j === 0
        ? [[0, "opacity:1"], [switchAt, "opacity:1"], [switchAt, "opacity:0"]]
        : [[0, "opacity:0"], [switchAt, "opacity:0"], [switchAt, "opacity:1"]],
    );
  });

  const tube: string[][] = copies.map(() => []);
  const shadow: string[][] = copies.map(() => []);
  for (let i = growth.length; i >= 1; i--) {
    // Half segment `e` counts from the tail tip: a piece's own centre is even, the bridge towards the head odd.
    const look = (size: number, odd: number) => {
      const width = (scale: number) => `stroke-width:${fmt(size * scale)}`;
      const frames: Frame[] = [[0, `opacity:0;${width(0.2)}`]];
      for (let j = 0; 2 * j <= TAPER.length; j++) {
        const m = i + j;
        if (m > growth.length) break;
        const start = growTime(m);
        const next = m + 1 <= growth.length ? growTime(m + 1) : Infinity;
        const end = Math.min(start + POP, next);
        const from = j === 0 ? `opacity:0;${width(0.2)}` : `opacity:1;${width(taperShape(2 * j - 2 + odd))}`;
        frames.push([start, from], [end, `opacity:1;${width(taperShape(2 * j + odd))}`]);
      }
      frames.push([fadeEnd, frames[frames.length - 1][1]], [fadeEnd + 0.01, "opacity:0"]);
      return tl.track(frames);
    };
    const looks = [look(BODY, 0), look(BODY, 1), look(BODY + 2 * OUTLINE, 0), look(BODY + 2 * OUTLINE, 1)];
    const fill = spriteColor(theme, growth[i - 1].cell);
    const joint = i === 1 ? fill : mixColors(spriteColor(theme, growth[i - 2].cell), fill);
    copies.forEach((copy, j) => {
      const pos = tl.useKeyframes(copy.track, i * copy.s);
      const bridge = tl.useKeyframes(copy.track, (i - 0.5) * copy.s);
      const piece = (look: string, cls: string, color: string) =>
        `<g class="${look}"><use class="${cls}" href="#body-route" stroke="${color}"/></g>`;
      tube[j].push(piece(looks[0], pos, fill), piece(looks[1], bridge, joint));
      shadow[j].push(piece(looks[2], pos, rim), piece(looks[3], bridge, rim));
    });
  }
  const gated = (parts: string[][]) =>
    parts.map((p, j) => (gates[j] ? `<g class="${gates[j]}">${p.join("")}</g>` : p.join(""))).join("");
  const dashing = `stroke-dasharray="${fmt(dash)} ${reach}"`;

  const baseCells: string[] = [];
  const foodCells: string[] = [];
  const pops: string[] = [];
  const eatTime = new Map<Cell, number>();
  for (const e of sim.eats) eatTime.set(e.cell, at(e.step));
  const popFrames: Frame[] = [
    [0, "opacity:1;transform:scale(.6)"],
    [EAT_HOLD, "opacity:1;transform:scale(1)"],
    [EAT_HOLD + EAT_FADE, "opacity:0;transform:scale(2.3)"],
  ];
  const popTrack = tl.keyframes(popFrames);
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
      const big = cell === lastEat;
      const pop = tl.useKeyframes(big ? bigTrack : popTrack, te);
      pops.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><use class="${pop}" href="#${big ? "pop-big" : "pop"}"/></g>`);
    }
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
    (growth.length > 0 ? `<path id="body-route" d="${route.join("")}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : "") +
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

  const head = `<g class="${headPos}"><g class="${headTurn}"><g class="${headWiggle}">
<rect x="${-HEAD / 2}" y="${-HEAD / 2}" width="${HEAD}" height="${HEAD}" rx="${HEAD * 0.42}" fill="${theme.accent}" stroke="${rim}" stroke-opacity="${rimOpacity}" stroke-width="${OUTLINE}"/>
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
    end,
  ].join("\n");
  return { width, height, css: tl.css(), defs, body: bodyMarkup };
}

export const snake: Game = { id: "snake", title: "Snake", render };
