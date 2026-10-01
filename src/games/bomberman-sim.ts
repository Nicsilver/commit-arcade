import { activeCells, type Cell, type Grid } from "../grid.ts";
import type { Rng } from "../rng.ts";

export const FUSE = 7;
export const FLAME = 4;
const START_RANGE = 2;
const MAX_RANGE = 4;
const MAX_LAYERS = 260;
const ITEM_VALUE = 100;
const SWEEP_WINDOW = 7;

export type PowerKind = "fire" | "bomb";

export interface PlantEvent {
  idx: number;
  tick: number;
  /** Final explosion tick, after chain reactions. */
  explode: number;
  range: number;
}

export interface Blast {
  idx: number;
  tick: number;
  range: number;
  /** Flame length in cells: up, down, left, right, already clipped to the arena. */
  arms: [number, number, number, number];
}

export interface BreakEvent {
  cell: Cell;
  idx: number;
  tick: number;
}

export interface ItemEvent {
  idx: number;
  kind: PowerKind;
  /** Tick the block holding it crumbled. */
  revealed: number;
  /** Tick Bomberman picked it up, or null when it was never collected. */
  taken: number | null;
}

export interface BombermanSim {
  /** Arena size in cells: the graph plus a one-cell lane on every side. */
  cols: number;
  rows: number;
  /** Cell index of Bomberman at every tick. */
  path: number[];
  plants: PlantEvent[];
  blasts: Blast[];
  breaks: BreakEvent[];
  items: ItemEvent[];
  /** Length of the play phase in ticks, including the last flames dying out. */
  ticks: number;
}

interface Bomb {
  cell: number;
  plant: number;
  range: number;
  explode: number;
  event: PlantEvent;
}

interface Hazard {
  spans: (number[] | undefined)[];
  /** Tick after which a cell is never in flames again. */
  last: Int32Array;
  end: number;
}

interface Env {
  block: Uint8Array;
  bombs: Bomb[];
  haz: Hazard;
}

interface Step {
  to: number;
  plant?: boolean;
}

interface Reach {
  t0: number;
  layers: Int16Array[];
  first: Int32Array;
  found: { cell: number; k: number } | null;
}

export function simulateBomberman(grid: Grid, rng: Rng): BombermanSim {
  const cols = grid.width + 2;
  const rows = grid.height + 2;
  const n = cols * rows;
  const block = new Uint8Array(n);
  const cellOf = new Map<number, Cell>();
  for (const c of activeCells(grid)) {
    const idx = (c.y + 1) * cols + c.x + 1;
    block[idx] = 1;
    cellOf.set(idx, c);
  }
  const nbrs: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = i % cols;
    const y = (i - x) / cols;
    const list: number[] = [];
    if (y > 0) list.push(i - cols);
    if (y < rows - 1) list.push(i + cols);
    if (x > 0) list.push(i - 1);
    if (x < cols - 1) list.push(i + 1);
    nbrs.push(list);
  }

  const flameCells = (idx: number, range: number): number[] => {
    const out = [idx];
    const x = idx % cols;
    const y = (idx - x) / cols;
    for (let k = 1; k <= range; k++) {
      if (y - k >= 0) out.push(idx - k * cols);
      if (y + k < rows) out.push(idx + k * cols);
      if (x - k >= 0) out.push(idx - k);
      if (x + k < cols) out.push(idx + k);
    }
    return out;
  };

  const inLine = (a: number, b: number, range: number): boolean => {
    const ax = a % cols;
    const ay = (a - ax) / cols;
    const bx = b % cols;
    const by = (b - bx) / cols;
    return (ay === by && Math.abs(ax - bx) <= range) || (ax === bx && Math.abs(ay - by) <= range);
  };

  /** Chain reactions: a blast that reaches another planted bomb sets it off at the same tick. */
  const resolve = (bombs: Bomb[]) => {
    for (const b of bombs) b.explode = b.plant + FUSE;
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of bombs) {
        for (const b of bombs) {
          if (a !== b && b.explode > a.explode && b.plant <= a.explode && inLine(a.cell, b.cell, a.range)) {
            b.explode = a.explode;
            changed = true;
          }
        }
      }
    }
  };

  const buildHazard = (bombs: Bomb[]): Hazard => {
    const spans: (number[] | undefined)[] = new Array(n);
    const last = new Int32Array(n);
    let end = 0;
    for (const b of bombs) {
      for (const c of flameCells(b.cell, b.range)) {
        (spans[c] ??= []).push(b.explode, b.explode + FLAME);
        last[c] = Math.max(last[c], b.explode + FLAME);
      }
      end = Math.max(end, b.explode + FLAME);
    }
    return { spans, last, end };
  };

  const flamed = (h: Hazard, cell: number, tick: number): boolean => {
    const s = h.spans[cell];
    if (!s) return false;
    for (let i = 0; i < s.length; i += 2) if (tick >= s[i] && tick < s[i + 1]) return true;
    return false;
  };

  const bombAt = (bombs: Bomb[], cell: number, tick: number): boolean =>
    bombs.some((b) => b.cell === cell && b.plant <= tick && tick < b.explode);

  /**
   * Time-expanded breadth-first search: layer k holds every cell Bomberman can
   * stand on at tick t0 + k without ever touching flames, waiting included.
   */
  const search = (env: Env, start: number, t0: number, goal?: (cell: number, tick: number) => boolean): Reach => {
    const first = new Int32Array(n).fill(-1);
    const l0 = new Int16Array(n).fill(-1);
    l0[start] = start;
    first[start] = t0;
    const layers = [l0];
    const result: Reach = { t0, layers, first, found: null };
    if (goal?.(start, t0)) {
      result.found = { cell: start, k: 0 };
      return result;
    }
    let cur = [start];
    for (let k = 0; k < MAX_LAYERS; k++) {
      const tau = t0 + k;
      const par = new Int16Array(n).fill(-1);
      const next: number[] = [];
      let fresh = 0;
      for (const u of cur) {
        const options = [u, ...nbrs[u]];
        for (const v of options) {
          if (par[v] !== -1) continue;
          if (v !== u && (env.block[v] || bombAt(env.bombs, v, tau + 1))) continue;
          if (flamed(env.haz, v, tau) || flamed(env.haz, v, tau + 1)) continue;
          par[v] = u;
          next.push(v);
          if (first[v] < 0) {
            first[v] = tau + 1;
            fresh++;
          }
          if (goal && !result.found && goal(v, tau + 1)) result.found = { cell: v, k: k + 1 };
        }
      }
      layers.push(par);
      if (result.found) return result;
      cur = next;
      if (next.length === 0) break;
      if (tau > env.haz.end + 2 && fresh === 0) break;
    }
    return result;
  };

  const trace = (r: Reach, cell: number, k: number): number[] => {
    const out: number[] = new Array(k + 1);
    out[k] = cell;
    for (let i = k; i > 0; i--) {
      cell = r.layers[i][cell];
      out[i - 1] = cell;
    }
    return out;
  };

  let blocksLeft = cellOf.size;
  const total = blocksLeft;
  const drops: { at: number; kind: PowerKind }[] =
    total >= 50
      ? [
          { at: Math.round(total * 0.06), kind: "bomb" },
          { at: Math.round(total * 0.2), kind: "fire" },
          { at: Math.round(total * 0.4), kind: "bomb" },
          { at: Math.round(total * 0.6), kind: "fire" },
        ]
      : total >= 24
        ? [
            { at: Math.round(total * 0.15), kind: "bomb" },
            { at: Math.round(total * 0.4), kind: "fire" },
          ]
        : total >= 10
          ? [{ at: Math.round(total * 0.4), kind: "fire" }]
          : [];

  let tick = 0;
  let pos = 0;
  let range = START_RANGE;
  let maxBombs = 1;
  let broken = 0;
  let nextDrop = 0;
  let bombs: Bomb[] = [];
  // Exploded bombs whose flames are still burning: no longer solid or chainable, still deadly.
  let spent: Bomb[] = [];
  let plan: Step[] = [];
  let idle = 0;
  let lastBlast = 0;
  const path = [pos];
  const plants: PlantEvent[] = [];
  const blasts: Blast[] = [];
  const breaks: BreakEvent[] = [];
  const itemEvents: ItemEvent[] = [];
  const items = new Map<number, ItemEvent>();

  const pendingBlocks = (): Uint8Array => {
    const pending = new Uint8Array(n);
    for (const b of bombs) for (const c of flameCells(b.cell, b.range)) if (block[c]) pending[c] = 1;
    return pending;
  };

  const gainAt = (idx: number, r: number, pending: Uint8Array): number => {
    let g = 0;
    for (const c of flameCells(idx, r)) if (block[c] && !pending[c]) g++;
    return g;
  };

  const decide = (r: number): Step[] => {
    resolve(bombs);
    spent = spent.filter((b) => b.explode + FLAME > tick);
    const env: Env = { block, bombs, haz: buildHazard([...bombs, ...spent]) };
    const reach = search(env, pos, tick);
    const pending = pendingBlocks();
    const cands: { idx: number; score: number; item: boolean }[] = [];
    let frontier = cols;
    for (const idx of cellOf.keys()) if (block[idx]) frontier = Math.min(frontier, idx % cols);
    for (let idx = 0; idx < n; idx++) {
      const arrive = reach.first[idx];
      if (arrive < 0 || block[idx]) continue;
      const cost = arrive - tick;
      if (items.has(idx) && env.haz.last[idx] <= arrive) cands.push({ idx, score: ITEM_VALUE - cost * 0.01, item: true });
      if (blocksLeft > 0 && idx % cols <= frontier + SWEEP_WINDOW) {
        const g = gainAt(idx, r, pending);
        if (g > 0) cands.push({ idx, score: g / (cost + 4), item: false });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.idx - b.idx);

    for (const cand of cands.slice(0, 40)) {
      const arrive = reach.first[cand.idx];
      const toCell = trace(reach, cand.idx, arrive - tick);
      const steps: Step[] = toCell.slice(1).map((to) => ({ to }));
      if (cand.item) return steps;

      const alive = bombs.filter((b) => b.plant <= arrive && arrive < b.explode);
      let plantAt = arrive;
      if (alive.length >= maxBombs) {
        const times = alive.map((b) => b.explode).sort((a, b) => a - b);
        plantAt = times[alive.length - maxBombs];
      }
      let safe = true;
      for (let t = arrive; t <= plantAt && safe; t++) if (flamed(env.haz, cand.idx, t)) safe = false;
      if (!safe) continue;

      const hypo: Bomb[] = bombs.map((b) => ({ ...b }));
      hypo.push({ cell: cand.idx, plant: plantAt, range: r, explode: plantAt + FUSE, event: null as unknown as PlantEvent });
      resolve(hypo);
      const haz1 = buildHazard([...hypo, ...spent]);
      const escape = search({ block, bombs: hypo, haz: haz1 }, cand.idx, plantAt, (cell, t) => haz1.last[cell] <= t);
      if (!escape.found) continue;

      const out = trace(escape, escape.found.cell, escape.found.k);
      for (let t = arrive; t < plantAt; t++) steps.push({ to: cand.idx });
      out.slice(1).forEach((to, i) => steps.push(i === 0 ? { to, plant: true } : { to }));
      return steps;
    }
    return [];
  };

  const explodeDue = () => {
    const due = bombs.filter((b) => b.explode === tick);
    if (due.length === 0) return;
    const hit = new Set<number>();
    for (const b of due) {
      const x = b.cell % cols;
      const y = (b.cell - x) / cols;
      blasts.push({
        idx: b.cell,
        tick,
        range: b.range,
        arms: [Math.min(b.range, y), Math.min(b.range, rows - 1 - y), Math.min(b.range, x), Math.min(b.range, cols - 1 - x)],
      });
      b.event.explode = tick;
      for (const c of flameCells(b.cell, b.range)) if (block[c]) hit.add(c);
    }
    lastBlast = tick;
    spent.push(...due);
    bombs = bombs.filter((b) => b.explode !== tick);
    const batch = [...hit].sort((a, b) => a - b);
    for (const c of batch) {
      block[c] = 0;
      blocksLeft--;
      broken++;
      breaks.push({ cell: cellOf.get(c)!, idx: c, tick });
    }
    while (nextDrop < drops.length && broken >= drops[nextDrop].at && batch.length > 0) {
      const spot = batch[Math.floor(rng() * batch.length)];
      const item: ItemEvent = { idx: spot, kind: drops[nextDrop].kind, revealed: tick, taken: null };
      items.set(spot, item);
      itemEvents.push(item);
      nextDrop++;
      break;
    }
  };

  for (;;) {
    explodeDue();
    if (blocksLeft === 0 && bombs.length === 0) plan = [];
    if (plan.length === 0) {
      plan = decide(range);
      if (plan.length === 0 && blocksLeft > 0 && bombs.length === 0) plan = decide(1);
      if (plan.length === 0) {
        if (blocksLeft === 0 && bombs.length === 0) break;
        if (++idle > 80) throw new Error("Bomberman cannot reach the remaining blocks");
      } else {
        idle = 0;
      }
    }
    const step = plan.shift() ?? { to: pos };
    if (step.plant) {
      const event: PlantEvent = { idx: pos, tick, explode: tick + FUSE, range };
      plants.push(event);
      bombs.push({ cell: pos, plant: tick, range, explode: tick + FUSE, event });
      resolve(bombs);
    }
    pos = step.to;
    tick++;
    path.push(pos);
    const item = items.get(pos);
    if (item && item.taken === null) {
      item.taken = tick;
      items.delete(pos);
      if (item.kind === "fire") range = Math.min(MAX_RANGE, range + 1);
      else maxBombs = Math.min(3, maxBombs + 1);
    }
    if (tick > 6000) throw new Error("Bomberman ran out of time");
  }

  return { cols, rows, path, plants, blasts, breaks, items: itemEvents, ticks: total === 0 ? 0 : Math.max(tick, lastBlast + FLAME) };
}
