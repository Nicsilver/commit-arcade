import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, stageClearLines } from "../kit.ts";
import type { ClearEvent } from "../kit.ts";
import { pixelText } from "../pixel-font.ts";
import type { Rng } from "../rng.ts";
import { cellCenter, cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";

const LANE = 1;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** Classic tie-break order: up, left, down, right. */
const GHOST_ORDER = [3, 2, 1, 0];

/** Simulation time unit; Pac-Man covers a cell in PAC_PERIOD of them. */
const PAC_PERIOD = 2;
const GHOST_PERIOD = 3;
const FRIGHT_PERIOD = 5;
const EYES_PERIOD = 1;
const FRIGHT_LENGTH = 100;
const FLASH_LENGTH = 24;
const SCATTER_LENGTH = 30;
const CHASE_LENGTH = 130;
/** Ghosts never move closer than this (Manhattan) to Pac-Man; he in turn stays further than this from them. */
const GHOST_GAP = 2;
/** Blinky, chasing, is allowed right behind Pac-Man. */
const PRESS_GAP = 1;
const BLINKY_PERIOD = 2;
/** Share of the dots left at which Pac-Man stops dawdling: he doubles his speed and heads for the nearest dot. */
const ENDGAME_SHARE = 0.2;
const HUNT_RANGE = 14;
/** How far from a candidate dot Pac-Man looks for the next one when choosing where to go. */
const LOOKAHEAD = 6;
const POWER_PELLETS = 4;

const GHOSTS = [
  { name: "blinky", color: "#ff0000", release: 0 },
  { name: "pinky", color: "#ffb8ff", release: 30 },
  { name: "inky", color: "#00ffff", release: 70 },
  { name: "clyde", color: "#ffb852", release: 110 },
] as const;

export interface Waypoint {
  /** Simulation time. */
  t: number;
  /** Position in lane-padded cell coordinates (fractional while moving). */
  x: number;
  y: number;
}

export type GhostMode = "normal" | "fright" | "eyes";

export interface GhostSpan {
  mode: GhostMode;
  from: number;
  to: number;
  /** The span ran out on its own instead of being cut short by a catch. */
  timeout?: boolean;
}

export interface PacmanSim {
  cols: number;
  rows: number;
  pac: Waypoint[];
  ghosts: { waypoints: Waypoint[]; spans: GhostSpan[] }[];
  /** Cells in the order Pac-Man arrives on them; `t` is the arrival time. */
  eats: { t: number; cell: Cell; power: boolean; period: number }[];
  ghostEats: { t: number; ghost: number; points: number; x: number; y: number }[];
  /** Arrival time on the last cell: the level is cleared. */
  end: number;
}

interface Agent {
  x: number;
  y: number;
  px: number;
  py: number;
  dir: number;
  nextAt: number;
  wps: Waypoint[];
}

interface Ghost extends Agent {
  mode: GhostMode;
  home: [number, number];
  release: number;
  spans: GhostSpan[];
  since: number;
  /** Time of the last move, to detect swaps with Pac-Man. */
  movedAt: number;
}

export function positionAt(wps: Waypoint[], t: number): [number, number] {
  if (t <= wps[0].t) return [wps[0].x, wps[0].y];
  for (let i = 1; i < wps.length; i++) {
    const b = wps[i];
    if (t <= b.t) {
      const a = wps[i - 1];
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
    }
  }
  const last = wps[wps.length - 1];
  return [last.x, last.y];
}

export function ghostModeAt(spans: GhostSpan[], t: number): GhostMode {
  for (const s of spans) if (t >= s.from && t < s.to) return s.mode;
  return "normal";
}

/** One pellet per corner of the active area, like the arcade's four, as long as there are enough dots to spare. */
function pickPowerPellets(food: Cell[]): Set<Cell> {
  const count = Math.min(POWER_PELLETS, Math.floor(food.length / 4));
  if (count === 0) return new Set();
  const xs = food.map((c) => c.x);
  const ys = food.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const corners: [number, number][] = [[x0, y1], [x1, y0], [x0, y0], [x1, y1]];
  const chosen = new Set<Cell>();
  for (const [cx, cy] of corners.slice(0, count)) {
    let best: Cell | null = null;
    let bestDist = Infinity;
    for (const c of food) {
      if (chosen.has(c)) continue;
      const d = Math.abs(c.x - cx) * 1.5 + Math.abs(c.y - cy) * 3 - c.level * 0.1;
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    chosen.add(best!);
  }
  return chosen;
}

export function simulatePacman(grid: Grid, rng: Rng): PacmanSim {
  const cols = grid.width + 2 * LANE;
  const rows = grid.height + 2 * LANE;
  const total = cols * rows;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  const manhattan = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) + Math.abs(ay - by);

  const foodList = activeCells(grid);
  const powerCells = pickPowerPellets(foodList);
  const food = new Map<number, Cell>();
  for (const c of foodList) food.set((c.y + LANE) * cols + c.x + LANE, c);

  const mid = Math.floor(cols / 2);
  const taken = new Set<number>();
  const homes: [number, number][] = GHOSTS.map((_, i) => {
    let x = Math.min(cols - 1, Math.max(0, mid - 3 + 2 * i));
    let y = 0;
    while (taken.has(y * cols + x)) {
      x = (x + 1) % cols;
      if (x === 0) y++;
    }
    taken.add(y * cols + x);
    return [x, y];
  });

  const pac: Agent = { x: mid, y: rows - 1, px: mid, py: rows - 1, dir: 0, nextAt: 0, wps: [{ t: 0, x: mid, y: rows - 1 }] };
  const ghosts: Ghost[] = GHOSTS.map((g, i) => ({
    x: homes[i][0],
    y: homes[i][1],
    px: homes[i][0],
    py: homes[i][1],
    dir: 2,
    nextAt: g.release,
    wps: [{ t: 0, x: homes[i][0], y: homes[i][1] }],
    mode: "normal",
    home: homes[i],
    release: g.release,
    spans: [],
    since: 0,
    movedAt: -1,
  }));

  const eats: PacmanSim["eats"] = [];
  const ghostEats: PacmanSim["ghostEats"] = [];
  let frightEnd = 0;
  let chain = 0;
  let lastEat = 0;
  let calmUntil = 0;
  let target = -1;
  const endgameAt = Math.max(6, Math.ceil(foodList.length * ENDGAME_SHARE));
  const pacPeriod = () => (food.size <= endgameAt ? 1 : PAC_PERIOD);
  const gapFor = (index: number, u: number) => (index === 0 && chasing(u) ? PRESS_GAP : GHOST_GAP);

  const startMove = (a: Agent, dir: number, u: number, period: number) => {
    const last = a.wps[a.wps.length - 1];
    if (last.t < u) a.wps.push({ t: u, x: a.x, y: a.y });
    a.px = a.x;
    a.py = a.y;
    a.x += DX[dir];
    a.y += DY[dir];
    a.dir = dir;
    a.wps.push({ t: u + period, x: a.x, y: a.y });
    a.nextAt = u + period;
  };

  const setMode = (g: Ghost, mode: GhostMode, t: number, timeout = false) => {
    if (g.mode === mode) return;
    if (t > g.since) g.spans.push({ mode: g.mode, from: g.since, to: t, timeout });
    g.mode = mode;
    g.since = t;
  };

  const chasing = (u: number) => u >= calmUntil && u % (SCATTER_LENGTH + CHASE_LENGTH) >= SCATTER_LENGTH;

  const ghostTarget = (index: number, g: Ghost, u: number): [number, number] => {
    const corners: [number, number][] = [[cols - 1, 0], [0, 0], [cols - 1, rows - 1], [0, rows - 1]];
    if (!chasing(u)) return corners[index];
    if (index === 0) return [pac.x, pac.y];
    if (index === 1) return [pac.x + 4 * DX[pac.dir], pac.y + 4 * DY[pac.dir]];
    if (index === 2) {
      const b = ghosts[0];
      return [2 * (pac.x + 2 * DX[pac.dir]) - b.x, 2 * (pac.y + 2 * DY[pac.dir]) - b.y];
    }
    return manhattan(g.x, g.y, pac.x, pac.y) > 8 ? [pac.x, pac.y] : corners[3];
  };

  const crowded = (g: Ghost, x: number, y: number) =>
    ghosts.some((o) => o !== g && o.mode !== "eyes" && manhattan(o.x, o.y, x, y) < 2);

  const moveGhost = (index: number, g: Ghost, u: number) => {
    if (g.mode === "eyes") {
      const dx = g.home[0] - g.x;
      const dy = g.home[1] - g.y;
      if (dx === 0 && dy === 0) {
        // Waits in the house until Pac-Man is clear of it, so it never respawns on top of him.
        if (manhattan(g.x, g.y, pac.x, pac.y) <= GHOST_GAP + 2) {
          g.nextAt = u + 2;
          return;
        }
        setMode(g, "normal", u);
        g.nextAt = u + 4;
        return;
      }
      startMove(g, dx !== 0 ? (dx > 0 ? 0 : 2) : dy > 0 ? 1 : 3, u, EYES_PERIOD);
      return;
    }
    const options: { dir: number; x: number; y: number }[] = [];
    for (const dir of GHOST_ORDER) {
      const x = g.x + DX[dir];
      const y = g.y + DY[dir];
      if (inside(x, y)) options.push({ dir, x, y });
    }
    const reverse = (g.dir + 2) % 4;
    if (g.mode === "fright") {
      let best = options.filter((o) => !crowded(g, o.x, o.y));
      if (best.length === 0) best = options;
      const far = Math.max(...best.map((o) => manhattan(o.x, o.y, pac.x, pac.y)));
      const pool = best.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) >= far - 1 && o.dir !== reverse);
      const choice = (pool.length ? pool : best.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) === far))[0];
      const picked = pool.length > 1 ? pool[Math.floor(rng() * pool.length)] : choice;
      startMove(g, picked.dir, u, FRIGHT_PERIOD);
      return;
    }
    const goal = ghostTarget(index, g, u);
    const score = (o: { x: number; y: number }) => (o.x - goal[0]) ** 2 + (o.y - goal[1]) ** 2;
    const gap = gapFor(index, u);
    const open = (o: { dir: number; x: number; y: number }) =>
      manhattan(o.x, o.y, pac.x, pac.y) >= gap && !(o.x === pac.px && o.y === pac.py) && !crowded(g, o.x, o.y);
    let pool = options.filter((o) => o.dir !== reverse && open(o));
    if (pool.length === 0) pool = options.filter(open);
    if (pool.length === 0) {
      // Too close to Pac-Man to chase: turn away from him instead.
      const far = Math.max(...options.map((o) => manhattan(o.x, o.y, pac.x, pac.y)));
      pool = options.filter((o) => manhattan(o.x, o.y, pac.x, pac.y) === far);
      pool.sort((a, b) => score(b) - score(a));
    } else {
      pool.sort((a, b) => score(a) - score(b));
    }
    startMove(g, pool[0].dir, u, index === 0 ? BLINKY_PERIOD : GHOST_PERIOD);
  };

  const dangerous = (u: number) => {
    const blocked = new Uint8Array(total);
    ghosts.forEach((g, i) => {
      if (g.mode !== "normal") return;
      const reach = gapFor(i, u) - 1;
      // A ghost pressing right behind him still occupies the cell it is leaving.
      const centres = reach === 0 ? [[g.x, g.y], [g.px, g.py]] : [[g.x, g.y]];
      for (const [cx, cy] of centres) {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > reach) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (inside(x, y)) blocked[y * cols + x] = 1;
          }
        }
      }
    });
    return blocked;
  };

  const search = (blocked: Uint8Array) => {
    const dist = new Int32Array(total).fill(-1);
    const parent = new Int32Array(total).fill(-1);
    const heading = new Int8Array(total).fill(-1);
    const start = pac.y * cols + pac.x;
    dist[start] = 0;
    heading[start] = pac.dir;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      for (const turn of [0, 1, 3, 2]) {
        const d = (heading[cur] + turn) % 4;
        const x = cx + DX[d];
        const y = cy + DY[d];
        if (!inside(x, y)) continue;
        const n = y * cols + x;
        if (dist[n] >= 0 || blocked[n]) continue;
        dist[n] = dist[cur] + 1;
        parent[n] = cur;
        heading[n] = d;
        queue.push(n);
      }
    }
    return { dist, parent };
  };

  const firstStep = (parent: Int32Array, goal: number) => {
    let c = goal;
    while (parent[c] !== pac.y * cols + pac.x) c = parent[c];
    return dirBetween(pac.x, pac.y, c % cols, Math.floor(c / cols));
  };

  const dirBetween = (ax: number, ay: number, bx: number, by: number) =>
    bx > ax ? 0 : by > ay ? 1 : bx < ax ? 2 : 3;

  const decidePac = (u: number): number => {
    const blocked = dangerous(u);
    const normals = ghosts.filter((g) => g.mode === "normal");
    const chasers = normals.filter((g) => u >= g.release + 6);
    const nearestThreat = chasers.length ? Math.min(...chasers.map((g) => manhattan(g.x, g.y, pac.x, pac.y))) : Infinity;
    const frightened = u < frightEnd ? ghosts.filter((g) => g.mode === "fright") : [];
    const endgame = food.size <= endgameAt;

    const hunted = frightened
      .map((g) => ({ g, d: manhattan(g.x, g.y, pac.x, pac.y) }))
      .filter(({ d }) => !endgame && d <= HUNT_RANGE && d * pacPeriod() + 4 < frightEnd - u)
      .sort((a, b) => a.d - b.d)[0];
    if (hunted) {
      const goal = hunted.g.y * cols + hunted.g.x;
      const route = search(blocked);
      if (route.dist[goal] > 0) return firstStep(route.parent, goal);
    }

    if (u >= frightEnd && nearestThreat <= 5 && chasing(u)) {
      const open = search(blocked);
      let bestPellet = -1;
      for (const [id, c] of food) {
        if (!powerCells.has(c) || open.dist[id] < 0 || open.dist[id] > 12) continue;
        if (bestPellet < 0 || open.dist[id] < open.dist[bestPellet]) bestPellet = id;
      }
      if (bestPellet >= 0) {
        target = bestPellet;
        return firstStep(open.parent, bestPellet);
      }
    }

    const map = search(blocked);
    if (target >= 0 && food.has(target) && map.dist[target] > 0) {
      return firstStep(map.parent, target);
    }
    let best = -1;
    let bestCost = Infinity;
    for (const id of food.keys()) {
      if (map.dist[id] < 1) continue;
      const x = id % cols;
      const y = Math.floor(id / cols);
      let near = LOOKAHEAD;
      for (let dy = -LOOKAHEAD; dy <= LOOKAHEAD; dy++) {
        for (let dx = -LOOKAHEAD; dx <= LOOKAHEAD; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d === 0 || d >= near || !inside(x + dx, y + dy)) continue;
          if (food.has((y + dy) * cols + x + dx)) near = d;
        }
      }
      const cost = map.dist[id] + (endgame ? 0 : 0.45 * near);
      if (cost < bestCost) {
        bestCost = cost;
        best = id;
      }
    }
    if (best >= 0) {
      target = best;
      return firstStep(map.parent, best);
    }
    target = -1;
    // Boxed in by ghosts: step to whichever neighbour keeps the most room.
    let pick = pac.dir;
    let room = -1;
    for (let d = 0; d < 4; d++) {
      const x = pac.x + DX[d];
      const y = pac.y + DY[d];
      if (!inside(x, y)) continue;
      const gap = normals.length ? Math.min(...normals.map((g) => manhattan(g.x, g.y, x, y))) : 99;
      if (gap > room) {
        room = gap;
        pick = d;
      }
    }
    return pick;
  };

  const eatGhost = (index: number, g: Ghost, arrive: number) => {
    const [gx, gy] = positionAt(g.wps, arrive);
    const points = 200 * 2 ** Math.min(chain, 3);
    chain++;
    ghostEats.push({ t: arrive, ghost: index, points, x: gx, y: gy });
    while (g.wps.length > 1 && g.wps[g.wps.length - 1].t > arrive) g.wps.pop();
    g.wps.push({ t: arrive, x: gx, y: gy }, { t: arrive + 1, x: g.x, y: g.y });
    setMode(g, "eyes", arrive);
    g.nextAt = arrive + 1;
  };

  let u = 0;
  const limit = 400 * total;
  let end = 0;
  while (food.size > 0) {
    if (u > limit) throw new Error("Pac-Man did not clear the board within the step limit");
    if (u - lastEat > 120 && u >= calmUntil) calmUntil = u + 90;
    if (u - lastEat > 400 && u >= frightEnd) {
      // Last resort when a ghost squats on the final dots: scare them off like a power pellet would.
      frightEnd = u + FRIGHT_LENGTH;
      lastEat = u;
      chain = 0;
      for (const g of ghosts) {
        if (g.mode === "eyes") continue;
        setMode(g, "fright", u);
        g.dir = (g.dir + 2) % 4;
      }
    }

    let pacMoved = false;
    if (u >= pac.nextAt) {
      const dir = decidePac(u);
      const period = pacPeriod();
      startMove(pac, dir, u, period);
      pacMoved = true;
      const id = pac.y * cols + pac.x;
      const cell = food.get(id);
      if (cell) {
        food.delete(id);
        const power = powerCells.has(cell);
        eats.push({ t: u + period, cell, power, period });
        lastEat = u;
        if (power) {
          chain = 0;
          frightEnd = u + period + FRIGHT_LENGTH;
          for (const g of ghosts) {
            if (g.mode === "eyes") continue;
            setMode(g, "fright", u + period);
            g.dir = (g.dir + 2) % 4;
          }
        }
        if (food.size === 0) end = u + period;
      }
    }

    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (u < g.nextAt) continue;
      moveGhost(i, g, u);
      if (g.nextAt > u) g.movedAt = u;
    }

    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (g.mode !== "fright") continue;
      const met = g.x === pac.x && g.y === pac.y;
      const swapped = pacMoved && g.movedAt === u && g.x === pac.px && g.y === pac.py && g.px === pac.x && g.py === pac.y;
      if (met || swapped) eatGhost(i, g, Math.max(u + 1, pac.nextAt));
    }

    if (u >= frightEnd) {
      for (const g of ghosts) if (g.mode === "fright") setMode(g, "normal", u, true);
    }
    u++;
  }

  for (const g of ghosts) {
    if (g.since < end) g.spans.push({ mode: g.mode, from: g.since, to: end });
  }
  return {
    cols,
    rows,
    pac: pac.wps,
    ghosts: ghosts.map((g) => ({ waypoints: g.wps, spans: g.spans })),
    eats,
    ghostEats,
    end,
  };
}

function isDark(theme: Theme): boolean {
  const hex = theme.ink.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

type Interval = [number, number];

/** Opacity frames that are on inside the intervals and off outside, switching instantly. */
function toggleFrames(intervals: Interval[], duration: number, on = "opacity:1", off = "opacity:0"): Frame[] {
  const merged: Interval[] = [];
  for (const [a, b] of [...intervals].filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const frames: Frame[] = [];
  if (merged.length === 0 || merged[0][0] > 0) frames.push([0, off]);
  for (const [a, b] of merged) {
    if (a > 0) frames.push([a, off]);
    frames.push([a, on], [b, on]);
    if (b < duration - 1e-6) frames.push([b, off]);
  }
  return frames;
}

/** Drops waypoints that sit in the middle of a constant-velocity run. */
function simplify(wps: Waypoint[]): Waypoint[] {
  const out: Waypoint[] = [wps[0]];
  for (let i = 1; i < wps.length - 1; i++) {
    const a = wps[i - 1];
    const b = wps[i];
    const c = wps[i + 1];
    const same =
      b.t > a.t &&
      c.t > b.t &&
      Math.abs((b.x - a.x) * (c.t - b.t) - (c.x - b.x) * (b.t - a.t)) < 1e-9 &&
      Math.abs((b.y - a.y) * (c.t - b.t) - (c.y - b.y) * (b.t - a.t)) < 1e-9;
    if (!same) out.push(b);
  }
  if (wps.length > 1) out.push(wps[wps.length - 1]);
  return out;
}

/** Heading of every moving stretch: [start time, direction]. */
function headings(wps: Waypoint[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < wps.length; i++) {
    const dx = wps[i].x - wps[i - 1].x;
    const dy = wps[i].y - wps[i - 1].y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : dy > 0 ? 1 : 3;
    if (out.length === 0 || out[out.length - 1][1] !== dir) out.push([wps[i - 1].t, dir]);
  }
  return out;
}

const PAC_YELLOW = "#ffe600";
const FRIGHT_BLUE = "#2121ff";
const PAC_RADIUS = 7.2;

function pacPath(halfAngle: number): string {
  const a = (halfAngle * Math.PI) / 180;
  const x = PAC_RADIUS * Math.cos(a);
  const y = PAC_RADIUS * Math.sin(a);
  return `M0 0L${fmt(x)} ${fmt(-y)}A${PAC_RADIUS} ${PAC_RADIUS} 0 1 0 ${fmt(x)} ${fmt(y)}Z`;
}

function ghostPath(low: number[]): string {
  const xs = [7, 4.67, 2.33, 0, -2.33, -4.67, -7];
  const skirt = xs.slice(1, 6).map((x, i) => `L${x} ${low[i + 1]}`).join("");
  return `M-7 ${low[6]}V-1A7 7 0 0 1 7 -1V${low[0]}${skirt}Z`;
}

const SKIRT_A = [7, 4.5, 7, 4.5, 7, 4.5, 7];
const SKIRT_B = [4.5, 7, 4.5, 7, 4.5, 7, 4.5];
const LOOK = [
  [0.9, 0],
  [0, 1.4],
  [-0.9, 0],
  [0, -1.4],
];

function mixColors(a: string, b: string, k: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

/** Sprites are drawn a little bigger than a cell so they carry across the whole strip. */
const SPRITE = 1.28;
const MAZE_FLASH_BEATS = 4;
const MAZE_FLASH_BEAT = 0.25;

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const dark = isDark(theme);
  const layout = arcadeLayout(grid);
  const { width, height } = layout;

  const sim = simulatePacman(grid, ctx.rng);
  const foodCount = activeCells(grid).length;
  const hasPlay = sim.end > 0;
  const rawDt = hasPlay ? (20 + foodCount * 0.12) / sim.end : 0.05;
  const play = hasPlay ? Math.round(sim.end * Math.min(0.07, Math.max(0.03, rawDt)) * 100) / 100 : 3;
  const unit = hasPlay ? play / sim.end : 0.05;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (t: number) => PACE.intro + t * unit;
  const tEnd = at(sim.end);
  const px = (x: number, y: number): [number, number] => cellCenter(layout, x - LANE, y - LANE);

  const outline = dark ? "" : ` stroke="#000" stroke-opacity=".4" stroke-width=".8"`;
  const fadeFrames = (hideAt: number, hideFor: number): Frame[] => [
    [0, "opacity:1"],
    [hideAt, "opacity:1"],
    [hideAt + hideFor, "opacity:0"],
    [duration - 0.3, "opacity:0"],
    [duration, "opacity:1"],
  ];

  const moveFrames = (wps: Waypoint[], jumpAt: number): Frame[] => {
    const frames: Frame[] = simplify(wps).map((p) => [at(p.t), translate(...px(p.x, p.y))]);
    const last = wps[wps.length - 1];
    frames.push([jumpAt, translate(...px(last.x, last.y))], [jumpAt, translate(...px(wps[0].x, wps[0].y))]);
    return frames;
  };

  // The arcade flashes the maze walls, not the floor: a rounded outline round the graph blinks while the
  // floor only breathes, so the clear is never a full-board strobe.
  const flashStart = tEnd + 0.05;
  const flashEnd = flashStart + MAZE_FLASH_BEATS * MAZE_FLASH_BEAT;
  const wallA = FRIGHT_BLUE;
  const wallB = dark ? "#ffffff" : "#8fa6ff";
  const wallFrames: Frame[] = [[0, "opacity:0"]];
  if (hasPlay) {
    wallFrames.push([flashStart, "opacity:0"]);
    for (let k = 0; k < MAZE_FLASH_BEATS; k++) {
      const t = flashStart + k * MAZE_FLASH_BEAT;
      const css = `opacity:1;stroke:${k % 2 === 0 ? wallA : wallB}`;
      wallFrames.push([t, css], [t + MAZE_FLASH_BEAT, css]);
    }
    wallFrames.push([flashEnd, "opacity:0"]);
  }
  const wallClass = tl.track(wallFrames);
  const pulse = mixColors(theme.empty, FRIGHT_BLUE, dark ? 0.2 : 0.12);
  const floorFrames: Frame[] = [[0, `fill:${theme.empty}`]];
  if (hasPlay) {
    floorFrames.push(
      [flashStart, `fill:${theme.empty}`],
      [flashStart + 0.25, `fill:${pulse}`],
      [flashStart + 0.5, `fill:${theme.empty}`],
      [flashStart + 0.75, `fill:${pulse}`],
      [flashEnd, `fill:${theme.empty}`],
    );
  }
  const floorClass = tl.track(floorFrames);
  const wall = `<rect class="${wallClass}" x="${fmt(layout.left - 7)}" y="${fmt(layout.top - 7)}" width="${fmt(layout.gridWidth + 14)}" height="${fmt(layout.gridHeight + 14)}" rx="10" fill="none" stroke="${wallA}" stroke-width="2.5"${glowAttr(theme)}/>`;

  const floor: string[] = [];
  const dots: string[] = [];
  const eatTime = new Map<Cell, { t: number; power: boolean; period: number }>();
  for (const e of sim.eats) eatTime.set(e.cell, { t: at(e.t), power: e.power, period: e.period });
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      floor.push(cellRect(layout, cell, "inherit"));
      if (cell.level === 0) continue;
      const fill = levelColor(theme, cell);
      const eaten = eatTime.get(cell);
      const rest = "opacity:1;transform:scale(1)";
      const cls = tl.track(
        eaten
          ? [
              [0, rest],
              [eaten.t - 0.5 * eaten.period * unit, rest],
              [eaten.t + 0.1 * eaten.period * unit, "opacity:0;transform:scale(0)"],
              [restore, "opacity:0;transform:scale(0)"],
              [restore + PACE.restore, rest],
            ]
          : [[0, rest]],
      );
      if (eaten?.power) {
        const [ox, oy] = [layout.left + cell.x * layout.pitch, layout.top + cell.y * layout.pitch];
        dots.push(
          `<g class="c ${cls}">${cellRect(layout, cell, fill)}<rect x="${fmt(ox - 1.5)}" y="${fmt(oy - 1.5)}" width="${layout.cell + 3}" height="${layout.cell + 3}" rx="${layout.radius + 1}" fill="none" stroke="${theme.accent}" stroke-width="1.6"><animate attributeName="opacity" values="1;.2;1" dur=".56s" repeatCount="indefinite"/></rect></g>`,
        );
      } else {
        dots.push(cellRect(layout, cell, fill, `class="c ${cls}"`));
      }
    }
  }

  // Pac-Man
  const pacHeadings = headings(sim.pac);
  let angle = (pacHeadings[0]?.[1] ?? 0) * 90;
  const startAngle = angle;
  const rotFrames: Frame[] = [[0, `transform:rotate(${angle}deg)`]];
  for (let i = 1; i < pacHeadings.length; i++) {
    const turn = (pacHeadings[i][1] - pacHeadings[i - 1][1] + 4) % 4;
    const t = at(pacHeadings[i][0]);
    rotFrames.push([t - 0.3 * unit, `transform:rotate(${angle}deg)`]);
    angle += turn === 1 ? 90 : turn === 3 ? -90 : 180;
    rotFrames.push([t + 0.3 * unit, `transform:rotate(${angle}deg)`]);
  }
  const pacJump = Math.max(fadeEnd + 0.05, at(sim.pac[sim.pac.length - 1].t) + 0.02);
  rotFrames.push([pacJump, `transform:rotate(${angle}deg)`], [pacJump, `transform:rotate(${startAngle}deg)`]);
  const pacFade = tl.track(fadeFrames(restore - 0.4, 0.3));
  const pacPos = tl.track(moveFrames(sim.pac, pacJump));
  const pacRot = tl.track(rotFrames);
  const open = pacPath(38);
  const pac = `<g class="${pacFade}"${glowAttr(theme)}><g class="${pacPos}"><g class="${pacRot}"><g transform="scale(${SPRITE})"><path d="${open}" fill="${PAC_YELLOW}"${outline.replace(".8", ".9")}><animate attributeName="d" values="${open};${pacPath(3)};${open}" dur=".3s" repeatCount="indefinite"/></path></g></g></g></g>`;

  // Ghosts
  const frightRim = dark ? ` stroke="#dfe6ff" stroke-width="1"` : "";
  const ghostMarkup: string[] = [];
  sim.ghosts.forEach((ghost, i) => {
    const spec = GHOSTS[i];
    const span = (mode: GhostMode): Interval[] =>
      ghost.spans.filter((s) => s.mode === mode).map((s): Interval => [s.from === 0 ? 0 : at(s.from), Math.min(at(s.to), tEnd + 0.15)]);
    const hiddenAfter = tEnd + 0.15;
    const normal: Interval[] = ghost.spans.length ? span("normal") : [[0, hiddenAfter]];
    normal.push([hiddenAfter, duration]);
    const fright = span("fright");
    const flash: Interval[] = [];
    for (const s of ghost.spans) {
      if (s.mode !== "fright" || !s.timeout) continue;
      for (let k = 0; k * 6 < FLASH_LENGTH; k += 2) {
        const a = s.to - FLASH_LENGTH + k * 6 + 6;
        flash.push([at(Math.max(s.from, a)), at(Math.min(s.to, a + 6))]);
      }
    }
    const eyes = [...span("normal"), ...span("eyes"), [hiddenAfter, duration] as Interval];
    if (!ghost.spans.length) eyes.push([0, hiddenAfter]);

    const jump = Math.max(tEnd + 0.3, at(ghost.waypoints[ghost.waypoints.length - 1].t) + 0.02);
    const pos = tl.track(moveFrames(ghost.waypoints, jump));
    const fade = tl.track(fadeFrames(tEnd + 0.05, 0.1));
    const normalOp = tl.track(toggleFrames(normal, duration));
    const frightOp = tl.track(toggleFrames(fright, duration));
    const flashOp = tl.track(toggleFrames(flash, duration));
    const eyesOp = tl.track(toggleFrames(eyes, duration));

    const looks = headings(ghost.waypoints);
    const offset = (dir: number) => `transform:translate(${LOOK[dir][0]}px,${LOOK[dir][1]}px)`;
    const lookFrames: Frame[] = [[0, offset(2)]];
    let prev = 2;
    for (const [t, dir] of looks) {
      lookFrames.push([at(t), offset(prev)], [at(t) + 0.06, offset(dir)]);
      prev = dir;
    }
    lookFrames.push([jump, offset(prev)], [jump, offset(2)]);
    const lookClass = tl.track(lookFrames);

    ghostMarkup.push(
      `<g class="${fade}"${glowAttr(theme)}><g class="${pos}"><g transform="scale(${SPRITE})"${outline}>` +
        `<g class="${normalOp}"><use href="#gb" fill="${spec.color}"/></g>` +
        `<g class="${frightOp}"><use href="#gb" fill="${FRIGHT_BLUE}"${frightRim}/><use href="#gf" color="#ffb8ae"/></g>` +
        `<g class="${flashOp}"><use href="#gb" fill="#fff"/><use href="#gf" color="#f00"/></g>` +
        `<g class="${eyesOp}"><use href="#ge"/><g class="${lookClass}"><circle cx="-2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/><circle cx="2.6" cy="-1.8" r="1.25" fill="${FRIGHT_BLUE}"/></g></g>` +
        `</g></g></g>`,
    );
  });

  const popupColor = dark ? "#22e0ff" : "#0089a8";
  const popups = sim.ghostEats.map((e) => {
    const te = at(e.t);
    const [x, y] = px(e.x, e.y);
    const text = pixelText(String(e.points), 1.6);
    const cls = tl.track([
      [0, `opacity:0;${translate(x, y)}`],
      [te - 0.001, `opacity:0;${translate(x, y)}`],
      [te, `opacity:1;${translate(x, y)}`],
      [te + 0.9, `opacity:1;${translate(x, y - 6)}`],
      [te + 0.92, `opacity:0;${translate(x, y - 6)}`],
    ]);
    return `<g class="${cls}"><path d="${text.d}" transform="translate(${fmt(-text.width / 2)} ${fmt(-text.height / 2)})" fill="${popupColor}"/></g>`;
  });

  const clears: ClearEvent[] = sim.eats.map((e) => ({ t: at(e.t), cell: e.cell }));
  const bar = hud(tl, grid, { theme, title: "PAC-MAN", clears, resetAt: restore, width });

  const ready = pixelText("READY!", 3);
  const readyClass = tl.track([
    [0, "opacity:1"],
    [PACE.intro - 0.05, "opacity:1"],
    [PACE.intro + 0.15, "opacity:0"],
    [duration - 0.3, "opacity:0"],
    [duration, "opacity:1"],
  ]);
  const readyColor = dark ? PAC_YELLOW : "#b88a00";
  const readyX = (width - ready.width) / 2;
  const readyY = layout.top + (layout.gridHeight - ready.height) / 2;
  const readyMarkup =
    `<g class="${readyClass}"><rect x="${fmt(readyX - 10)}" y="${fmt(readyY - 8)}" width="${fmt(ready.width + 20)}" height="${fmt(ready.height + 16)}" rx="6" fill="${theme.surface}" fill-opacity=".9"/>` +
    `<path d="${ready.d}" transform="translate(${fmt(readyX)} ${fmt(readyY)})" fill="${readyColor}"/></g>`;

  const end = hasPlay
    ? banner(tl, {
        theme,
        lines: stageClearLines(grid),
        cx: width / 2,
        cy: layout.top + layout.gridHeight / 2,
        from: tEnd + 0.45,
        to: restore,
      })
    : "";

  const defs = [
    glowDefs(theme),
    `<path id="gb" d="${ghostPath(SKIRT_A)}"><animate attributeName="d" values="${ghostPath(SKIRT_A)};${ghostPath(SKIRT_B)}" calcMode="discrete" dur=".34s" repeatCount="indefinite"/></path>`,
    `<g id="gf"><circle cx="-2.4" cy="-2.2" r="1.15" fill="currentColor"/><circle cx="2.4" cy="-2.2" r="1.15" fill="currentColor"/><path d="M-4.7 3.4l1.57-1.6 1.57 1.6 1.56-1.6 1.57 1.6 1.57-1.6 1.56 1.6" fill="none" stroke="currentColor" stroke-width=".9"/></g>`,
    `<g id="ge"><ellipse cx="-2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/><ellipse cx="2.6" cy="-1.8" rx="2.1" ry="2.7" fill="#fff"/></g>`,
  ].join("");

  const css = `.c{transform-box:fill-box;transform-origin:center}\n${tl.css()}`;
  const body = [
    `<g class="${floorClass}">${floor.join("")}</g>`,
    wall,
    `<g>${dots.join("")}</g>`,
    ...ghostMarkup,
    pac,
    ...popups,
    bar,
    readyMarkup,
    end,
  ].join("\n");
  return { width, height, css, defs, body };
}

export const pacman: Game = { id: "pacman", title: "Pac-Man", render };
