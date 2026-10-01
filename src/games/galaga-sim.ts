import { activeCells, type Cell, type Grid } from "../grid.ts";
import { createRng, type Rng } from "../rng.ts";
import { Turtle, routeAt, type Route } from "./galaga-path.ts";

export type EnemyKind = "bee" | "butterfly" | "boss";

export interface DiveRec {
  /** Seconds from the start of play (not the loop). */
  start: number;
  route: Route;
  /** Landing back in formation, or the moment the diver was shot down. */
  end: number;
  killed: boolean;
}

export interface EnemyRec {
  id: number;
  cell: Cell;
  kind: EnemyKind;
  slot: [number, number];
  dives: DiveRec[];
  /** First hit on a boss that takes two. */
  hit: number | null;
  death: number | null;
  /** Where the enemy was when it died, in screen coordinates. */
  deathAt: [number, number] | null;
}

export interface Shot {
  t: number;
  x: number;
  y0: number;
  tEnd: number;
  yEnd: number;
  hit: boolean;
}

export interface Boom {
  t: number;
  x: number;
  y: number;
  size: "s" | "m" | "l";
}

export interface FighterKey {
  t: number;
  x: number;
  y: number;
  rot: number;
  scale: number;
}

export interface FadeKey {
  t: number;
  opacity: number;
}

export interface CaptureRec {
  boss: number;
  /** Boss starts its dive, reaches the hover point, beam on/off, fighter spun up, boss back in formation. */
  diveStart: number;
  hoverAt: number;
  beamOn: number;
  beamOff: number;
  abductEnd: number;
  returnStart: number;
  returnEnd: number;
  hover: [number, number];
  returnRoute: Route;
  /** When the spare fighter appears. */
  respawn: number;
  respawnX: number;
}

export interface RescueRec {
  /** Captor shot down: the captive breaks free here and flies to the fighter. */
  t: number;
  from: [number, number];
  to: [number, number];
  dockAt: number;
}

export interface GalagaSim {
  enemies: EnemyRec[];
  shots: Shot[];
  booms: Boom[];
  fighter: FighterKey[];
  fade: FadeKey[];
  capture: CaptureRec | null;
  rescue: RescueRec | null;
  /** Seconds of play, including the last explosion fading. */
  end: number;
  /** Closest any diver came to a ship while the fighter was in play. */
  minClearance: number;
}

export interface GalagaGeo {
  width: number;
  /** Fixed point the formation breathes around. */
  centerX: number;
  centerY: number;
  slot: (cell: Cell) => [number, number];
}

export const FIGHTER_Y = 192;
export const SEP = 16;
export const BREATH_AMP = 0.016;
export const BREATH_PERIOD = 4;
export const BREATH_STEP = 0.25;
const DT = 1 / 60;
const VF = 430;
const VB = 470;
const BULLET_Y0 = FIGHTER_Y - 12;
const HIT_X = 8.8;
const RESCUE_AT = 0.25;
const SPIN = 1.1;
const DOCK = 1.3;
const SAFE_GAP = 16;

const breathTable: number[] = [];

function breathSample(k: number): number {
  let v = breathTable[k];
  if (v === undefined) {
    const t = k * BREATH_STEP;
    v = BREATH_AMP * Math.sin((2 * Math.PI * t) / BREATH_PERIOD) * Math.min(1, t);
    breathTable[k] = v;
  }
  return v;
}

/** Formation scale offset at time t of play; piecewise linear so keyframes reproduce it exactly. */
export function breathAt(t: number): number {
  if (t <= 0) return 0;
  const k = Math.floor(t / BREATH_STEP);
  const u = t / BREATH_STEP - k;
  return breathSample(k) * (1 - u) + breathSample(k + 1) * u;
}

interface Enemy {
  rec: EnemyRec;
  state: "form" | "dive" | "capture" | "dead";
  hp: number;
  start: number;
  route: Route | null;
  captor: boolean;
  rescuing: boolean;
  /** Whether the fighter will go after this diver; the rest swoop past and get away. */
  doomed: boolean;
}

interface Bullet {
  shot: Shot;
  x: number;
  y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function diveRoute(sx: number, sy: number, side: number, aimX: number, width: number): Route {
  const t = new Turtle(sx, sy, 90);
  t.line(6, 150).arc(-360 * side, 11, 170);
  const qx = clamp(aimX + side * 26, 26, width - 26);
  t.curveTo(sx, t.y + 55, qx - side * 44, 150, qx, 184, 215);
  t.arc(-side * 180, 15, 215);
  t.curveTo(t.x + Math.cos(t.h) * 45, t.y + Math.sin(t.h) * 45, sx, sy + 70, sx, sy + 18, 225);
  t.line(18, 120);
  return t.done(Math.round(((t.h * 180) / Math.PI - 90) / 360) * 360);
}

export function captureRoute(sx: number, sy: number, side: number, hoverY: number): Route {
  const t = new Turtle(sx, sy, 90);
  t.line(6, 130).arc(-360 * side, 11, 150);
  t.line(hoverY - t.y, 140);
  return t.done(Math.round(((t.h * 180) / Math.PI - 90) / 360) * 360);
}

function straightRoute(x0: number, y0: number, x1: number, y1: number, speed: number): Route {
  const dur = Math.hypot(x1 - x0, y1 - y0) / speed;
  return { t: [0, dur], x: [x0, x1], y: [y0, y1], r: [0, 0], dur };
}

/** Divers are scripted flights, so a run where one grazes the fighter is simply played again with fresh dives. */
export function simulateGalaga(grid: Grid, rng: Rng, geo: GalagaGeo): GalagaSim {
  let best: GalagaSim | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const run = playOnce(grid, createRng(`${Math.floor(rng() * 2 ** 31)}`), geo);
    if (!best || run.minClearance > best.minClearance) best = run;
    if (best.minClearance >= SAFE_GAP) break;
  }
  return best!;
}

function playOnce(grid: Grid, rng: Rng, geo: GalagaGeo): GalagaSim {
  const cells = activeCells(grid);
  const total = cells.length;
  const enemies: Enemy[] = cells.map((cell, id) => ({
    rec: {
      id,
      cell,
      kind: cell.level >= 4 ? "boss" : cell.level === 3 ? "butterfly" : "bee",
      slot: geo.slot(cell),
      dives: [],
      hit: null,
      death: null,
      deathAt: null,
    },
    state: "form",
    hp: cell.level >= 4 ? 2 : 1,
    start: 0,
    route: null,
    captor: false,
    rescuing: false,
    doomed: true,
  }));
  const shots: Shot[] = [];
  const booms: Boom[] = [];
  const fighter: FighterKey[] = [];
  const fade: FadeKey[] = [{ t: 0, opacity: 1 }];
  const out: GalagaSim = { enemies: enemies.map((e) => e.rec), shots, booms, fighter, fade, capture: null, rescue: null, end: 0, minClearance: Infinity };
  if (total === 0) return out;

  const byCol = new Map<number, Enemy[]>();
  for (const e of enemies) {
    const list = byCol.get(e.rec.cell.x) ?? [];
    list.push(e);
    byCol.set(e.rec.cell.x, list);
  }
  for (const list of byCol.values()) list.sort((a, b) => a.rec.slot[1] - b.rec.slot[1]);
  const columns = [...byCol.keys()].sort((a, b) => a - b);
  const colSlotX = new Map<number, number>();
  for (const [c, list] of byCol) colSlotX.set(c, list[0].rec.slot[0]);

  const rate = clamp(total / 30, 3.5, 8);
  let tau = 0;
  let killed = 0;
  let fx = geo.centerX;
  let dual = false;
  let mode = "play" as "play" | "bait" | "spin" | "gone" | "dock";
  let cooldown = 0.4;
  let moving = false;
  let moveTick = 0;
  let nextDive = 1.4;
  let bullets: Bullet[] = [];
  let plan: { ax: number; fire: number; id: number } | null = null;
  let sweep = -1;
  let dockX = 0;
  let dualAt = -1;
  let lastDeath = 0;

  type Phase = "off" | "wait" | "dive" | "beam" | "abduct" | "return" | "held" | "release" | "done";
  let phase = (total >= 14 && enemies.some((e) => e.rec.kind === "boss") ? "wait" : "off") as Phase;
  let capBoss: Enemy | null = null;
  let cap: CaptureRec | null = null;
  let nextRescue = 0;

  const ships = (x = fx): number[] => (dual ? [x, x + SEP] : [x]);
  const xMax = () => geo.width - 16 - (dual ? SEP : 0);
  const unscale = (v: number, c: number, t: number) => c + (v - c) / (1 + breathAt(t));
  const scrX = (x: number, t: number) => geo.centerX + (x - geo.centerX) * (1 + breathAt(t));
  const scrY = (y: number, t: number) => geo.centerY + (y - geo.centerY) * (1 + breathAt(t));

  const posOf = (e: Enemy, t: number): [number, number] => {
    if (e.state === "dive" || e.state === "capture") {
      const p = routeAt(e.route!, t - e.start);
      return [scrX(p.x, t), scrY(p.y, t)];
    }
    return [scrX(e.rec.slot[0], t), scrY(e.rec.slot[1], t)];
  };

  const frontline = (e: Enemy): boolean => {
    const list = byCol.get(e.rec.cell.x)!;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].state === "form") return list[i] === e;
    }
    return false;
  };

  const alive = () => enemies.filter((e) => e.state !== "dead");
  const divers = () => enemies.filter((e) => e.state === "dive" || e.state === "capture");

  const pushKey = (t: number, x: number, y = FIGHTER_Y, rot = 0, scale = 1) => fighter.push({ t, x, y, rot, scale });
  pushKey(0, fx);

  const startDive = (e: Enemy, route: Route, state: "dive" | "capture") => {
    e.doomed = e.rescuing || rng() < 0.62;
    e.state = state;
    e.start = tau;
    e.route = route;
    e.rec.dives.push({ start: tau, route, end: tau + route.dur, killed: false });
  };

  /** Where divers will be at fighter height over the next moment, as horizontal positions. */
  const hazards = (t: number): number[] => {
    const xs: number[] = [];
    for (const e of divers()) {
      for (let k = 0; k <= 9; k++) {
        const [ex, ey] = posOf(e, t + k * 0.09);
        if (ey >= FIGHTER_Y - 30 && ey <= FIGHTER_Y + 22) xs.push(ex);
      }
    }
    return xs;
  };
  const gap = (xs: number[], haz: number[]): number => {
    let best = Infinity;
    for (const h of haz) for (const sx of xs) best = Math.min(best, Math.abs(h - sx));
    return best;
  };
  const HORIZON = 9;
  const STEP = 0.09;

  /** Diver positions at fighter height for each moment of the next second, so a dodge can be checked along its whole route. */
  const hazardSamples = (t: number): number[][] => {
    const out: number[][] = Array.from({ length: HORIZON + 1 }, () => []);
    for (const e of divers()) {
      for (let k = 0; k <= HORIZON; k++) {
        const [ex, ey] = posOf(e, t + k * STEP);
        if (ey >= FIGHTER_Y - 30 && ey <= FIGHTER_Y + 22) out[k].push(ex);
      }
    }
    return out;
  };

  /** Closest a diver gets to the ships while the fighter slides to `x` at full speed. */
  const routeGap = (x: number, samples: number[][]): number => {
    let best = Infinity;
    for (let k = 0; k <= HORIZON; k++) {
      if (samples[k].length === 0) continue;
      const p = fx + clamp(x - fx, -VF * k * STEP, VF * k * STEP);
      for (const ex of samples[k]) for (const sx of ships(p)) best = Math.min(best, Math.abs(ex - sx));
    }
    return best;
  };

  const findIntercept = (): { ax: number; fire: number; id: number } | null => {
    const ready = Math.max(0, cooldown);
    const order = divers().sort((a, b) => Number(b.rescuing) - Number(a.rescuing));
    for (const e of order) {
      if (e.state !== "dive" || !e.doomed) continue;
      const endT = e.start + e.route!.dur;
      for (let th = Math.max(tau + 0.12, e.start + 0.9); th < Math.min(endT, tau + 1.5); th += 0.05) {
        const [px, py] = posOf(e, th);
        if (py < 62 || py > FIGHTER_Y - 22) continue;
        const tf = th - (BULLET_Y0 - py) / VB;
        const options = dual ? [px, px - SEP] : [px];
        for (const ax of options) {
          if (ax < 16 || ax > xMax()) continue;
          const need = Math.max(Math.abs(ax - fx) / VF, ready);
          if (tf - tau >= need) return { ax, fire: tf, id: e.rec.id };
        }
      }
    }
    return null;
  };

  const killEnemy = (e: Enemy, x: number, y: number) => {
    const wasDive = e.state === "dive";
    e.state = "dead";
    e.rec.death = tau;
    e.rec.deathAt = [x, y];
    killed++;
    lastDeath = tau;
    const last = alive().length === 0;
    booms.push({ t: tau, x, y, size: last ? "l" : e.rec.kind === "boss" ? "m" : "s" });
    if (wasDive) {
      const d = e.rec.dives[e.rec.dives.length - 1];
      d.end = tau;
      d.killed = true;
    }
    if (e.captor && cap && out.capture) {
      const to: [number, number] = [clamp(fx, 16, geo.width - 16 - SEP) + SEP, FIGHTER_Y];
      dockX = to[0] - SEP;
      out.rescue = { t: tau, from: [x, y + 16], to, dockAt: tau + DOCK };
      phase = "release";
      mode = "dock";
      plan = null;
    }
  };

  const fire = () => {
    for (const sx of ships()) {
      const shot: Shot = { t: tau, x: sx, y0: BULLET_Y0, tEnd: tau, yEnd: BULLET_Y0, hit: false };
      shots.push(shot);
      bullets.push({ shot, x: sx, y: BULLET_Y0 });
    }
    cooldown = 1 / rate;
    plan = null;
  };

  const avail = (col: number): number => {
    const list = byCol.get(col);
    if (!list) return 0;
    const forms = list.filter((e) => e.state === "form");
    if (forms.length === 0) return 0;
    const bottom = forms[forms.length - 1];
    const onlyOne = alive().every((e) => e === bottom || e.captor);
    if (bottom.captor && !bottom.rescuing && !(onlyOne && divers().length === 0)) return 0;
    return forms.length;
  };

  const pending = (col: number): number => {
    const cx = (colSlotX.get(col) ?? 0);
    let n = 0;
    for (const b of bullets) if (Math.abs(unscale(b.x, geo.centerX, tau) - cx) < HIT_X) n++;
    return n;
  };

  const colX = (col: number) => scrX(colSlotX.get(col) ?? geo.centerX, tau);

  const targets = (c: number): [number, number] => [avail(c) - pending(c), dual ? avail(c + 1) - pending(c + 1) : 0];

  const pickSweep = (haz: number[], samples: number[][]): number => {
    let best = -1;
    let bestCost = Infinity;
    for (const c of columns) {
      const [here, next] = targets(c);
      if (here <= 0 && next <= 0) continue;
      const cxs = clamp(colX(c), 16, xMax());
      if (gap(ships(cxs), haz) < 34 || routeGap(cxs, samples) < 28) continue;
      const cost = Math.abs(colX(c) - fx) - (here > 0 && next > 0 ? 9 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    return best;
  };

  const steps = Math.ceil(240 / DT);
  for (let step = 0; step < steps; step++) {
    tau = step * DT;
    const remaining = alive().length;

    // End of a dive: back in formation.
    for (const e of enemies) {
      if (e.state === "dive" && tau - e.start >= e.route!.dur) {
        e.state = "form";
        e.route = null;
        e.rescuing = false;
        if (e.captor) nextRescue = tau + 2.4;
      }
    }

    // Capture and rescue scripts.
    const bossOptions =
      phase === "wait" && killed >= total * 0.07 && tau > 4
        ? enemies.filter((e) => e.rec.kind === "boss" && e.state === "form" && frontline(e) && e.rec.slot[1] <= 120)
        : [];
    if (bossOptions.length > 0 && divers().length === 0) {
      const options = bossOptions;
      {
        const boss = options[Math.floor(rng() * options.length)];
        const [sx, sy] = boss.rec.slot;
        const hy = Math.max(160, sy + 34);
        const route = captureRoute(sx, sy, sx < geo.centerX ? 1 : -1, hy);
        startDive(boss, route, "capture");
        capBoss = boss;
        cap = {
          boss: boss.rec.id,
          diveStart: tau,
          hoverAt: tau + route.dur,
          beamOn: tau + route.dur + 0.2,
          beamOff: 0,
          abductEnd: 0,
          returnStart: 0,
          returnEnd: 0,
          hover: [sx, hy],
          returnRoute: straightRoute(sx, hy, sx, sy, 105),
          respawn: 0,
          respawnX: geo.centerX,
        };
        phase = "dive";
        mode = "bait";
        plan = null;
      }
    }
    if (phase === "dive" && cap && tau >= cap.hoverAt) phase = "beam";
    if (phase === "beam" && cap && capBoss && mode === "bait") {
      const [bx] = posOf(capBoss, tau);
      if (tau >= cap.beamOn + 1.0 && Math.abs(fx - bx) < 3) {
        mode = "spin";
        phase = "abduct";
        cap.beamOff = tau + SPIN + 0.3;
        cap.abductEnd = tau + SPIN;
        cap.returnStart = tau + SPIN + 0.35;
        cap.returnEnd = cap.returnStart + cap.returnRoute.dur;
        cap.respawn = cap.abductEnd + 0.9;
        const hy = scrY(cap.hover[1], tau) + 24;
        pushKey(tau, fx);
        pushKey(tau + SPIN, bx, hy, 1080, 0.75);
        pushKey(cap.respawn - 0.01, geo.centerX, FIGHTER_Y);
        fade.push({ t: tau + SPIN, opacity: 1 }, { t: tau + SPIN + 0.01, opacity: 0 }, { t: cap.respawn - 0.01, opacity: 0 }, { t: cap.respawn + 0.3, opacity: 1 });
        moving = false;
      }
    }
    if (phase === "abduct" && cap && tau >= cap.abductEnd) {
      mode = "gone";
      phase = "return";
      out.capture = cap;
    }
    if (phase === "return" && cap && capBoss && tau >= cap.returnStart && capBoss.state === "capture") {
      capBoss.start = cap.returnStart;
      capBoss.route = cap.returnRoute;
    }
    if (phase === "return" && cap && capBoss && tau >= cap.returnEnd) {
      capBoss.state = "form";
      capBoss.route = null;
      capBoss.captor = true;
      capBoss.hp = 2;
      phase = "held";
      nextRescue = tau + 1.5;
    }
    if (cap && mode === "gone" && tau >= cap.respawn) {
      mode = "play";
      fx = cap.respawnX;
      cooldown = 0.5;
      moving = false;
    }
    if (phase === "held" && capBoss && killed >= total * RESCUE_AT && tau >= nextRescue && divers().length === 0 && capBoss.state === "form") {
      const [sx, sy] = capBoss.rec.slot;
      capBoss.rescuing = true;
      startDive(capBoss, diveRoute(sx, sy, sx < geo.centerX ? 1 : -1, fx, geo.width), "dive");
    }
    if (phase === "release" && out.rescue && tau >= out.rescue.dockAt) {
      dual = true;
      dualAt = tau;
      phase = "done";
      mode = "play";
      cooldown = 0.3;
      nextDive = tau + 0.8;
    }

    // Dives peel off every second or two.
    const paused = bossOptions.length > 0;
    const busy = phase === "dive" || phase === "beam" || phase === "abduct" || phase === "return" || phase === "release";
    const endgame = remaining < total * 0.25;
    if (!paused && !busy && tau >= nextDive && remaining > 3) {
      const maxDivers = endgame ? 3 : 2;
      const live = divers().length;
      if (live < maxDivers) {
        const options = enemies.filter((e) => e.state === "form" && frontline(e) && !e.captor);
        if (options.length > 0) {
          const e = options[Math.floor(rng() * options.length)];
          const [sx, sy] = e.rec.slot;
          const side = (sx < geo.centerX ? 1 : -1) * (rng() < 0.2 ? -1 : 1);
          startDive(e, diveRoute(sx, sy, side, fx + (rng() < 0.5 ? -1 : 1) * (50 + rng() * 50), geo.width), "dive");
        }
      }
      nextDive = tau + (endgame ? 0.7 + rng() * 1.1 : 1 + rng() * 2);
    }

    // Fighter.
    cooldown -= DT;
    const prevX = fx;
    if (mode === "play" || mode === "dock" || mode === "bait") {
      let tx = fx;
      let canFire = false;
      if (mode === "bait" && capBoss) {
        tx = posOf(capBoss, tau)[0];
      } else if (mode === "dock") {
        tx = dockX;
      } else {
        const haz = hazards(tau);
        const samples = hazardSamples(tau);
        const clear = (x: number, margin: number) => gap(ships(x), haz) >= margin;
        if (routeGap(fx, samples) < 24) {
          plan = null;
          let bestCost = Infinity;
          for (const c of columns) {
            const [a, b] = targets(c);
            if (a <= 0 && b <= 0) continue;
            const cxs = clamp(colX(c), 16, xMax());
            if (!clear(cxs, 34) || routeGap(cxs, samples) < 28) continue;
            const cost = Math.abs(cxs - fx);
            if (cost < bestCost) {
              bestCost = cost;
              tx = cxs;
              sweep = c;
            }
          }
          if (bestCost === Infinity || bestCost > 260) {
            let bestScore = -Infinity;
            for (let off = 0; off <= 300; off += 8) {
              for (const sgn of off === 0 ? [1] : [1, -1]) {
                const cx = fx + sgn * off;
                if (cx < 16 || cx > xMax()) continue;
                const score = Math.min(routeGap(cx, samples), 50) * 2 - off * 0.05;
                if (score > bestScore) {
                  bestScore = score;
                  tx = cx;
                }
              }
            }
          } else {
            canFire = Math.abs(fx - tx) < 2.5;
          }
        } else {
          if (!plan || tau > plan.fire + 0.3 || enemies[plan.id].state !== "dive") plan = findIntercept();
          if (plan && (!clear(plan.ax, 24) || routeGap(plan.ax, samples) < 26)) plan = null;
          if (plan) {
            tx = plan.ax;
            canFire = tau >= plan.fire - 0.025 && Math.abs(fx - tx) < 3;
          } else {
            if (sweep < 0 || targets(sweep).every((n) => n <= 0) || !clear(clamp(colX(sweep), 16, xMax()), 30) || routeGap(clamp(colX(sweep), 16, xMax()), samples) < 26) sweep = pickSweep(haz, samples);
            if (sweep >= 0) {
              tx = colX(sweep);
              canFire = Math.abs(fx - tx) < 2.5 && targets(sweep).some((n) => n > 0);
            }
          }
        }
      }
      tx = clamp(tx, 16, xMax());
      fx += clamp(tx - fx, -VF * DT, VF * DT);
      if (!canFire && mode === "play" && (!plan || tau < plan.fire - 0.3)) {
        for (const c of columns) {
          if (Math.abs(colX(c) - fx) > 2.5) continue;
          if (targets(c)[0] > 0 || (dual && Math.abs(colX(c + 1) - fx - SEP) < 2.5 && targets(c)[1] > 0)) canFire = true;
        }
      }
      const maxBullets = dual ? 8 : 5;
      if (canFire && cooldown <= 0 && bullets.length < maxBullets && (mode === "play")) fire();
    }
    if (mode === "play" || mode === "dock" || mode === "bait") {
      const moved = fx !== prevX;
      if (moved && !moving) pushKey(tau, prevX);
      if (moved && moving && ++moveTick % 3 === 0) pushKey(tau + DT, fx);
      if (!moved && moving) pushKey(tau, prevX);
      moving = moved;
    }
    if (mode === "play" || mode === "dock") {
      for (const e of divers()) {
        if (e.state !== "dive") continue;
        const [ex, ey] = posOf(e, tau);
        for (const sx of ships()) {
          const d = Math.hypot(ex - sx, ey - FIGHTER_Y);
          out.minClearance = Math.min(out.minClearance, d);
        }
      }
    }

    // Bullets.
    const keep: Bullet[] = [];
    for (const b of bullets) {
      const yOld = b.y;
      b.y -= VB * DT;
      let target: Enemy | null = null;
      let targetY = -Infinity;
      const sc = 1 + breathAt(tau);
      for (const e of enemies) {
        if (e.state === "dead" || e.state === "capture") continue;
        if (e.state === "form" && Math.abs(b.x - (geo.centerX + (e.rec.slot[0] - geo.centerX) * sc)) > HIT_X) continue;
        const [ex, ey] = posOf(e, tau);
        if (Math.abs(b.x - ex) > HIT_X) continue;
        if (e.state === "form" && !frontline(e)) continue;
        const tip = b.y - 5;
        if (tip <= ey + 8 && yOld - 5 >= ey - 10 && ey > targetY) {
          target = e;
          targetY = ey;
        }
      }
      if (target) {
        b.shot.tEnd = tau;
        b.shot.yEnd = Math.max(b.y, targetY + 6);
        b.shot.hit = true;
        const [ex, ey] = posOf(target, tau);
        target.hp--;
        if (target.hp <= 0) killEnemy(target, ex, ey);
        else {
          target.rec.hit = tau;
          booms.push({ t: tau, x: ex, y: ey, size: "s" });
        }
        continue;
      }
      if (b.y < 34) {
        b.shot.tEnd = tau;
        b.shot.yEnd = 34;
        continue;
      }
      keep.push(b);
    }
    bullets = keep;

    if (remaining === 0 && bullets.length === 0 && phase !== "release" && mode !== "dock") {
      out.end = Math.max(tau, lastDeath + 0.8);
      break;
    }
    if (step === steps - 1) {
      throw new Error("Galaga did not finish");
    }
  }

  if (dualAt >= 0 && out.rescue) out.rescue.dockAt = dualAt;
  pushKey(out.end, fx);
  return out;
}
