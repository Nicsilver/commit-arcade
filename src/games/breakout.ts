import { Timeline, fmt, translate, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { activeCells, allCells, type Cell, type Grid } from "../grid.ts";
import type { Rng } from "../rng.ts";
import type { Theme } from "../theme.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { cellRect, levelColor, type Layout } from "../svg.ts";

const BALL_R = 4;
const PADDLE_HALF = 30;
const PADDLE_H = 8;
const VOID = 40;
const MAX_TILT = (56 * Math.PI) / 180;
/** Smallest share of the speed that must point up or down, so rallies never go near-horizontal. */
const MIN_VERTICAL = 0.5;
/** Share of bricks left at which the fireball power-up kicks in. */
const FIRE_SHARE = 0.35;

/** The physics runs at a fixed speed and dt; the finished play is then retimed to a pace that fits the loop. */
const SIM_SPEED = 600;
const SIM_DT = 1 / 720;
const TARGET_PLAY = 36;
const MIN_SPEED = 330;
const MAX_SPEED = 800;
/** The ball speeds up as the board empties, like the arcade original. */
const RAMP_FROM = 0.8;
const RAMP_TO = 1.3;
/** Once this share of the bricks is gone the ball keeps accelerating so the last few don't drag. */
const RUSH_FROM = 0.7;
const RUSH_EXTRA = 1.6;
/** Fastest the ball may travel on screen, in px/s. */
const RUSH_CAP = 1250;

const WALL = 1;
const PADDLE = 2;

interface Court {
  cols: number;
  rows: number;
  left: number;
  top: number;
  pitch: number;
  cell: number;
  fieldL: number;
  fieldR: number;
  fieldT: number;
  padTop: number;
  startX: number;
}

function makeCourt(grid: Grid, layout: Layout): Court {
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
    startX: Math.round((fieldL + fieldR) / 2),
  };
}

export interface BrickHit {
  cell: Cell;
  /** Seconds after the serve. */
  t: number;
  /** True when this hit removed the brick. */
  final: boolean;
}

export interface BreakoutPlay {
  court: Court;
  hits: BrickHit[];
  /** Ball centre at every bounce, seconds after the serve. */
  ball: [t: number, x: number, y: number][];
  /** Paddle centre at every moment the ball touched it. */
  contacts: { t: number; x: number }[];
  fire: { t: number; x: number; y: number } | null;
  /** Seconds from the serve until the ball is back on the paddle with the board cleared. */
  length: number;
}

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Outcome {
  progress: boolean;
  time: number;
  nextX: number;
  destroyed: number;
  hits: number;
}

/** Plays the whole game out at SIM_SPEED. Times in the result are seconds after the serve. */
export function simulateBreakout(grid: Grid, layout: Layout, rng: Rng): BreakoutPlay {
  const court = makeCourt(grid, layout);
  const { rows, left, top, pitch, cell, fieldL, fieldR, fieldT, padTop } = court;
  const cells = activeCells(grid);
  const hp = new Uint8Array(grid.width * rows);
  const ghost = new Int32Array(grid.width * rows);
  for (const c of cells) hp[c.x * rows + c.y] = c.level >= 3 ? 2 : 1;
  const byIndex = new Map<number, Cell>(cells.map((c) => [c.x * rows + c.y, c]));

  const play: BreakoutPlay = { court, hits: [], ball: [], contacts: [], fire: null, length: 0 };
  const startY = padTop - BALL_R;
  if (cells.length === 0) {
    play.ball.push([0, court.startX, startY]);
    return play;
  }

  let alive = cells.length;
  const fireBelow = alive >= 2 ? Math.max(1, Math.floor(alive * FIRE_SHARE)) : 0;
  let flame = false;
  let stamp = -1;
  const touched: number[] = [];

  function advance(b: Ball, burning: boolean, virtual: boolean): number {
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
        // Squeezed between two bricks: bounce straight back the way it came.
        b.x = px;
        b.y = py;
        b.vx = -b.vx;
        b.vy = -b.vy;
      } else {
        if (signX !== 0) b.vx = signX * Math.abs(b.vx);
        if (signY !== 0) b.vy = signY * Math.abs(b.vy);
      }
    }
    if (flags !== 0 || (touched.length > 0 && !burning)) keepSteep(b);
    if (b.vy > 0 && b.y + BALL_R >= padTop) flags |= PADDLE;
    return flags;
  }

  function keepSteep(b: Ball) {
    if (Math.abs(b.vy) >= MIN_VERTICAL * SIM_SPEED) return;
    b.vy = (b.vy < 0 ? -1 : 1) * MIN_VERTICAL * SIM_SPEED;
    b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(SIM_SPEED * SIM_SPEED - b.vy * b.vy);
  }

  function launch(b: Ball, off: number) {
    const angle = off * MAX_TILT;
    b.vx = SIM_SPEED * Math.sin(angle);
    b.vy = -SIM_SPEED * Math.cos(angle);
  }

  // Looks ahead from a paddle contact: where the ball goes next and where it lands again.
  function evaluate(bx: number, off: number): Outcome {
    stamp++;
    const b: Ball = { x: bx, y: startY, vx: 0, vy: 0 };
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

  const excess = (speed: number) => Math.max(0, speed / SIM_SPEED - 0.6);

  // Picks the paddle offset whose bounce makes progress soonest while keeping the paddle's own travel reasonable.
  function plan(t: number, bx: number, first: boolean): { off: number; px: number } {
    for (const offsets of [coarse, fine]) {
      let best: { off: number; px: number } | null = null;
      let bestScore = Infinity;
      for (const off of offsets) {
        const px = first ? court.startX : bx - off * PADDLE_HALF;
        if (px < fieldL + PADDLE_HALF || px > fieldR - PADDLE_HALF) continue;
        const o = evaluate(bx, off);
        if (!o.progress) continue;
        const now = first ? 0 : Math.abs(px - paddleX) / Math.max(t - lastContact - 0.06, 0.04);
        const next = Math.max(0, Math.abs(o.nextX - px) - 0.7 * PADDLE_HALF) / Math.max(o.time - 0.06, 0.05);
        let score = 3 * excess(now) + 3 * excess(next) + rng() * 0.1;
        score += o.time / Math.max(1, flame ? o.destroyed : o.hits);
        if (Math.abs(off) < 0.12) score += 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = { off, px };
        }
      }
      if (best) return best;
    }
    const off = (rng() - 0.5) * 1.4;
    return { off, px: Math.min(Math.max(first ? court.startX : bx - off * PADDLE_HALF, fieldL + PADDLE_HALF), fieldR - PADDLE_HALF) };
  }

  const ball: Ball = { x: court.startX, y: startY, vx: 0, vy: 0 };
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
        const cellHit = byIndex.get(idx)!;
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

export interface PlayClock {
  /** Maps seconds after the serve in the sim to seconds after the serve in the finished animation. */
  at(t: number): number;
  length: number;
  /** Ball speed in px/s at the start and end of the play. */
  speeds: [number, number];
}

/** Stretches the sim so the play lasts about TARGET_PLAY seconds; the pace changes only when the paddle hits the ball. */
export function pacePlay(sim: BreakoutPlay): PlayClock {
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
    base = Math.min(MAX_SPEED, Math.max(MIN_SPEED, (SIM_SPEED * sum[sum.length - 1]) / TARGET_PLAY));
  }
  factors = raw.map((f) => Math.min(f, RUSH_CAP / base));
  const unscaled: number[] = [0];
  for (let i = 1; i < breaks.length; i++) unscaled.push(unscaled[i - 1] + (breaks[i] - breaks[i - 1]) / factors[i - 1]);
  const stretch = SIM_SPEED / base;
  const at = (t: number) => {
    let lo = 0;
    let hi = breaks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (breaks[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const f = factors[Math.min(lo, factors.length - 1)];
    return (unscaled[lo] + (t - breaks[lo]) / f) * stretch;
  };
  return { at, length: at(sim.length), speeds: [base * factors[0], base * factors[factors.length - 1]] };
}

const FLASH_TIME = 0.08;
const CHIP_LIFE = 0.6;
const CHIP_GROUPS = 30;
const CHIP_GRAVITY = 300;
const EMBERS = ["#ffd23f", "#ff9a2a"];

interface Chip {
  vx: number;
  vy: number;
  size: number;
  spin: number;
  /** Sparks use the flash colour instead of the brick's. */
  spark: boolean;
}

const CHIPS: Chip[] = [
  { vx: -34, vy: -66, size: 4.8, spin: -260, spark: false },
  { vx: 38, vy: -72, size: 4.8, spin: 300, spark: false },
  { vx: -56, vy: -24, size: 5, spin: -180, spark: false },
  { vx: 58, vy: -28, size: 5, spin: 220, spark: false },
  { vx: -16, vy: -90, size: 4.2, spin: 340, spark: false },
  { vx: 20, vy: -84, size: 4.2, spin: -320, spark: false },
  { vx: -44, vy: -48, size: 2.8, spin: 0, spark: true },
  { vx: 46, vy: -54, size: 2.8, spin: 0, spark: true },
];

/** Keyframes for one chip's flight, relative to the group it sits in. `life` is the whole cycle. */
function chipKeyframes(name: string, c: Chip, life: number): string {
  const steps = 7;
  const out: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const u = (k / steps) * life;
    const fade = Math.min(1, (life - u) / (life * 0.5));
    const x = c.vx * u;
    const y = c.vy * u + 0.5 * CHIP_GRAVITY * u * u;
    out.push(`${Math.round((k / steps) * 1e5) / 1e3}%{opacity:${fmt(fade)};transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(c.spin * u)}deg) scale(${fmt(0.55 + 0.45 * fade)})}`);
  }
  return `@keyframes ${name}{${out.join("")}}`;
}

/**
 * One-shot effects share a few elements instead of one each: every slot plays
 * its events back to back on a single keyframe track, parked invisible in
 * between, so the browser has far fewer infinite animations to service.
 * Events must be added in start order; a slot is only reused for the same key.
 */
class Pool {
  private readonly slots: { key: string; end: number; frames: Frame[] }[] = [];
  private readonly idle: string;

  constructor(idle: string) {
    this.idle = idle;
  }

  add(key: string, start: number, end: number, frames: Frame[]): void {
    let slot = this.slots.find((s) => s.key === key && s.end <= start);
    if (!slot) {
      slot = { key, end: 0, frames: [[0, this.idle]] };
      this.slots.push(slot);
    }
    slot.frames.push([start, this.idle], ...frames, [end, this.idle]);
    slot.end = end;
  }

  markup(tl: Timeline, draw: (key: string, cls: string) => string): string {
    return this.slots.map((s) => draw(s.key, tl.track(s.frames))).join("");
  }
}

/** Crack lines across a 12 px brick, three variants so neighbours don't match. */
const CRACKS = [
  [[7, 0], [4.5, 4], [7.5, 6.5], [4, 9], [6, 12]],
  [[3, 0], [6, 3.5], [4, 6], [8, 8.5], [7, 12]],
  [[9, 0], [6, 3], [8.5, 6], [5, 8.5], [3.5, 12]],
];

function smoothGlide(t0: number, x0: number, t1: number, x1: number): [number, number][] {
  const out: [number, number][] = [[t0, x0]];
  if (t1 - t0 > 0.22 && x0 !== x1) {
    for (const f of [0.25, 0.5, 0.75]) {
      const e = f * f * (3 - 2 * f);
      out.push([t0 + (t1 - t0) * f, x0 + (x1 - x0) * e]);
    }
  }
  out.push([t1, x1]);
  return out;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return x < 0 ? -y : y;
}

/**
 * A static glow for a line, as stacked translucent strokes instead of a blur
 * filter. A filter over a path that spans the whole field is blurred again on
 * every frame of the animation, which costs far more than a few plain strokes.
 * Layer opacities follow the profile a Gaussian blur gives a line of this width.
 */
function haloStrokes(d: string, color: string, width: number, sigma: number): string {
  const profile = (dist: number) => 0.5 * (erf((dist + width / 2) / (sigma * Math.SQRT2)) - erf((dist - width / 2) / (sigma * Math.SQRT2)));
  const step = Math.max(0.35, sigma / 3.2);
  const targets: number[] = [];
  for (let j = 1; ; j++) {
    const t = profile(width / 2 + (j - 0.5) * step);
    if (t < 0.01) break;
    targets.push(t);
  }
  const out: string[] = [];
  for (let j = targets.length - 1; j >= 0; j--) {
    const outer = j + 1 < targets.length ? targets[j + 1] : 0;
    const alpha = 1 - (1 - targets[j]) / (1 - outer);
    const stroke = fmt(width + 2 * (j + 1) * step);
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${Math.round(alpha * 1000) / 1000}" stroke-width="${stroke}" stroke-linejoin="round"/>`);
  }
  return out.join("");
}

const state = (fill: string, opacity: number, scale: number) => `fill:${fill};opacity:${opacity};transform:scale(${scale})`;

/** White flashes read on dark pages; on light ones the accent is the brightest thing available. */
function flashColor(theme: Theme): string {
  return theme.glow > 0 ? "#ffffff" : theme.accent;
}

function render(ctx: GameContext): GameOutput {
  const { grid, theme, rng } = ctx;
  const layout = arcadeLayout(grid);
  const sim = simulateBreakout(grid, layout, rng);
  const { court } = sim;
  const pace = pacePlay(sim);
  const play = pace.length;
  const duration = loopDuration(play);
  const back = restoreAt(play);
  const intro = PACE.intro;
  const at = (t: number) => intro + pace.at(t);
  const tl = new Timeline(duration, "b");
  const startY = court.padTop - BALL_R;
  const empty = sim.hits.length === 0;
  const glow = glowAttr(theme);
  const flash = flashColor(theme);
  const gridCx = layout.left + layout.gridWidth / 2;
  const gridCy = layout.top + layout.gridHeight / 2;
  const wallBottom = court.padTop + PADDLE_H + 4;

  const parts: string[] = [];
  const wall = `M${court.fieldL - 1.5} ${wallBottom}V${court.fieldT - 1.5}H${court.fieldR + 1.5}V${wallBottom}`;
  parts.push(
    (theme.glow > 0 ? haloStrokes(wall, theme.accent, 3, theme.glow) : "") +
      `<path d="${wall}" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linejoin="round"/>`,
    `<path d="M${court.fieldL + 1.5} ${wallBottom}V${court.fieldT + 1.5}H${court.fieldR - 1.5}V${wallBottom}" fill="none" stroke="${theme.ink}" stroke-opacity=".28" stroke-width="1"/>`,
  );
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));

  const hitsByCell = new Map<Cell, BrickHit[]>();
  for (const h of sim.hits) {
    const list = hitsByCell.get(h.cell) ?? [];
    list.push(h);
    hitsByCell.set(h.cell, list);
  }

  const cracks = new Pool("opacity:0;transform:translate(0px,0px)");
  const padRings = new Pool("opacity:0;transform:translate(0px,0px) scale(2.8)");
  const bigRingName = tl.keyframes([
    [0, "opacity:1;transform:scale(.3)"],
    [0.7, "opacity:0;transform:scale(9)"],
  ]);
  const delayFor = (t: number) => `--d:${fmt(-(duration - t))}s`;

  const flights: { start: number; cx: number; cy: number; base: string; spark: string }[] = [];
  const crackEvents: { start: number; end: number; variant: number; ox: number; oy: number }[] = [];
  const clears: ClearEvent[] = [];
  for (const cell of activeCells(grid)) {
    const hits = hitsByCell.get(cell) ?? [];
    const top = levelColor(theme, cell);
    const worn = levelColor(theme, { ...cell, level: (cell.level - 1) as Cell["level"] });
    const frames: Frame[] = [[0, state(top, 1, 1)]];
    let last = top;
    let crackAt = -1;
    for (const h of hits) {
      const t = at(h.t);
      if (!h.final) {
        frames.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + FLASH_TIME, state(worn, 1, 1)]);
        last = worn;
        crackAt = t;
      } else {
        frames.push([t, state(last, 1, 1)], [t, state(flash, 1, 1)], [t + 0.06, state(flash, 1, 1.25)], [t + 0.061, state(flash, 0, 1.25)]);
        clears.push({ t, cell });
        const cx = layout.left + cell.x * layout.pitch + layout.cell / 2;
        const cy = layout.top + cell.y * layout.pitch + layout.cell / 2;
        const burning = sim.fire !== null && h.t >= sim.fire.t;
        const base = burning ? EMBERS[1] : spriteColor(theme, { level: Math.min(4, cell.level + 1) as Cell["level"] });
        const spark = burning ? EMBERS[0] : flash;
        flights.push({ start: t + 0.06, cx, cy, base, spark });
        if (crackAt >= 0 && t > crackAt + FLASH_TIME + 0.02) {
          const [ox, oy] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
          crackEvents.push({ start: crackAt + FLASH_TIME, end: t + 0.001, variant: (cell.x + cell.y * 2) % CRACKS.length, ox, oy });
        }
      }
    }
    frames.push([back, state(top, 0, 1)], [back + PACE.restore, state(top, 1, 1)]);
    parts.push(cellRect(layout, cell, top, `class="b ${tl.track(frames)}"`));
  }
  for (const c of crackEvents.sort((a, b) => a.start - b.start)) {
    const pos = translate(c.ox, c.oy);
    cracks.add(String(c.variant), c.start, c.end, [
      [c.start, "opacity:0;" + pos],
      [c.start + 0.001, "opacity:1;" + pos],
      [c.end - 0.001, "opacity:1;" + pos],
      [c.end, "opacity:0;" + pos],
    ]);
  }

  // Chips fly the same arc every time, so their keyframes are shared and loop on
  // a period that divides the loop exactly. Each group of chips sits at a fixed
  // phase of that period and is shown, moved and recoloured per brick, so a
  // flight starts at the nearest free phase boundary, within half a bin.
  const loopLen = Number(fmt(duration));
  const chipPeriod = loopLen / Math.max(1, Math.round(loopLen / CHIP_LIFE));
  const bin = chipPeriod / CHIP_GROUPS;
  const chipOff = "opacity:0;fill:#000;color:#000;transform:translate(0px,0px)";
  const chipTracks: Frame[][] = Array.from({ length: CHIP_GROUPS }, () => [[0, chipOff]]);
  const taken = new Set<number>();
  for (const f of flights.sort((a, b) => a.start - b.start)) {
    let n = Math.round(f.start / bin);
    while (taken.has(n)) n++;
    taken.add(n);
    const t = n * bin;
    const on = `opacity:1;fill:${f.base};color:${f.spark};` + translate(f.cx, f.cy);
    chipTracks[n % CHIP_GROUPS].push([t, chipOff], [t, on], [t + chipPeriod, on], [t + chipPeriod, chipOff]);
  }
  const chipMarkup = chipTracks
    .map((frames, j) => {
      const cls = tl.track(frames);
      const rects = CHIPS.map((c, i) => {
        const half = fmt(-c.size / 2);
        return `<rect class="c${i}"${c.spark ? ' fill="currentColor"' : ""} x="${half}" y="${half}" width="${c.size}" height="${c.size}"/>`;
      }).join("");
      return `<g class="${cls}" style="--d:${(j * bin - chipPeriod).toFixed(5)}s">${rects}</g>`;
    })
    .join("");
  parts.push(
    cracks.markup(tl, (variant, cls) => {
      const d = CRACKS[Number(variant)].map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
      return `<path class="${cls}" d="${d}" fill="none" stroke="${theme.surface}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }),
    chipMarkup,
  );
  const chipCss = CHIPS.map((c, i) => chipKeyframes(`cf${i}`, c, chipPeriod) + `.c${i}{animation:cf${i} ${chipPeriod.toFixed(7)}s linear infinite;animation-delay:var(--d)}`);

  const lastHit = sim.hits.length ? sim.hits[sim.hits.length - 1] : null;
  if (lastHit) {
    const t = at(lastHit.t);
    const cx = layout.left + lastHit.cell.x * layout.pitch + layout.cell / 2;
    const cy = layout.top + lastHit.cell.y * layout.pitch + layout.cell / 2;
    parts.push(`<circle class="p bring" cx="${fmt(cx)}" cy="${fmt(cy)}" r="6" fill="none" stroke="${flash}" stroke-width="2" style="${delayFor(t)}"/>`);
    const surge = tl.track([[0, "opacity:0"], [t, "opacity:0"], [t + 0.001, "opacity:.16"], [t + 0.28, "opacity:0"]]);
    parts.push(
      `<rect class="${surge}" x="${fmt(layout.left)}" y="${fmt(layout.top)}" width="${fmt(layout.gridWidth)}" height="${fmt(layout.gridHeight)}" fill="${flash}"/>`,
    );
  }

  const ringCss = [
    `.bring{animation:${bigRingName} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`,
  ];
  for (const [t, x, y] of sim.ball.slice(1)) {
    if (y !== startY) continue;
    const t0 = at(t);
    const at0 = (scale: number, opacity: number) => `opacity:${opacity};` + translate(x, court.padTop, `scale(${scale})`);
    padRings.add("", t0, t0 + 0.35, [
      [t0, at0(0.4, 0.9)],
      [t0 + 0.35, at0(2.8, 0)],
    ]);
  }

  // Paddle: glides between contact points, with a squash on every touch.
  const paddleFrames: Frame[] = [];
  const pos = (x: number) => translate(x, court.padTop);
  let cur = { t: 0, x: court.startX };
  paddleFrames.push([0, pos(cur.x)]);
  const squash: Frame[] = [[0, "transform:scale(1,1)"]];
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
      const start = Math.max(t - 0.012, lastSquashEnd + 0.001);
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
  const ballPos = (x: number, y: number) => translate(x, y);
  const ballFrames: Frame[] = [[0, ballPos(court.startX, startY)], [intro, ballPos(court.startX, startY)]];
  for (const [t, x, y] of sim.ball.slice(1)) ballFrames.push([at(t), ballPos(x, y)]);
  const ballEnd = sim.ball[sim.ball.length - 1];
  ballFrames.push([back, ballPos(ballEnd[1], ballEnd[2])]);
  for (const [gt, gx] of smoothGlide(back, cur.x, returnEnd, court.startX)) paddleFrames.push([gt, pos(gx)]);
  for (const [gt, gx] of smoothGlide(back, empty ? court.startX : ballEnd[1], returnEnd, court.startX)) {
    ballFrames.push([gt, ballPos(gx, startY)]);
  }
  paddleFrames.push([duration, pos(court.startX)]);
  ballFrames.push([duration, ballPos(court.startX, startY)]);

  parts.push(
    padRings.markup(tl, (_, cls) => `<ellipse class="${cls}" rx="7" ry="1.6" fill="none" stroke="${theme.accent}" stroke-width="1.5"/>`),
  );
  const padRaw = tl.track(paddleFrames);
  const padSquash = tl.track(squash, "linear");
  const padW = PADDLE_HALF * 2;
  parts.push(
    `<g class="${padRaw}"><g class="sq ${padSquash}"><g${glow}>` +
      `<rect x="${-PADDLE_HALF - 3}" y="-3" width="${padW + 6}" height="${PADDLE_H + 6}" rx="${PADDLE_H / 2 + 3}" fill="${theme.accent}" opacity=".24"/>` +
      `<rect x="${-PADDLE_HALF}" y="0" width="${padW}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.ink}"/>` +
      `<rect x="${-PADDLE_HALF}" y="0" width="9" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.accent}"/>` +
      `<rect x="${PADDLE_HALF - 9}" y="0" width="9" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.accent}"/>` +
      `<rect x="${-PADDLE_HALF + 10}" y="1.5" width="${padW - 20}" height="1.8" rx=".9" fill="${theme.surface}" opacity=".45"/>` +
      `</g></g></g>`,
  );

  const ballKeys = tl.keyframes(ballFrames);
  const ghosts = (sizes: number[], lags: number[], colors: string[], opacities: number[]) =>
    sizes
      .map((s, i) => {
        const cls = tl.useKeyframes(ballKeys, lags[i]);
        return `<circle class="${cls}" r="${fmt(s / 2)}" fill="${colors[i]}" opacity="${opacities[i]}"/>`;
      })
      .join("");
  const bare = (inner: string) => `<g class="${tl.useKeyframes(ballKeys, 0)}"><g${glow}>${inner}</g></g>`;
  // The trail would drag across the board while the ball slides back to the serve spot.
  const trailOff = tl.track([[0, "opacity:1"], [back, "opacity:1"], [back + 0.001, "opacity:0"], [duration - 0.001, "opacity:0"]]);

  const plain =
    `<g class="${trailOff}">${ghosts([7.2, 6.4, 5.6, 4.6, 3.6], [0.011, 0.022, 0.034, 0.048, 0.064], Array(5).fill(theme.accent), [0.6, 0.45, 0.32, 0.2, 0.1])}</g>` +
    bare(
      `<circle r="8" fill="${theme.accent}" opacity=".3"/><circle r="${BALL_R}" fill="${theme.ink}"/>`,
    );
  if (sim.fire) {
    const f = sim.fire;
    const ft = at(f.t);
    parts.push(`<g class="${tl.track([[0, "opacity:1"], [ft, "opacity:1"], [ft + 0.001, "opacity:0"], [parkT, "opacity:0"], [parkT + 0.001, "opacity:1"]])}">${plain}</g>`);
    const embers = ["#ffd23f", "#ffa51f", "#ff7a1a", "#ff5a1a", "#e8321a", "#c2241a"];
    const flameGhosts = ghosts(
      [9, 8.2, 7.4, 6.4, 5.2, 4],
      [0.01, 0.02, 0.032, 0.046, 0.062, 0.08],
      embers,
      [0.95, 0.85, 0.7, 0.55, 0.4, 0.25],
    );
    const core = `<circle r="9" fill="#ff7a1a" opacity=".3"/><circle r="4.6" fill="#ff6a1a"/><circle r="2.4" fill="#fff0a8"/>`;
    parts.push(
      `<g class="${tl.track([[0, "opacity:0"], [ft, "opacity:0"], [ft + 0.001, "opacity:1"], [parkT, "opacity:1"], [parkT + 0.001, "opacity:0"]])}"><g class="${trailOff}">${flameGhosts}</g>${bare(core)}</g>`,
    );
    const ring = tl.track([
      [ft, "opacity:0;transform:scale(.4)"],
      [ft + 0.001, "opacity:1;transform:scale(.6)"],
      [ft + 0.45, "opacity:0;transform:scale(5.5)"],
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
    ...ringCss,
    ...chipCss,
    tl.css(),
  ].join("\n");
  return { width: layout.width, height: layout.height, css, defs: glowDefs(theme), body: parts.join("\n") };
}

export const breakout: Game = { id: "breakout", title: "Breakout", render };
