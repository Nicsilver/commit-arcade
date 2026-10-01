import { Timeline, fmt, translate, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { activeCells, allCells, type Cell, type Grid } from "../grid.ts";
import type { Rng } from "../rng.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { cellRect, type Layout } from "../svg.ts";
import type { Theme } from "../theme.ts";
import { bitmapPath, pixelText } from "../pixel-font.ts";

const OCTOPUS = [
  [
    "....####....",
    ".##########.",
    "############",
    "###..##..###",
    "############",
    "...##..##...",
    "..##.##.##..",
    "##........##",
  ],
  [
    "....####....",
    ".##########.",
    "############",
    "###..##..###",
    "############",
    "..###..###..",
    ".##..##..##.",
    "..##....##..",
  ],
];
const CRAB = [
  [
    "..#.....#..",
    "...#...#...",
    "..#######..",
    ".##.###.##.",
    "###########",
    "#.#######.#",
    "#.#.....#.#",
    "...##.##...",
  ],
  [
    "..#.....#..",
    "#..#...#..#",
    "#.#######.#",
    "###.###.###",
    "###########",
    ".#########.",
    "..#.....#..",
    ".#.......#.",
  ],
];
const SQUID = [
  [
    "...##...",
    "..####..",
    ".######.",
    "##.##.##",
    "########",
    "..#..#..",
    ".#.##.#.",
    "#.#..#.#",
  ],
  [
    "...##...",
    "..####..",
    ".######.",
    "##.##.##",
    "########",
    ".#.##.#.",
    "#......#",
    ".#....#.",
  ],
];
const SPECIES = [OCTOPUS, OCTOPUS, CRAB, SQUID];
const SPRITE_ID = ["o", "o", "c", "s"];
const BLAST = [
  "..#...#...#..",
  "...#..#..#...",
  "....#.#.#....",
  "###.......###",
  "....#.#.#....",
  "...#..#..#...",
  "..#...#...#..",
];
const UFO = [
  ".....######.....",
  "...##########...",
  "..############..",
  ".##.##.##.##.##.",
  "################",
  "..###..##..###..",
  "...#........#...",
];
const CANNON = [
  "......#......",
  ".....###.....",
  ".....###.....",
  ".###########.",
  "#############",
  "#############",
  "#############",
  "#############",
];
const SPLAT = [".#..#.", "#.##.#", ".####.", "#.##.#", ".#..#."];
const BUNKER = [
  "..#########..",
  ".###########.",
  "#############",
  "#############",
  "#############",
  "#############",
  "####.....####",
  "###.......###",
];
const ZIGZAG = [1, 2, 1, 0];
const bombRows = (phase: number) => Array.from({ length: 7 }, (_, y) => ".".repeat(ZIGZAG[(y + phase) % 4]) + "#" + ".".repeat(2 - ZIGZAG[(y + phase) % 4]));

/** Each species is scaled so its classic sprite spans the whole 12px cell. */
const SPRITE_SCALE = [1, 1, 12 / 11, 1.5];
const BLAST_SCALE = 1.25;
const CANNON_SCALE = 2;
const UFO_SCALE = 1.5;
const CANNON_HALF = 13;
const SHOT_SPEED = 620;
const BOMB_SPEED = 170;
const UFO_SPEED = 190;
const CANNON_SPEED = 650;
const HOLD = 0.04;
const SWAY = [0, 2, 4, 6, 8, 6, 4, 2, 0, -2, -4, -6, -8, -6, -4, -2];
const TARGET_PLAY = 38;
const BUNKER_TILE = 2;
const BUNKER_COLS = 13;
const BUNKER_ROWS = 8;
const UFO_AFTER = [0.15, 0.55];
/** Below this share of invaders left the cannon speeds up and fires faster. */
const RUSH_SHARE = 0.3;
/** Shots that may chip one bunker; bombs do the rest of the damage. */
const SHOT_CHIPS_PER_BUNKER = 2;
/** Penalty for firing from under a bunker, in the same units as the planner's travel cost. */
const BUNKER_LANE_COST = 70;
const SHOT_H = 10;
const SHOT_LEAD = 6;

interface Field {
  layout: Layout;
  width: number;
  height: number;
  ufoY: number;
  cannonY: number;
  groundY: number;
  bunkerTop: number;
  bunkerX: number[];
  startX: number;
}

function makeField(grid: Grid): Field {
  const layout = arcadeLayout(grid);
  const bottom = layout.top + layout.gridHeight;
  const bunkerWidth = BUNKER_COLS * BUNKER_TILE;
  const slot = (layout.gridWidth + 4) / 4;
  return {
    layout,
    width: layout.width,
    height: layout.height,
    ufoY: 33,
    bunkerTop: bottom + 12,
    cannonY: bottom + 34,
    groundY: bottom + 54,
    bunkerX: [0, 1, 2, 3].map((i) => Math.round(layout.left + slot * (i + 0.5) - bunkerWidth / 2 - 2)),
    startX: Math.round(layout.width / 2),
  };
}

const species = (cell: Cell) => cell.level - 1;
const columnX = (layout: Layout, col: number) => layout.left + col * layout.pitch + layout.cell / 2;
const spriteHeight = (cell: Cell) => 8 * SPRITE_SCALE[species(cell)];
const spriteTop = (layout: Layout, cell: Cell) => layout.top + cell.y * layout.pitch + (layout.cell - spriteHeight(cell)) / 2;
const spriteBottom = (layout: Layout, cell: Cell) => spriteTop(layout, cell) + spriteHeight(cell);

interface March {
  times: number[];
  offsets: number[];
}

function buildMarch(aliveAt: (t: number) => number, total: number, end: number): March {
  const times: number[] = [];
  const offsets: number[] = [];
  let t = 0;
  for (let k = 1; ; k++) {
    const alive = Math.max(1, aliveAt(t));
    t += 0.1 + 0.42 * Math.pow(alive / total, 0.7);
    if (t > end) break;
    times.push(t);
    offsets.push(SWAY[k % SWAY.length]);
  }
  return { times, offsets };
}

export function offsetAt(m: March, t: number): number {
  let lo = -1;
  let hi = m.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo < 0 ? 0 : m.offsets[lo];
}

export interface Shot {
  /** Seconds after the play starts. */
  fire: number;
  hit: number;
  x: number;
  /** Where the shot's tip ends up. */
  y: number;
  cell: Cell | null;
}

export interface Ufo {
  start: number;
  /** +1 crosses left to right. */
  dir: 1 | -1;
  /** Seconds after the play starts at which it is shot down, or null when it escapes. */
  hit: number | null;
  hitX: number;
  score: number;
}

export interface Bomb {
  t: number;
  x: number;
  y0: number;
  y1: number;
  end: number;
  /** Bunker chip it caused, as removed tiles. */
  kind: "ground" | "bunker";
}

export interface Chip {
  t: number;
  tiles: [bunker: number, col: number, row: number][];
}

export interface InvadersPlay {
  field: Field;
  march: March;
  shots: Shot[];
  kills: { cell: Cell; t: number; x: number }[];
  ufos: Ufo[];
  bombs: Bomb[];
  chips: Chip[];
  length: number;
  cannonPath: { t: number; x: number }[];
}

interface Plan {
  shots: Shot[];
  ufos: Ufo[];
  kills: Map<Cell, number>;
  killX: Map<Cell, number>;
}

function planShots(field: Field, grid: Grid, cells: Cell[], march: March, fireGap: number, rng: Rng): Plan {
  const { layout, cannonY, ufoY } = field;
  const cols = grid.width;
  const columns: Cell[][] = Array.from({ length: cols }, () => []);
  for (const c of cells) columns[c.x].push(c);
  for (const col of columns) col.sort((a, b) => b.y - a.y);
  const total = cells.length;
  const lock = new Array<number>(cols).fill(-Infinity);
  const plan: Plan = { shots: [], ufos: [], kills: new Map(), killX: new Map() };
  let remaining = total;
  let lastFire = -fireGap;
  let cannonX = field.startX;
  let lastDir = 0;
  let pending = null as { fire: number; hit: number; x: number; ufo: Ufo } | null;
  const ufoFlight = (cannonY - SHOT_LEAD - (ufoY + 7 * UFO_SCALE)) / SHOT_SPEED;
  const lanes = field.bunkerX.map((x) => [x - 3, x + BUNKER_COLS * BUNKER_TILE + 3] as const);
  const underBunker = (x: number) => lanes.some(([a, b]) => x > a && x < b);

  const tryPlanUfo = () => {
    const clear = [];
    for (let c = 0; c < cols; c++) if (columns[c].length === 0) clear.push(c);
    if (clear.length === 0) return;
    clear.sort((a, b) => Math.abs(columnX(layout, a) - cannonX) - Math.abs(columnX(layout, b) - cannonX));
    const col = clear[0];
    let lastKill = lastFire;
    for (const c of cells) if (c.x === col) lastKill = Math.max(lastKill, plan.kills.get(c) ?? 0);
    let best: { hit: number; x: number; dir: 1 | -1 } | null = null;
    for (const dir of [1, -1] as const) {
      const startX = dir > 0 ? -10 : field.width + 10;
      let hit = lastFire + 1;
      let x = columnX(layout, col);
      for (let i = 0; i < 3; i++) {
        x = columnX(layout, col) + offsetAt(march, hit);
        const cross = Math.abs(x - startX) / UFO_SPEED;
        hit = Math.max(
          lastFire + 0.2 + cross,
          lastFire + fireGap + HOLD + Math.abs(x - cannonX) / CANNON_SPEED + 0.1 + ufoFlight,
          lastKill + ufoFlight + 0.1,
        );
      }
      x = columnX(layout, col) + offsetAt(march, hit);
      if (!best || hit < best.hit) best = { hit, x, dir };
    }
    if (!best) return;
    const scores = [50, 100, 150, 300];
    const ufo: Ufo = {
      start: best.hit - Math.abs(best.x - (best.dir > 0 ? -10 : field.width + 10)) / UFO_SPEED,
      dir: best.dir,
      hit: best.hit,
      hitX: best.x,
      score: scores[Math.floor(rng() * scores.length)],
    };
    plan.ufos.push(ufo);
    pending = { fire: best.hit - ufoFlight, hit: best.hit, x: best.x, ufo };
  };

  const fireUfo = () => {
    const p = pending!;
    plan.shots.push({ fire: p.fire, hit: p.hit, x: p.x, y: ufoY + 7 * UFO_SCALE, cell: null });
    lastDir = Math.sign(p.x - cannonX) || lastDir;
    lastFire = p.fire;
    cannonX = p.x;
    pending = null;
  };

  while (remaining > 0 || pending) {
    if (!pending && plan.ufos.length < UFO_AFTER.length && (total - remaining) / total >= UFO_AFTER[plan.ufos.length]) tryPlanUfo();
    if (remaining === 0) {
      fireUfo();
      continue;
    }

    const rush = Math.max(0, 1 - remaining / (total * RUSH_SHARE));
    const gap = fireGap * (1 - 0.65 * rush);
    const speed = CANNON_SPEED * (1 + 1.6 * rush);
    let best: { col: number; fire: number; hit: number; x: number; cost: number } | null = null;
    for (let col = 0; col < cols; col++) {
      const cell = columns[col][0];
      if (!cell) continue;
      const bottom = spriteBottom(layout, cell);
      const flight = (cannonY - SHOT_LEAD - bottom) / SHOT_SPEED;
      let fire = lastFire + gap;
      let hit = fire + flight;
      let x = columnX(layout, col) + offsetAt(march, hit);
      for (let i = 0; i < 3; i++) {
        fire = Math.max(lastFire + gap, lastFire + HOLD + Math.abs(x - cannonX) / speed);
        hit = fire + flight;
        x = columnX(layout, col) + offsetAt(march, hit);
      }
      if (fire < lock[col]) continue;
      const dx = x - cannonX;
      const dir = Math.sign(dx);
      const cost = Math.abs(dx) + (dir !== 0 && dir !== lastDir && Math.abs(dx) > 3 ? 22 : 0) + 2.5 * columns[col].length + (underBunker(x) ? BUNKER_LANE_COST : 0) + rng() * 5;
      if (!best || cost < best.cost) best = { col, fire, hit, x, cost };
    }
    if (!best) {
      // Every column still has a shot in the air; wait for the first to land.
      lastFire += gap;
      continue;
    }
    if (pending && best.fire + HOLD + Math.abs(pending.x - best.x) / speed > pending.fire) {
      fireUfo();
      continue;
    }
    const cell = columns[best.col].shift()!;
    plan.shots.push({ fire: best.fire, hit: best.hit, x: best.x, y: spriteBottom(layout, cell), cell });
    plan.kills.set(cell, best.hit);
    plan.killX.set(cell, best.x);
    lock[best.col] = best.hit;
    lastDir = Math.sign(best.x - cannonX) || lastDir;
    lastFire = best.fire;
    cannonX = best.x;
    remaining--;
  }
  return plan;
}

export function simulateInvaders(grid: Grid, rng: Rng): InvadersPlay {
  const field = makeField(grid);
  const { layout } = field;
  const cells = activeCells(grid);
  const total = cells.length;
  const play: InvadersPlay = {
    field,
    march: { times: [], offsets: [] },
    shots: [],
    kills: [],
    ufos: [],
    bombs: [],
    chips: [],
    length: 5.6,
    cannonPath: [{ t: 0, x: field.startX }],
  };

  const fireGap = Math.min(0.5, Math.max(0.1, TARGET_PLAY / Math.max(total, 1)));
  if (total === 0) {
    play.march = buildMarch(() => 1, 1, 0);
    play.ufos.push({ start: 0.3, dir: 1, hit: null, hitX: 0, score: 0 });
    play.cannonPath.push({ t: 1.4, x: field.startX - 36 }, { t: 3.2, x: field.startX + 36 }, { t: 4.6, x: field.startX });
    return play;
  }

  let aliveAt = (t: number) => total * (1 - t / (total * fireGap * 1.4));
  let march = buildMarch(aliveAt, total, total * fireGap * 1.6 + 8);
  let plan = planShots(field, grid, cells, march, fireGap, rng);
  for (let pass = 0; pass < 2; pass++) {
    const times = [...plan.kills.values()].sort((a, b) => a - b);
    const end = (times[times.length - 1] ?? 0) + 2;
    aliveAt = (t: number) => {
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      return total - lo;
    };
    march = buildMarch(aliveAt, total, end);
    plan = planShots(field, grid, cells, march, fireGap, rng);
  }
  play.march = march;
  play.shots = plan.shots;
  play.ufos = plan.ufos;
  play.kills = cells.map((cell) => ({ cell, t: plan.kills.get(cell)!, x: plan.killX.get(cell)! })).sort((a, b) => a.t - b.t);

  for (const s of plan.shots) {
    play.cannonPath.push({ t: s.fire, x: s.x }, { t: s.fire + HOLD, x: s.x });
  }
  const lastHit = Math.max(...plan.shots.map((s) => s.hit));
  const cannonAt = (t: number) => {
    const p = play.cannonPath;
    let i = 0;
    while (i < p.length - 1 && p[i + 1].t <= t) i++;
    if (i >= p.length - 1) return p[p.length - 1].x;
    const f = (t - p[i].t) / Math.max(p[i + 1].t - p[i].t, 1e-6);
    return p[i].x + (p[i + 1].x - p[i].x) * Math.min(Math.max(f, 0), 1);
  };

  const killTime = plan.kills;
  const aliveBelow = (col: number, t: number): Cell | null => {
    let found: Cell | null = null;
    for (const c of cells) {
      if (c.x === col && (killTime.get(c) ?? 0) > t && (!found || c.y > found.y)) found = c;
    }
    return found;
  };

  // Bombs: a random invader drops one every second or so, preferring columns above a bunker.
  const bombs: { t: number; x: number; y0: number }[] = [];
  const bunkerSpan = field.bunkerX.map((x) => [x, x + BUNKER_COLS * BUNKER_TILE] as const);
  const colsList = Array.from({ length: grid.width }, (_, i) => i);
  for (let t = 1.1 + rng() * 0.6; t < lastHit - 0.8; t += 0.8 + rng() * 0.9) {
    const offset = offsetAt(march, t);
    const options = colsList
      .map((col) => ({ col, cell: aliveBelow(col, t) }))
      .filter((o): o is { col: number; cell: Cell } => o.cell !== null);
    if (options.length === 0) break;
    const over = options.filter((o) => {
      const x = columnX(layout, o.col) + offset;
      return bunkerSpan.some(([a, b]) => x > a && x < b);
    });
    const pool = over.length > 0 && rng() < 0.5 ? over : options;
    for (let tries = 0; tries < 8; tries++) {
      const pick = pool[Math.floor(rng() * pool.length)];
      const x = columnX(layout, pick.col) + offset;
      const y0 = spriteBottom(layout, pick.cell);
      const reaches = t + (field.cannonY - 7 - y0) / BOMB_SPEED;
      if (Math.abs(cannonAt(reaches) - x) < CANNON_HALF + 6 || Math.abs(cannonAt(reaches + 0.12) - x) < CANNON_HALF + 6) continue;
      bombs.push({ t, x, y0 });
      break;
    }
  }

  // Bunkers: bombs and shots passing through are resolved in the order they happen.
  const tiles = field.bunkerX.map(() => BUNKER.map((row) => [...row].map((ch) => ch === "#")));
  const bunkerAt = (x: number) => bunkerSpan.findIndex(([a, b]) => x >= a && x < b);
  type Hit = { t: number; kind: "bomb"; index: number } | { t: number; kind: "shot"; x: number };
  const events: Hit[] = [];
  bombs.forEach((b, index) => events.push({ t: b.t + (field.bunkerTop - 7 - b.y0) / BOMB_SPEED, kind: "bomb", index }));
  for (const s of plan.shots) {
    events.push({ t: s.fire + (field.cannonY - SHOT_LEAD - (field.bunkerTop + BUNKER_ROWS * BUNKER_TILE)) / SHOT_SPEED, kind: "shot", x: s.x });
  }
  events.sort((a, b) => a.t - b.t);
  const resolved: Bomb[] = new Array(bombs.length);
  const shotChips = field.bunkerX.map(() => 0);
  for (const ev of events) {
    if (ev.kind === "shot") {
      const b = bunkerAt(ev.x);
      if (b < 0 || shotChips[b] >= SHOT_CHIPS_PER_BUNKER) continue;
      shotChips[b]++;
      const col = Math.floor((ev.x - field.bunkerX[b]) / BUNKER_TILE);
      const removed: Chip["tiles"] = [];
      for (let row = BUNKER_ROWS - 1, taken = 0; row >= 0 && taken < 2; row--) {
        if (!tiles[b][row][col]) continue;
        tiles[b][row][col] = false;
        removed.push([b, col, row]);
        taken++;
        if (rng() < 0.55) break;
      }
      if (removed.length) play.chips.push({ t: ev.t, tiles: removed });
      continue;
    }
    const bomb = bombs[ev.index];
    const b = bunkerAt(bomb.x);
    let row = -1;
    let col = 0;
    if (b >= 0) {
      col = Math.floor((bomb.x - field.bunkerX[b]) / BUNKER_TILE);
      for (let r = 0; r < BUNKER_ROWS; r++) {
        if (tiles[b][r][col]) {
          row = r;
          break;
        }
      }
    }
    if (row < 0) {
      const y1 = field.groundY - 7;
      resolved[ev.index] = { ...bomb, y1, end: bomb.t + (y1 - bomb.y0) / BOMB_SPEED, kind: "ground" };
      continue;
    }
    const y1 = field.bunkerTop + row * BUNKER_TILE - 7;
    const end = bomb.t + (y1 - bomb.y0) / BOMB_SPEED;
    resolved[ev.index] = { ...bomb, y1, end, kind: "bunker" };
    const radius = 1.6 + rng() * 0.9;
    const removed: Chip["tiles"] = [];
    for (let r = 0; r < BUNKER_ROWS; r++) {
      for (let c = 0; c < BUNKER_COLS; c++) {
        if (!tiles[b][r][c]) continue;
        const dist = Math.hypot(c - col, (r - (row + 1)) * 0.9);
        if (dist <= radius - 0.6 || (dist <= radius && rng() < 0.55)) {
          tiles[b][r][c] = false;
          removed.push([b, c, r]);
        }
      }
    }
    if (removed.length) play.chips.push({ t: end, tiles: removed });
  }
  play.bombs = resolved.filter(Boolean);

  if (play.ufos.length === 0) {
    play.ufos.push({ start: Math.max(1, lastHit * 0.3), dir: rng() < 0.5 ? 1 : -1, hit: null, hitX: 0, score: 0 });
  }
  const ufoEnd = Math.max(...play.ufos.map((u) => u.hit ?? u.start + (field.width + 16) / UFO_SPEED));
  play.length = Math.max(lastHit + 0.3, ufoEnd + 0.1, ...play.bombs.map((b) => b.end + 0.25));
  return play;
}

const tri = (t: number, ...css: string[]) => css.map((c) => [t, c] as Frame);

function render(ctx: GameContext): GameOutput {
  const { grid, theme, rng } = ctx;
  const sim = simulateInvaders(grid, rng);
  const { field } = sim;
  const { layout } = field;
  const play = sim.length;
  const duration = loopDuration(play);
  const back = restoreAt(play);
  const intro = PACE.intro;
  const at = (t: number) => intro + t;
  const tl = new Timeline(duration, "i");
  const light = parseInt(theme.ink.slice(1, 3), 16) < 0x80;
  // Classic phosphor green on GitHub dark; the other palettes get hardware colours that fit them.
  const green = theme.name === "github-dark" ? "#20ff20" : light ? "#1a7f37" : theme.accent;
  const red = light ? "#cf222e" : theme.name === "github-dark" ? "#ff3b3b" : "#ff4d6d";
  const glow = glowAttr(theme);
  // A filter over hundreds of animated sprites renders as a black patch in Chromium, so sprites get a faint outline instead.
  const halo = (color: string) => (theme.glow > 0 ? ` stroke="${color}" stroke-opacity=".3" stroke-width="${theme.glow > 2 ? 2.6 : 1.8}" stroke-linejoin="round"` : "");
  const ink = theme.ink;
  const delay = (t: number) => `style="--d:${(-(duration - at(t))).toFixed(3)}s"`;
  const empty = sim.kills.length === 0;

  const defs: string[] = [];
  const names = ["o", "c", "s"];
  [OCTOPUS, CRAB, SQUID].forEach((frames, i) => {
    frames.forEach((rows, f) => defs.push(`<path id="${names[i]}${f}" d="${bitmapPath(rows, [SPRITE_SCALE[0], SPRITE_SCALE[2], SPRITE_SCALE[3]][i])}"/>`));
  });
  defs.push(`<path id="bl" d="${bitmapPath(BLAST, BLAST_SCALE)}"/>`, `<path id="sp" d="${bitmapPath(SPLAT)}"/>`);
  defs.push(`<path id="uf" d="${bitmapPath(UFO, UFO_SCALE)}"/>`, `<path id="cn" d="${bitmapPath(CANNON, CANNON_SCALE)}"/>`);
  for (let i = 0; i < 4; i++) defs.push(`<path id="bm${i}" d="${bitmapPath(bombRows(i))}"/>`);

  const parts: string[] = [];
  for (const cell of allCells(grid)) parts.push(cellRect(layout, cell, theme.empty));

  // Formation: one stepped translate, with the leg frames flipping on the same beats.
  const marchFrames: Frame[] = [[0, "transform:translate(0px,0px)"]];
  const legA: Frame[] = [[0, "opacity:1"]];
  const legB: Frame[] = [[0, "opacity:0"]];
  const lastKill = sim.kills.length ? sim.kills[sim.kills.length - 1].t : 0;
  sim.march.times.forEach((t, i) => {
    if (t > lastKill + 0.01) return;
    const T = at(t);
    const showA = (i + 1) % 2 === 0;
    marchFrames.push([T, marchFrames[marchFrames.length - 1][1]], [T, translate(sim.march.offsets[i], 0)]);
    legA.push([T, `opacity:${showA ? 0 : 1}`], [T, `opacity:${showA ? 1 : 0}`]);
    legB.push([T, `opacity:${showA ? 1 : 0}`], [T, `opacity:${showA ? 0 : 1}`]);
  });
  marchFrames.push([at(lastKill) + 0.05, marchFrames[marchFrames.length - 1][1]], [at(lastKill) + 0.05, "transform:translate(0px,0px)"]);
  legA.push([at(lastKill) + 0.05, "opacity:1"]);
  legB.push([at(lastKill) + 0.05, "opacity:0"]);
  const marchClass = tl.track(marchFrames);
  const legAClass = tl.track(legA);
  const legBClass = tl.track(legB);

  const invaders: string[] = [];
  const blasts: string[] = [];
  const blastKeys = tl.keyframes([[0, "opacity:1"], [0.26, "opacity:1"], [0.261, "opacity:0"]]);
  for (const kill of sim.kills) {
    const { cell } = kill;
    const kind = species(cell);
    const id = SPRITE_ID[kind];
    const x = layout.left + cell.x * layout.pitch;
    const y = spriteTop(layout, cell);
    const T = at(kill.t);
    const cls = tl.track([
      [0, "opacity:1"],
      [T, "opacity:1"],
      [T + 0.001, "opacity:0"],
      [back, "opacity:0"],
      [back + PACE.restore, "opacity:1"],
    ]);
    invaders.push(
      `<g class="${cls}" fill="${spriteColor(theme, cell)}"${halo(spriteColor(theme, cell))}><use class="${legAClass}" href="#${id}0" x="${fmt(x)}" y="${fmt(y)}"/><use class="${legBClass}" href="#${id}1" x="${fmt(x)}" y="${fmt(y)}"/></g>`,
    );
    const cx = columnX(layout, cell.x) + offsetAt(sim.march, kill.t);
    blasts.push(`<use class="bx" href="#bl" x="${fmt(cx - 6.5 * BLAST_SCALE)}" y="${fmt(y + spriteHeight(cell) / 2 - 3.5 * BLAST_SCALE)}" ${delay(kill.t)}/>`);
  }
  parts.push(`<g class="${marchClass}">${invaders.join("")}</g>`);
  parts.push(`<g fill="${ink}"${halo(ink)}>${blasts.join("")}</g>`);

  // Bunkers: untouched tiles are one path, each chip event is its own group that vanishes when hit.
  const gone = new Set<string>();
  for (const chip of sim.chips) for (const [b, c, r] of chip.tiles) gone.add(`${b}:${c}:${r}`);
  const bunkerStatic: string[] = [];
  field.bunkerX.forEach((bx, b) => {
    const rows = BUNKER.map((row, r) => [...row].map((ch, c) => (ch === "#" && !gone.has(`${b}:${c}:${r}`) ? "#" : ".")).join(""));
    bunkerStatic.push(bitmapPath(rows, BUNKER_TILE, bx, field.bunkerTop));
  });
  parts.push(`<path d="${bunkerStatic.join("")}" fill="${green}"${glow}/>`);
  for (const chip of sim.chips) {
    const d = chip.tiles
      .map(([b, c, r]) => bitmapPath(["#"], BUNKER_TILE, field.bunkerX[b] + c * BUNKER_TILE, field.bunkerTop + r * BUNKER_TILE))
      .join("");
    const T = at(chip.t);
    const cls = tl.track([
      [0, "opacity:1"],
      [T, "opacity:1"],
      [T + 0.001, "opacity:0"],
      [back, "opacity:0"],
      [back + PACE.restore, "opacity:1"],
    ]);
    parts.push(`<path class="${cls}" d="${d}" fill="${green}"/>`);
  }

  parts.push(`<rect x="4" y="${field.groundY}" width="${field.width - 8}" height="2" fill="${green}" opacity=".75"/>`);

  // Shots share a rise animation per target height; the delay var lines each one up with its fire time.
  const shotKeys = new Map<number, string>();
  const shotCss: string[] = [];
  const shotEls: string[] = [];
  for (const s of sim.shots) {
    const travel = Math.round(field.cannonY - SHOT_LEAD - s.y);
    let name = shotKeys.get(travel);
    if (!name) {
      const flight = travel / SHOT_SPEED;
      name = tl.keyframes([
        [0, "opacity:1;transform:translateY(0px)"],
        [flight, `opacity:1;transform:translateY(${-travel}px)`],
        [flight + 0.001, `opacity:0;transform:translateY(${-travel}px)`],
      ]);
      shotKeys.set(travel, name);
      shotCss.push(`.sh${shotKeys.size}{animation:${name} ${fmt(duration)}s linear infinite;animation-delay:var(--d)}`);
    }
    const idx = [...shotKeys.keys()].indexOf(travel) + 1;
    shotEls.push(`<rect class="sh${idx}" x="${fmt(s.x - 1)}" y="${field.cannonY - SHOT_LEAD}" width="2" height="${SHOT_H}" stroke="${green}" stroke-opacity=".55" stroke-width="2" ${delay(s.fire)}/>`);
  }
  parts.push(`<g fill="${ink}">${shotEls.join("")}</g>`);

  // Bombs: falling zigzag, then a splat where they stop.
  const splatKeys = tl.keyframes([[0, "opacity:1"], [0.2, "opacity:1"], [0.201, "opacity:0"]]);
  const bombEls: string[] = [];
  const splatEls: string[] = [];
  for (const b of sim.bombs) {
    const t0 = at(b.t);
    const t1 = at(b.end);
    const cls = tl.track([
      [0, `opacity:0;${translate(b.x - 1.5, b.y0)}`],
      [t0, `opacity:0;${translate(b.x - 1.5, b.y0)}`],
      [t0, `opacity:1;${translate(b.x - 1.5, b.y0)}`],
      [t1, `opacity:1;${translate(b.x - 1.5, b.y1)}`],
      [t1, `opacity:0;${translate(b.x - 1.5, b.y1)}`],
    ]);
    bombEls.push(`<g class="${cls}">${[0, 1, 2, 3].map((i) => `<use class="bf${i}" href="#bm${i}"/>`).join("")}</g>`);
    splatEls.push(`<use class="sx" href="#sp" x="${fmt(b.x - 3)}" y="${fmt(b.y1 + 2)}" ${delay(b.end)}/>`);
  }
  parts.push(`<g fill="${ink}">${bombEls.join("")}${splatEls.join("")}</g>`);

  // Mystery ship.
  const ufoEls: string[] = [];
  for (const u of sim.ufos) {
    const startX = u.dir > 0 ? -24 : field.width;
    const endX = u.dir > 0 ? field.width : -24;
    const cross = (field.width + 16) / UFO_SPEED;
    const a = at(u.start);
    const frames: Frame[] = [[0, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:0;${translate(startX, field.ufoY)}`], [a, `opacity:1;${translate(startX, field.ufoY)}`]];
    if (u.hit !== null) {
      const h = at(u.hit);
      const x = u.hitX - 8 * UFO_SCALE;
      frames.push([h, `opacity:1;${translate(x, field.ufoY)}`], [h, `opacity:0;${translate(x, field.ufoY)}`]);
    } else {
      frames.push([a + cross, `opacity:1;${translate(endX, field.ufoY)}`], [a + cross, `opacity:0;${translate(endX, field.ufoY)}`]);
    }
    ufoEls.push(`<use class="${tl.track(frames)}" href="#uf" fill="${red}"/>`);
    if (u.hit !== null) {
      const h = at(u.hit);
      const label = pixelText(String(u.score), 2);
      const lx = Math.min(Math.max(u.hitX - label.width / 2, 2), field.width - label.width - 2);
      ufoEls.push(`<use class="bx" href="#bl" x="${fmt(u.hitX - 6.5 * BLAST_SCALE)}" y="${fmt(field.ufoY + 3.5 * UFO_SCALE - 3.5 * BLAST_SCALE)}" fill="${red}" ${delay(u.hit)}/>`);
      const cls = tl.track([[0, "opacity:0"], [h + 0.2, "opacity:0"], [h + 0.2, "opacity:1"], [h + 1.2, "opacity:1"], [h + 1.2, "opacity:0"]]);
      ufoEls.push(`<path class="${cls}" d="${label.d}" transform="translate(${fmt(lx)} ${field.ufoY - 3})" fill="${red}"/>`);
    }
  }
  parts.push(ufoEls.join(""));

  // Cannon: slides between shots, blinks after the last one, then rolls home during the restore.
  const cannonFrames: Frame[] = [[0, translate(field.startX - CANNON_HALF, field.cannonY)], [intro, translate(field.startX - CANNON_HALF, field.cannonY)]];
  for (const p of sim.cannonPath.slice(1)) cannonFrames.push([at(p.t), translate(p.x - CANNON_HALF, field.cannonY)]);
  const endX = sim.cannonPath[sim.cannonPath.length - 1].x;
  cannonFrames.push([back, translate(endX - CANNON_HALF, field.cannonY)], [duration - 0.1, translate(field.startX - CANNON_HALF, field.cannonY)]);
  const blink: Frame[] = [[0, "opacity:1"]];
  if (!empty) {
    let t = at(play) + 0.15;
    for (let i = 0; i < 2; i++) {
      blink.push(...tri(t, "opacity:1", "opacity:0"), ...tri(t + 0.15, "opacity:0", "opacity:1"));
      t += 0.3;
    }
  }
  parts.push(`<g class="${tl.track(cannonFrames)}"><g${glow}><use class="${tl.track(blink)}" href="#cn" fill="${green}"/></g></g>`);

  if (!empty) {
    const gridCx = layout.left + layout.gridWidth / 2;
    const gridCy = layout.top + layout.gridHeight / 2;
    parts.push(banner(tl, { theme, lines: stageClearLines(grid), cx: gridCx, cy: gridCy, from: at(play) + 0.1, to: back - 0.05 }));
  }
  const clears: ClearEvent[] = sim.kills.map((k) => ({ t: at(k.t), cell: k.cell }));
  parts.push(hud(tl, grid, { theme, title: "SPACE INVADERS", clears, resetAt: back, width: field.width }));

  const cycle = 0.32;
  const dur = (n: number) => fmt(n);
  const css = [
    `.bx{animation:${blastKeys} ${dur(duration)}s linear infinite;animation-delay:var(--d)}`,
    `.sx{animation:${splatKeys} ${dur(duration)}s linear infinite;animation-delay:var(--d)}`,
    ...shotCss,
    "@keyframes bfk{0%{opacity:1}25%{opacity:0}100%{opacity:0}}",
    ...[0, 1, 2, 3].map((i) => `.bf${i}{animation:bfk ${cycle}s steps(1,end) infinite;animation-delay:-${fmt(cycle - i * 0.08)}s}`),
    "path{shape-rendering:crispEdges}",
    tl.css(),
  ].join("\n");
  return { width: field.width, height: field.height, css, defs: defs.join("") + glowDefs(theme), body: parts.join("\n") };
}

export const invaders: Game = { id: "invaders", title: "Space Invaders", render };
