import { Timeline, fmt, translate, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { activeCells, allCells, type Cell, type Grid } from "../grid.ts";
import type { Rng } from "../rng.ts";
import { cellRect, levelColor, makeLayout, type Layout } from "../svg.ts";
import { pixelText } from "../pixel-font.ts";

const BALL_R = 3;
const PADDLE_HALF = 32;
const PADDLE_H = 6;
const VOID = 34;
const MAX_TILT = (56 * Math.PI) / 180;
/** Smallest share of the speed that must point up or down, so rallies never go near-horizontal. */
const MIN_VERTICAL = 0.5;
/** Share of bricks left at which the fireball power-up kicks in. */
const FIRE_SHARE = 0.35;

/** The physics runs at a fixed speed and dt; the finished play is then retimed to a pace that fits the loop. */
const SIM_SPEED = 600;
const SIM_DT = 1 / 720;
const TARGET_PLAY = 40;
const MIN_SPEED = 330;
const MAX_SPEED = 800;
/** The ball speeds up as the board empties, like the arcade original. */
const RAMP_FROM = 0.8;
const RAMP_TO = 1.3;

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
  const factors = breaks.map((t) => {
    const done = sim.hits.filter((h) => h.final && h.t <= t).length;
    return RAMP_FROM + (RAMP_TO - RAMP_FROM) * (done / total);
  });
  const unscaled: number[] = [0];
  for (let i = 1; i < breaks.length; i++) unscaled.push(unscaled[i - 1] + (breaks[i] - breaks[i - 1]) / factors[i - 1]);
  const base = Math.min(MAX_SPEED, Math.max(MIN_SPEED, (SIM_SPEED * unscaled[unscaled.length - 1]) / TARGET_PLAY));
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

const FLASH_TIME = 0.1;

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

const state = (fill: string, opacity: number, scale: number) => `fill:${fill};opacity:${opacity};transform:scale(${scale})`;

function render(ctx: GameContext): GameOutput {
  const { grid, theme, rng } = ctx;
  const layout = makeLayout(grid, { left: 14, top: 14 });
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

  const width = court.fieldR + 14;
  const height = court.padTop + PADDLE_H + 10;

  const parts: string[] = [];
  parts.push(
    `<path d="M${court.fieldL - 1} ${court.padTop + PADDLE_H}V${court.fieldT - 1}H${court.fieldR + 1}V${court.padTop + PADDLE_H}" fill="none" stroke="${theme.muted}" stroke-opacity=".5" stroke-width="2" stroke-linejoin="round"/>`,
  );
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));

  const flash = theme.ink;
  const pops: string[] = [];
  const hitsByCell = new Map<Cell, BrickHit[]>();
  for (const h of sim.hits) {
    const list = hitsByCell.get(h.cell) ?? [];
    list.push(h);
    hitsByCell.set(h.cell, list);
  }

  const burst = [
    { dx: -11, dy: -9 },
    { dx: 12, dy: -7 },
    { dx: -8, dy: 3 },
    { dx: 9, dy: 5 },
  ].map(({ dx, dy }) =>
    tl.keyframes([
      [0, "opacity:1;transform:translate(0px,0px) scale(1)"],
      [0.18, `opacity:.9;transform:translate(${fmt(dx * 0.65)}px,${fmt(dy * 0.65 - 3)}px) scale(.8)`],
      [0.5, `opacity:0;transform:translate(${dx}px,${dy + 6}px) scale(.3)`],
    ]),
  );
  const burstClass = ["pa", "pb", "pc", "pd"];
  const burstCss = burst.map((name, i) => `.${burstClass[i]}{animation:${name} ${fmt(duration)}s ease-out infinite;animation-delay:var(--d)}`);

  for (const cell of activeCells(grid)) {
    const hits = hitsByCell.get(cell) ?? [];
    const top = levelColor(theme, cell);
    const worn = levelColor(theme, { ...cell, level: (cell.level - 1) as Cell["level"] });
    const frames: Frame[] = [[0, state(top, 1, 1)]];
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
        const px = (n: number) => fmt(n - 1.2);
        pops.push(
          `<g fill="${last}" style="--d:${fmt(delay)}s">${burstClass
            .map((c) => `<rect class="p ${c}" x="${px(cx)}" y="${px(cy)}" width="2.4" height="2.4"/>`)
            .join("")}</g>`,
        );
      }
    }
    frames.push([back, state(top, 0, 1)], [back + PACE.restore, state(top, 1, 1)]);
    parts.push(cellRect(layout, cell, top, `class="b ${tl.track(frames)}"`));
  }
  parts.push(...pops);

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
    `<g class="${padRaw}"><g class="sq ${padSquash}">` +
      `<rect x="${-PADDLE_HALF - 2}" y="-2" width="${PADDLE_HALF * 2 + 4}" height="${PADDLE_H + 4}" rx="${PADDLE_H / 2 + 2}" fill="${theme.accent}" opacity=".22"/>` +
      `<rect x="${-PADDLE_HALF}" y="0" width="${PADDLE_HALF * 2}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="${theme.ink}"/>` +
      `<rect x="${-PADDLE_HALF + 3}" y="0" width="${PADDLE_HALF * 2 - 6}" height="1.8" rx=".9" fill="${theme.accent}"/>` +
      `</g></g>`,
  );

  const ballKeys = tl.keyframes(ballFrames);
  const ghosts = (sizes: number[], lags: number[], colors: string[], opacities: number[]) =>
    sizes
      .map((s, i) => {
        const cls = tl.useKeyframes(ballKeys, lags[i]);
        return `<rect class="${cls}" x="${fmt(-s / 2)}" y="${fmt(-s / 2)}" width="${s}" height="${s}" rx="${fmt(s / 4)}" fill="${colors[i]}" opacity="${opacities[i]}"/>`;
      })
      .join("");

  const plain =
    ghosts([5.4, 4.8, 4.2, 3.6], [0.012, 0.024, 0.036, 0.048], Array(4).fill(theme.ink), [0.34, 0.24, 0.15, 0.08]) +
    `<rect class="${tl.useKeyframes(ballKeys, 0)}" x="-3" y="-3" width="6" height="6" rx="1.5" fill="${theme.ink}"/>`;
  if (sim.fire) {
    const f = sim.fire;
    const ft = at(f.t);
    parts.push(`<g class="${tl.track([[0, "opacity:1"], [ft, "opacity:1"], [ft + 0.001, "opacity:0"], [parkT, "opacity:0"], [parkT + 0.001, "opacity:1"]])}">${plain}</g>`);
    const embers = ["#ffd23f", "#ffa51f", "#ff7a1a", "#ff5a1a", "#e8321a", "#c2241a"];
    const flameGhosts = ghosts(
      [6.4, 5.8, 5.2, 4.6, 3.8, 3],
      [0.01, 0.02, 0.032, 0.046, 0.062, 0.08],
      embers,
      [0.95, 0.85, 0.7, 0.55, 0.4, 0.25],
    );
    const core =
      `<rect class="${tl.useKeyframes(ballKeys, 0)}" x="-3.4" y="-3.4" width="6.8" height="6.8" rx="2" fill="#ff6a1a"/>` +
      `<rect class="${tl.useKeyframes(ballKeys, 0)}" x="-1.8" y="-1.8" width="3.6" height="3.6" rx="1" fill="#fff0a8"/>`;
    parts.push(`<g class="${tl.track([[0, "opacity:0"], [ft, "opacity:0"], [ft + 0.001, "opacity:1"], [parkT, "opacity:1"], [parkT + 0.001, "opacity:0"]])}">${flameGhosts}${core}</g>`);
    const ring = tl.track([
      [ft, "opacity:0;transform:scale(.4)"],
      [ft + 0.001, "opacity:1;transform:scale(.6)"],
      [ft + 0.4, "opacity:0;transform:scale(4.5)"],
    ]);
    parts.push(`<circle class="ring ${ring}" cx="${fmt(f.x)}" cy="${fmt(f.y)}" r="4" fill="none" stroke="#ff7a1a" stroke-width="1.6"/>`);
  } else {
    parts.push(plain);
  }

  if (!empty) {
    const text = pixelText("CLEAR!", 3);
    const tx = fmt(layout.left + layout.gridWidth / 2 - text.width / 2);
    const ty = fmt(layout.top + layout.gridHeight / 2 - text.height / 2);
    const blink: Frame[] = [[0, "opacity:0"]];
    let t = parkT + 0.05;
    for (let i = 0; i < 4; i++) {
      blink.push([t, "opacity:0"], [t + 0.001, "opacity:1"], [t + 0.13, "opacity:1"], [t + 0.131, "opacity:0"]);
      t += 0.26;
    }
    blink.push([t, "opacity:0"], [t + 0.001, "opacity:1"], [back - 0.05, "opacity:1"], [back - 0.049, "opacity:0"]);
    parts.push(
      `<g class="${tl.track(blink)}"><path d="${text.d}" transform="translate(${fmt(Number(tx) + 3)} ${fmt(Number(ty) + 3)})" fill="${theme.accent}"/>` +
        `<path d="${text.d}" transform="translate(${tx} ${ty})" fill="${theme.ink}"/></g>`,
    );
  }

  const css = [
    ".b,.p,.sq,.ring{transform-box:fill-box;transform-origin:center}",
    ".sq{transform-origin:50% 100%}",
    ...burstCss,
    tl.css(),
  ].join("\n");
  return { width, height, css, body: parts.join("\n") };
}

export const breakout: Game = { id: "breakout", title: "Breakout", render };
