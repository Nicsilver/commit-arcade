import { Timeline, fmt, translate } from "../anim.ts";
import type { Frame } from "../anim.ts";
import { Bursts, radialSparks } from "../fx.ts";
import { PACE, loopDuration, restoreAt } from "../game.ts";
import type { Game, GameContext, GameOutput } from "../game.ts";
import { activeCells } from "../grid.ts";
import type { Cell, Grid, Level } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines } from "../kit.ts";
import type { ClearEvent } from "../kit.ts";
import { bitmapPath, pixelText } from "../pixel-font.ts";
import type { Rng } from "../rng.ts";
import { cellRect } from "../svg.ts";
import type { Layout } from "../svg.ts";
import type { Theme } from "../theme.ts";

const TICK = 1 / 200;
const BULLET_SPEED = 1500;
const FIRE_GAP = 0.065;
const PLAYER_SPEED = 640;
const DECIDE_GAP = 0.05;
const STEP = 0.07;
const LANE_ROW = -1;
const BAND_TOP = 7;
const BAND_BOTTOM = 8;
const PLAYER_ROW = 9;
const MAX_HITS = [0, 1, 2, 3, 3];
const GONE = 3;
const BITE = [0, 3, 7];
const WAVES = [12, 8];
const GIVE_UP = 600;

type Way = [t: number, x: number, y: number];

export interface Mushroom {
  id: number;
  col: number;
  row: number;
  level: number;
  maxHits: number;
  hits: number;
  born: number;
  day: Cell | null;
  /** Sprite state changes: 0 whole, 1 and 2 bitten from the bottom, 3 gone. */
  states: { t: number; state: number }[];
  died: number | null;
}

interface Rec {
  col: number;
  row: number;
  h: 1 | -1;
  dy: 1 | -1;
}

export interface Segment {
  id: number;
  rec: Rec;
  prev: { col: number; row: number };
  spawn: number;
  died: number | null;
  way: Way[];
  /** When this segment is a head, and which way it faces. */
  heads: { t: number; on: boolean; face: 1 | -1 }[];
}

interface Centipede {
  segs: Segment[];
  stepT: number;
  stepStart: number;
  nextStep: number;
}

interface Bullet {
  t0: number;
  x: number;
  y: number;
  t1: number | null;
  y1: number;
}

export interface Effect {
  t: number;
  x: number;
  y: number;
  kind: "chip" | "crumble" | "segment" | "big";
  level: number;
}

export interface Popup {
  t: number;
  x: number;
  y: number;
  text: string;
}

export interface Pest {
  kind: "flea" | "spider";
  way: Way[];
  from: number;
  to: number;
  shot: boolean;
}

export interface CentipedeSim {
  mushrooms: Mushroom[];
  segments: Segment[];
  bullets: { t0: number; t1: number; x: number; y0: number; y1: number }[];
  player: { t: number; x: number }[];
  effects: Effect[];
  popups: Popup[];
  pests: Pest[];
  clears: { t: number; cell: Cell }[];
  /** When the last mushroom or segment is gone. */
  end: number;
}

function simplify(points: Way[]): Way[] {
  const out: Way[] = [];
  for (const p of points) {
    const n = out.length;
    if (n >= 1 && out[n - 1][0] === p[0] && out[n - 1][1] === p[1] && out[n - 1][2] === p[2]) continue;
    if (n >= 2) {
      const [a, b] = [out[n - 2], out[n - 1]];
      const dt1 = b[0] - a[0];
      const dt2 = p[0] - b[0];
      if (
        dt1 > 1e-9 &&
        dt2 > 1e-9 &&
        Math.abs((b[1] - a[1]) / dt1 - (p[1] - b[1]) / dt2) < 1e-3 &&
        Math.abs((b[2] - a[2]) / dt1 - (p[2] - b[2]) / dt2) < 1e-3
      ) {
        out[n - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

function stateAfter(maxHits: number, hits: number): number {
  if (hits >= maxHits) return GONE;
  return maxHits === 2 ? 2 : hits;
}

/**
 * Plays the whole board: a bug blaster that sweeps the mushroom field column
 * by column and hunts whatever comes down, centipedes that snake through the
 * graph and split when shot, and the odd flea and spider.
 */
export function simulateCentipede(grid: Grid, layout: Layout, rng: Rng): CentipedeSim {
  const cols = grid.width;
  const xOf = (col: number) => layout.left + col * layout.pitch + layout.cell / 2;
  const yOf = (row: number) => layout.top + row * layout.pitch + layout.cell / 2;
  const half = layout.cell / 2;
  const fieldLeft = xOf(0);
  const fieldRight = xOf(cols - 1);
  const tipStart = yOf(PLAYER_ROW) - 9;
  const bulletTop = yOf(LANE_ROW) - 8;
  const colOf = (x: number) => Math.round((x - fieldLeft) / layout.pitch);

  const mushrooms: Mushroom[] = [];
  const at = new Map<number, Mushroom>();
  const keyOf = (col: number, row: number) => (col + 8) * 32 + row + 2;
  const mushAt = (col: number, row: number) => at.get(keyOf(col, row));
  const addMushroom = (col: number, row: number, level: number, day: Cell | null, t: number) => {
    const m: Mushroom = {
      id: mushrooms.length,
      col,
      row,
      level,
      maxHits: MAX_HITS[level],
      hits: 0,
      born: t,
      day,
      states: [],
      died: null,
    };
    mushrooms.push(m);
    at.set(keyOf(col, row), m);
    return m;
  };
  for (const cell of activeCells(grid)) addMushroom(cell.x, cell.y, cell.level, cell, 0);
  const initialHits = Math.max(1, mushrooms.reduce((n, m) => n + m.maxHits, 0));
  let remainingDayHits = initialHits;

  const segments: Segment[] = [];
  let centipedes: Centipede[] = [];
  const clears: CentipedeSim["clears"] = [];
  const effects: Effect[] = [];
  const popups: Popup[] = [];
  const pests: Pest[] = [];
  const bullets: Bullet[] = [];
  const finished: CentipedeSim["bullets"] = [];
  const player: CentipedeSim["player"] = [];

  const spawnCentipede = (length: number, fromLeft: boolean, t: number) => {
    const h = fromLeft ? 1 : -1;
    const startCol = fromLeft ? -3 : cols + 2;
    const segs: Segment[] = [];
    for (let i = 0; i < length; i++) {
      const col = startCol - h * i;
      const seg: Segment = {
        id: segments.length,
        rec: { col, row: LANE_ROW, h, dy: 1 },
        prev: { col, row: LANE_ROW },
        spawn: t,
        died: null,
        way: [[t, xOf(col), yOf(LANE_ROW)]],
        heads: i === 0 ? [{ t, on: true, face: h }] : [],
      };
      segments.push(seg);
      segs.push(seg);
    }
    centipedes.push({ segs, stepT: STEP, stepStart: t, nextStep: t + STEP });
  };

  const visual = (c: Centipede, s: Segment, t: number): [number, number] => {
    const f = Math.min(1, Math.max(0, (t - c.stepStart) / c.stepT));
    const x0 = xOf(s.prev.col);
    const y0 = yOf(s.prev.row);
    return [x0 + (xOf(s.rec.col) - x0) * f, y0 + (yOf(s.rec.row) - y0) * f];
  };

  const insideX = (col: number) => col >= 0 && col < cols;
  const occupiedBySegment = (col: number, row: number) =>
    centipedes.some((c) => c.segs.some((s) => s.died === null && s.rec.col === col && s.rec.row === row));

  const stepCentipede = (c: Centipede, t: number) => {
    const head = c.segs[0];
    const r = head.rec;
    const nc = r.col + r.h;
    let next: Rec | null = null;
    if (!insideX(r.col)) {
      if (!insideX(nc) || !mushAt(nc, r.row)) next = { ...r, col: nc };
    } else if (insideX(nc) && !mushAt(nc, r.row)) {
      next = { ...r, col: nc };
    } else {
      let dy = r.dy;
      if (dy > 0 && r.row >= BAND_BOTTOM) dy = -1;
      else if (dy < 0 && r.row <= BAND_TOP) dy = 1;
      const flipped = (r.h * -1) as 1 | -1;
      if (!mushAt(r.col, r.row + dy)) next = { col: r.col, row: r.row + dy, h: flipped, dy };
      else if (insideX(r.col + flipped) && !mushAt(r.col + flipped, r.row)) next = { col: r.col + flipped, row: r.row, h: flipped, dy };
      // Boxed in on every side: drop through the mushroom below instead of waiting for the blaster to free it.
      else next = { col: r.col, row: r.row + dy, h: flipped, dy };
    }
    c.nextStep = t + c.stepT;
    if (!next) return;
    const old = c.segs.map((s) => ({ ...s.rec }));
    c.segs.forEach((s, i) => {
      s.prev = { col: s.rec.col, row: s.rec.row };
      s.rec = i === 0 ? next : { ...old[i - 1] };
      s.way.push([t, xOf(s.prev.col), yOf(s.prev.row)], [t + c.stepT, xOf(s.rec.col), yOf(s.rec.row)]);
    });
    if (next.h !== r.h) head.heads.push({ t: t + c.stepT * 0.5, on: true, face: next.h });
    c.stepStart = t;
  };

  let flea: { x: number; y: number; pest: Pest; lastRow: number } | null = null;
  let spider: { ts: number; dir: 1 | -1; x0: number; pest: Pest; x: number; y: number } | null = null;
  const spiderY = (ts: number, t: number) => yOf(BAND_BOTTOM) + Math.sin(((t - ts) / 0.7) * Math.PI * 2) * 14;
  const SPIDER_SPEED = 240;
  const FLEA_SPEED = 250;

  const progress = () => 1 - remainingDayHits / initialHits;
  const pending: { kind: "flea" | "wave" | "spider"; at: number }[] = [
    { kind: "flea", at: 0.15 },
    { kind: "wave", at: 0.45 },
    { kind: "spider", at: 0.5 },
    { kind: "flea", at: 0.78 },
  ];
  let spiderDir: 1 | -1 = 1;
  let waveIndex = 0;
  let waveFromLeft = true;
  const spawnWave = (t: number) => {
    spawnCentipede(WAVES[Math.min(waveIndex, WAVES.length - 1)], waveFromLeft, t);
    waveIndex++;
    waveFromLeft = !waveFromLeft;
  };
  spawnWave(0);

  const killSegment = (c: Centipede, i: number, t: number) => {
    const s = c.segs[i];
    const [sx, sy] = visual(c, s, t);
    s.died = t;
    while (s.way.length && s.way[s.way.length - 1][0] > t) s.way.pop();
    s.way.push([t, sx, sy]);
    const rear = c.segs.slice(i + 1);
    c.segs = c.segs.slice(0, i);
    if (rear.length) {
      const r = rear[0].rec;
      rear[0].heads.push({ t, on: true, face: r.h });
      centipedes.push({ segs: rear, stepT: c.stepT, stepStart: c.stepStart, nextStep: c.nextStep });
    }
    if (insideX(s.rec.col) && !mushAt(s.rec.col, s.rec.row)) {
      const m = addMushroom(s.rec.col, s.rec.row, 2 + Math.floor(rng() * 2), null, t);
      m.states.push({ t, state: 0 });
    }
    const last = rear.length === 0 && c.segs.length === 0 && centipedes.length === 1;
    effects.push({ t, x: sx, y: sy, kind: last ? "big" : "segment", level: 0 });
  };

  const hitMushroom = (m: Mushroom, t: number, y: number) => {
    m.hits++;
    const state = stateAfter(m.maxHits, m.hits);
    m.states.push({ t, state });
    const x = xOf(m.col);
    if (m.day) remainingDayHits--;
    if (m.hits >= m.maxHits) {
      m.died = t;
      at.delete(keyOf(m.col, m.row));
      if (m.day) clears.push({ t, cell: m.day });
      effects.push({ t, x, y: yOf(m.row), kind: "crumble", level: m.level });
    } else {
      effects.push({ t, x, y, kind: "chip", level: m.level });
    }
  };

  const columnLoad = (col: number): number => {
    let load = 0;
    for (let r = LANE_ROW; r <= PLAYER_ROW; r++) {
      const m = mushAt(col, r);
      if (m) load += m.maxHits - m.hits;
    }
    for (const c of centipedes) for (const s of c.segs) if (s.rec.col === col) load++;
    if (flea && colOf(flea.x) === col) load++;
    for (const b of bullets) if (b.t1 === null && colOf(b.x) === col) load--;
    return load;
  };

  let t = 0;
  let px = (fieldLeft + fieldRight) / 2;
  let sweep = 1;
  let target: { x: number; threat: boolean } | null = null;
  let nextDecide = 0;
  let nextFire = 0.3;
  let end = 0;

  for (;;) {
    t += TICK;
    if (t > GIVE_UP) throw new Error("centipede did not finish");
    const rush = 1 + Math.max(0, t - 150) / 12;

    const alive = centipedes.filter((c) => c.segs.length > 0);
    centipedes = alive;
    const mushAlive = mushrooms.some((m) => m.died === null);
    const idle = alive.length === 0 && !mushAlive;
    const pestBusy = flea !== null || spider !== null;
    if (pending.length && (progress() >= pending[0].at || idle || alive.length === 0 && pending[0].kind === "wave")) {
      const next = pending[0];
      if (next.kind === "wave") {
        pending.shift();
        spawnWave(t);
      } else if (!pestBusy) {
        pending.shift();
        if (next.kind === "flea") {
          const col = Math.floor(rng() * cols);
          const pest: Pest = { kind: "flea", way: [], from: t, to: t, shot: false };
          pests.push(pest);
          flea = { x: xOf(col), y: yOf(LANE_ROW) - 12, pest, lastRow: LANE_ROW - 1 };
          pest.way.push([t, flea.x, flea.y]);
        } else {
          spiderDir = (spiderDir * -1) as 1 | -1;
          const dir = spiderDir;
          const x0 = dir > 0 ? fieldLeft - 24 : fieldRight + 24;
          const pest: Pest = { kind: "spider", way: [], from: t, to: t, shot: false };
          pests.push(pest);
          spider = { ts: t, dir, x0, pest, x: x0, y: spiderY(t, t) };
          pest.way.push([t, x0, spider.y]);
        }
      }
    }

    for (const c of centipedes) {
      if (t >= c.nextStep) {
        const few = c.segs.length <= 3 || progress() > 0.85;
        c.stepT = few ? STEP * 0.78 : STEP;
        stepCentipede(c, t);
      }
    }

    if (flea) {
      flea.y += FLEA_SPEED * TICK;
      const row = Math.floor((flea.y - layout.top) / layout.pitch);
      if (row > flea.lastRow) {
        flea.lastRow = row;
        const col = colOf(flea.x);
        if (row >= 0 && row < 7 && rng() < 0.32 && !mushAt(col, row) && !occupiedBySegment(col, row)) {
          const m = addMushroom(col, row, 2 + Math.floor(rng() * 2), null, t);
          m.states.push({ t, state: 0 });
          effects.push({ t, x: xOf(col), y: yOf(row), kind: "chip", level: m.level });
        }
      }
      if (flea.y > yOf(PLAYER_ROW) + 16) {
        flea.pest.way.push([t, flea.x, flea.y]);
        flea.pest.to = t;
        flea = null;
      }
    }
    if (spider) {
      spider.x = spider.x0 + spider.dir * SPIDER_SPEED * (t - spider.ts);
      spider.y = spiderY(spider.ts, t);
      const gone = spider.dir > 0 ? spider.x > fieldRight + 26 : spider.x < fieldLeft - 26;
      if (Math.round((t - spider.ts) * 200) % 6 === 0) spider.pest.way.push([t, spider.x, spider.y]);
      if (gone) {
        spider.pest.way.push([t, spider.x, spider.y]);
        spider.pest.to = t;
        spider = null;
      }
    }

    for (const b of bullets) {
      if (b.t1 !== null) continue;
      const before = b.y;
      b.y -= BULLET_SPEED * TICK;
      let contact = -Infinity;
      let hit: (() => void) | null = null;
      const col = colOf(b.x);
      if (insideX(col) && Math.abs(b.x - xOf(col)) <= 7) {
        for (let r = PLAYER_ROW - 1; r >= LANE_ROW; r--) {
          const m = mushAt(col, r);
          if (!m) continue;
          const bottom = yOf(r) + half - BITE[Math.min(m.maxHits === 2 && m.hits === 1 ? 2 : m.hits, 2)];
          if (b.y <= bottom && before >= yOf(r) - half) {
            contact = bottom;
            hit = () => hitMushroom(m, t, bottom);
            break;
          }
        }
      }
      for (const c of centipedes) {
        c.segs.forEach((s, i) => {
          const [sx, sy] = visual(c, s, t);
          if (Math.abs(b.x - sx) <= 7.5 && b.y <= sy + 6.5 && before >= sy - 7 && sy + 6.5 > contact) {
            contact = sy + 6.5;
            hit = () => killSegment(c, i, t);
          }
        });
      }
      if (flea && Math.abs(b.x - flea.x) <= 8 && b.y <= flea.y + 6 && before >= flea.y - 6 && flea.y + 6 > contact) {
        const f = flea;
        contact = f.y + 6;
        hit = () => {
          f.pest.way.push([t, f.x, f.y]);
          f.pest.to = t;
          f.pest.shot = true;
          effects.push({ t, x: f.x, y: f.y, kind: "big", level: 0 });
          popups.push({ t, x: f.x, y: f.y, text: "200" });
          flea = null;
        };
      }
      if (spider && Math.abs(b.x - spider.x) <= 9 && b.y <= spider.y + 6 && before >= spider.y - 6 && spider.y + 6 > contact) {
        const sp = spider;
        contact = sp.y + 6;
        hit = () => {
          sp.pest.way.push([t, sp.x, sp.y]);
          sp.pest.to = t;
          sp.pest.shot = true;
          const dist = Math.abs(px - sp.x);
          effects.push({ t, x: sp.x, y: sp.y, kind: "big", level: 0 });
          popups.push({ t, x: sp.x, y: sp.y, text: dist < 60 ? "900" : dist < 140 ? "600" : "300" });
          spider = null;
        };
      }
      if (hit) {
        (hit as () => void)();
        b.t1 = t;
        b.y1 = contact;
      } else if (b.y < bulletTop) {
        b.t1 = t;
        b.y1 = bulletTop;
      }
      if (b.t1 !== null) finished.push({ t0: b.t0, t1: b.t1, x: b.x, y0: tipStart, y1: b.y1 });
    }
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].t1 !== null) bullets.splice(i, 1);

    if (t >= nextDecide) {
      nextDecide = t + DECIDE_GAP;
      let best = -Infinity;
      let aim: number | null = null;
      const consider = (x: number, y: number, bonus = 0) => {
        const score = y + bonus - 0.05 * Math.abs(x - px);
        if (score > best) {
          best = score;
          aim = x;
        }
      };
      const flight = (y: number) => (tipStart - y) / BULLET_SPEED + 0.04;
      for (const c of centipedes) {
        for (const s of c.segs) {
          const [sx, sy] = visual(c, s, t);
          if (sy < yOf(6) || sx < fieldLeft - 8 || sx > fieldRight + 8) continue;
          const moving = s.rec.row === s.prev.row && s.rec.col !== s.prev.col;
          const vx = moving ? (s.rec.h * layout.pitch) / c.stepT : 0;
          consider(Math.min(fieldRight, Math.max(fieldLeft, sx + vx * flight(sy))), sy);
        }
      }
      if (spider) {
        const lead = flight(spider.y);
        consider(Math.min(fieldRight, Math.max(fieldLeft, spider.x + spider.dir * SPIDER_SPEED * lead)), spider.y, 4);
      }
      if (flea && flea.y < yOf(6)) consider(flea.x, flea.y, 40);
      if (aim !== null) {
        target = { x: aim, threat: true };
      } else if (!target || target.threat || columnLoad(colOf(target.x)) <= 0) {
        target = null;
        const here = colOf(px);
        if (insideX(here) && Math.abs(px - xOf(here)) < 1 && columnLoad(here) > 0) {
          target = { x: xOf(here), threat: false };
        } else {
          for (const dir of [sweep, -sweep]) {
            for (let d = 0; d < cols && !target; d++) {
              const col = here + dir * d;
              if (insideX(col) && columnLoad(col) > 0) target = { x: xOf(col), threat: false };
            }
            if (target) {
              sweep = dir;
              break;
            }
          }
        }
      }
      player.push({ t, x: px });
    }

    const speed = PLAYER_SPEED * (1 + 0.6 * progress() ** 2) * rush;
    if (target) {
      const dx = target.x - px;
      px += Math.sign(dx) * Math.min(Math.abs(dx), speed * TICK);
    }
    if (t >= nextFire && target) {
      const aligned = target.threat ? Math.abs(px - target.x) < 10 : Math.abs(px - target.x) < 1;
      const col = colOf(px);
      const loaded = target.threat || (insideX(col) && columnLoad(col) > 0);
      if (aligned && loaded) {
        bullets.push({ t0: t, x: px, y: tipStart, t1: null, y1: 0 });
        nextFire = t + (FIRE_GAP * (1 - 0.3 * progress())) / rush;
      }
    }

    if (!mushrooms.some((m) => m.died === null) && centipedes.length === 0 && pending.length === 0 && !flea && !spider) {
      end = t;
      break;
    }
  }
  player.push({ t: end, x: px });

  return { mushrooms, segments, bullets: finished, player, effects, popups, pests, clears, end };
}
const MUSHROOM_ROWS = {
  full: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "CCCCCCSC", "CCCCCCCC", "..TTTT..", "..TTTT..", ".TTTTTT."],
  nibbled: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "CCCCCCSC", "CCCCCCCC", "..TTTT..", "..T.TT..", "........"],
  bitten: ["..CCCC..", ".CCSCCC.", "CSSCCSCC", "C.CC.CSC", "........", "........", "........", "........"],
};
const MUSHROOM_SCALE = 1.5;
const STRIP_PITCH = 20;

const GNOME_ROWS = [
  "....H....",
  "...HHH...",
  "..HHHHH..",
  "..HHHHH..",
  ".HHHHHHH.",
  "..FEFEF..",
  "..FFFFF..",
  ".BBBBBBB.",
  "..BBBBB..",
  "...BBB...",
];
const GNOME_SCALE = 1.9;

const FLEA_FRAMES = [
  ["..L..L..", "..FFFF..", ".FFEFEF.", "FFFFFFFF", ".FFFFFF.", "..F..F..", ".L....L."],
  ["L.L..L.L", "..FFFF..", ".FFEFEF.", "FFFFFFFF", ".FFFFFF.", "..F..F..", "..L..L.."],
];
const SPIDER_FRAMES = [
  [".L......L.", "L.SSSSSS.L", "..SESSES..", ".LSSSSSSL.", "L..L..L..L"],
  ["L......L..", ".LSSSSSS.L", "..SESSES..", "L.SSSSSS.L", "..L.L..L.."],
];

interface Palette {
  body: string;
  head: string;
  hat: string;
  skin: string;
  bullet: string;
  flea: string;
  spider: string;
  popup: string;
  rim: string;
  rimOpacity: number;
}

function isDark(theme: Theme): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

function mix(a: string, b: string, k: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

function paletteFor(theme: Theme): Palette {
  if (theme.name === "neon") {
    return { body: "#b9ff3c", head: "#fff24d", hat: "#23f0ff", skin: "#ffe0c2", bullet: "#ffffff", flea: "#ff9d2e", spider: "#4dffb2", popup: "#23f0ff", rim: theme.surface, rimOpacity: 1 };
  }
  if (isDark(theme)) {
    return { body: "#ff5aa5", head: "#ffd24a", hat: "#4dd8ff", skin: "#ffe0c2", bullet: "#ffffff", flea: "#ff9a4a", spider: "#c792ff", popup: "#4dd8ff", rim: theme.surface, rimOpacity: 1 };
  }
  return { body: "#d6246e", head: "#f08a00", hat: theme.accent, skin: "#ffd9b0", bullet: theme.accent, flea: "#c4570a", spider: "#6639ba", popup: theme.accent, rim: theme.ink, rimOpacity: 0.75 };
}

function dilate(rows: string[]): string[] {
  const h = rows.length;
  const w = rows[0].length;
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== ".";
  const out: string[] = [];
  for (let y = -1; y <= h; y++) {
    let line = "";
    for (let x = -1; x <= w; x++) {
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) on = filled(x + dx, y + dy);
      line += on ? "#" : ".";
    }
    out.push(line);
  }
  return out;
}

/** An outlined sprite: `colors` maps each letter in `rows` to its fill. */
function sprite(rows: string[], colors: Record<string, string>, scale: number, p: Palette, ox = 0, oy = 0): string {
  const outline = `<path d="${bitmapPath(dilate(rows), scale, ox - scale, oy - scale)}" fill="${p.rim}" fill-opacity="${p.rimOpacity}"/>`;
  const layers = Object.entries(colors).map(([letter, fill]) => {
    const mask = rows.map((r) => r.replace(new RegExp(`[^${letter}]`, "g"), ".").replace(new RegExp(letter, "g"), "#"));
    return `<path d="${bitmapPath(mask, scale, ox, oy)}" fill="${fill}"/>`;
  });
  return outline + layers.join("");
}

function mushroomStrip(theme: Theme, level: number, p: Palette, dark: boolean): string {
  const cap = spriteColor(theme, { level: level as Level });
  const colors = { C: cap, S: mix(cap, "#ffffff", 0.7), T: mix(cap, "#ffffff", dark ? 0.55 : 0.3) };
  return [MUSHROOM_ROWS.full, MUSHROOM_ROWS.nibbled, MUSHROOM_ROWS.bitten]
    .map((rows, i) => `<g transform="translate(${i * STRIP_PITCH} 0)">${sprite(rows, colors, MUSHROOM_SCALE, p)}</g>`)
    .join("");
}

function flicker(frames: string[], period: number): string {
  return frames
    .map(
      (f, i) =>
        `<g opacity="${i === 0 ? 1 : 0}">${f}<animate attributeName="opacity" values="${i === 0 ? "1;0" : "0;1"}" calcMode="discrete" dur="${period}s" repeatCount="indefinite"/></g>`,
    )
    .join("");
}

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const layout = arcadeLayout(grid);
  const { width, height } = layout;
  const dark = isDark(theme);
  const pal = paletteFor(theme);
  const hasPlay = activeCells(grid).length > 0;
  const sim = hasPlay ? simulateCentipede(grid, layout, ctx.rng) : null;

  const activeCount = activeCells(grid).length;
  const wanted = Math.min(62, 20 + activeCount * 0.11);
  const scale = sim ? Math.min(1.7, Math.max(0.6, wanted / sim.end)) : 1;
  const play = sim ? Math.round(sim.end * scale * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const tl = new Timeline(duration);
  const T = (t: number) => PACE.intro + t * scale;
  const tEnd = PACE.intro + play;

  const xOf = (col: number) => layout.left + col * layout.pitch + layout.cell / 2;
  const yOf = (row: number) => layout.top + row * layout.pitch + layout.cell / 2;
  const cellX = (col: number) => layout.left + col * layout.pitch;
  const cellY = (row: number) => layout.top + row * layout.pitch;
  const midX = (xOf(0) + xOf(grid.width - 1)) / 2;
  const gnomeW = 9 * GNOME_SCALE;
  const gnomeY = yOf(PLAYER_ROW) - 9;

  const bursts = new Bursts(duration);
  const flashColor = dark ? "#ffffff" : pal.bullet;
  bursts.define("chip", { life: 0.34, sparks: radialSparks(6, 13, 3.2, 0.4), flash: dark ? 4.6 : 2.6, flashColor });
  bursts.define("crumble", { life: 0.45, sparks: radialSparks(10, 19, 3.6, 0.2), ring: 11, flash: dark ? 6.5 : 3.5, flashColor });
  bursts.define("segment", { life: 0.55, sparks: radialSparks(12, 22, 3.8, 0.1), ring: 18, ringWidth: 2, flash: dark ? 8 : 4, flashColor });
  bursts.define("big", { life: 0.75, sparks: radialSparks(16, 30, 4, 0.3), ring: 28, ringWidth: 2.6, flash: dark ? 11 : 5, flashColor });

  const cells: string[] = [];
  for (const column of grid.cells) for (const cell of column) if (cell) cells.push(cellRect(layout, cell, theme.empty));

  const strips = [1, 2, 3, 4].map((level) => `<g id="st${level}">${mushroomStrip(theme, level, pal, dark)}</g>`).join("");
  const clip = `<clipPath id="mclip"><rect x="-3" y="-3" width="17" height="17"/></clipPath>`;
  const legs = (a: string) => `<path d="${a}" stroke="${pal.body}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
  const segmentDef =
    `<g id="cseg">${flicker([legs("M-3 5.2v3M3 5.2v3M-3 -5.2v-3M3 -5.2v-3"), legs("M-1.2 5.4v3M4.8 5.2v3M-1.2 -5.4v-3M4.8 -5.2v-3")], 0.24)}` +
    `<circle r="6.5" fill="${pal.body}" stroke="${pal.rim}" stroke-opacity="${pal.rimOpacity}" stroke-width="1.4"/>` +
    `<circle cx="-1.9" cy="-2" r="2" fill="#fff" fill-opacity=".38"/></g>`;
  const headDef =
    `<g id="chead"><path d="M4 -6.6l3.4 -3.4M4 6.6l3.4 3.4" stroke="${pal.head}" stroke-width="1.5" stroke-linecap="round"/>` +
    `<circle r="7.7" fill="${pal.head}" stroke="${pal.rim}" stroke-opacity="${pal.rimOpacity}" stroke-width="1.4"/>` +
    `<circle cx="2.6" cy="-3" r="2.4" fill="#fff"/><circle cx="2.6" cy="3" r="2.4" fill="#fff"/>` +
    `<circle cx="3.5" cy="-3" r="1.15" fill="#14141f"/><circle cx="3.5" cy="3" r="1.15" fill="#14141f"/>` +
    `<path d="M6.8 -1.4l2.6 -1.4M6.8 1.4l2.6 1.4" stroke="${pal.rim}" stroke-width="1.2" stroke-linecap="round"/></g>`;
  const gnomeDef = `<g id="gnome">${sprite(GNOME_ROWS, { H: pal.hat, F: pal.skin, E: "#1b1b2f", B: "#ffffff" }, GNOME_SCALE, pal)}</g>`;
  const fleaDef = `<g id="flea">${flicker(FLEA_FRAMES.map((f) => sprite(f, { F: pal.flea, E: "#ffffff", L: mix(pal.flea, "#ffffff", 0.35) }, 1.5, pal, -6, -5.25)), 0.2)}</g>`;
  const spiderDef = `<g id="spider">${flicker(SPIDER_FRAMES.map((f) => sprite(f, { S: pal.spider, E: "#ffffff", L: mix(pal.spider, "#ffffff", 0.3) }, 1.5, pal, -7.5, -3.75)), 0.18)}</g>`;
  const bulletDef =
    `<g id="bl"><rect x="-2.4" y="-1" width="4.8" height="11" rx="2.4" fill="${pal.bullet}" fill-opacity="${dark ? 0.28 : 0.22}"/>` +
    `<rect x="-1" y="0" width="2" height="9" rx="1" fill="${pal.bullet}"/></g>`;

  const body: string[] = [];
  const clears: ClearEvent[] = [];
  const css: string[] = [];

  const mushroomMarkup: string[] = [];
  const bulletMarkup: string[] = [];
  const segmentMarkup: string[] = [];
  const pestMarkup: string[] = [];
  const burstMarkup: string[] = [];
  const popupMarkup: string[] = [];
  let playerMarkup = "";

  const shift = (t: number) => {
    const s = ((t % duration) + duration) % duration;
    return s === 0 ? "0s" : `-${fmt(Math.round((duration - s) * 1000) / 1000)}s`;
  };

  if (sim) {
    const stripCss = (state: number, opacity: number) => `opacity:${opacity};transform:translate(${-state * STRIP_PITCH}px,0)`;
    for (const m of sim.mushrooms) {
      const frames: Frame[] = [];
      const first = m.day ? 0 : GONE;
      frames.push([0, stripCss(first, 1)]);
      let state = first;
      if (!m.day) frames.push([T(m.born), stripCss(GONE, 1)]);
      for (const ev of m.states) {
        const at = T(ev.t);
        frames.push([at, stripCss(state, 1)], [at, stripCss(ev.state, 1)]);
        state = ev.state;
      }
      if (m.day) {
        frames.push([restore, stripCss(GONE, 0)], [restore, stripCss(0, 0)], [restore + PACE.restore, stripCss(0, 1)]);
      }
      const cls = tl.track(frames);
      mushroomMarkup.push(
        `<g transform="translate(${fmt(cellX(m.col))} ${fmt(cellY(m.row))})" clip-path="url(#mclip)"><use class="${cls}" href="#st${m.level}"/></g>`,
      );
      if (m.day) clears.push({ t: T(m.states[m.states.length - 1].t), cell: m.day });
    }

    const flights = new Map<string, string>();
    const flightClass = (d: number, flight: number) => {
      const key = `${Math.round(d * 2)}:${Math.round(flight * 500)}`;
      let cls = flights.get(key);
      if (!cls) {
        const rest = `opacity:0;transform:translateY(${fmt(-d)}px)`;
        const name = tl.keyframes([
          [0, "opacity:1;transform:translateY(0)"],
          [flight, `opacity:1;transform:translateY(${fmt(-d)}px)`],
          [flight + 0.001, rest],
        ]);
        cls = `bf${flights.size}`;
        css.push(`.${cls}{animation:${name} ${fmt(duration)}s linear infinite}`);
        flights.set(key, cls);
      }
      return cls;
    };
    for (const b of sim.bullets) {
      const cls = flightClass(b.y0 - b.y1, (b.t1 - b.t0) * scale);
      bulletMarkup.push(`<use class="${cls}" href="#bl" x="${fmt(b.x)}" y="${fmt(b.y0)}" style="animation-delay:${shift(T(b.t0))}"/>`);
    }

    for (const s of sim.segments) {
      if (s.died === null) throw new Error("segment survived");
      const pts = simplify(s.way.map(([t, x, y]): Way => [T(t), x, y]));
      const start = pts[0];
      const stop = pts[pts.length - 1];
      const frames: Frame[] = [[0, `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:1;${translate(start[1], start[2])}`]];
      for (const [t, x, y] of pts) frames.push([t, `opacity:1;${translate(x, y)}`]);
      frames.push([stop[0], `opacity:0;${translate(stop[1], stop[2])}`]);
      const pos = tl.track(frames);
      let headLayer = "";
      if (s.heads.length) {
        const hf: Frame[] = [[0, "opacity:0"]];
        let on = false;
        let face = 1;
        for (const ev of s.heads) {
          const t = T(ev.t);
          hf.push([t, `opacity:${on ? 1 : 0};transform:scaleX(${face})`], [t, `opacity:1;transform:scaleX(${ev.face})`]);
          on = true;
          face = ev.face;
        }
        hf.push([stop[0], `opacity:1;transform:scaleX(${face})`], [stop[0], "opacity:0"]);
        headLayer = `<g class="${tl.track(hf)}"><use href="#chead"/></g>`;
      }
      segmentMarkup.push(`<g class="${pos}"><use href="#cseg"/>${headLayer}</g>`);
    }

    for (const p of sim.pests) {
      const pts = simplify(p.way.map(([t, x, y]): Way => [T(t), x, y]));
      const start = pts[0];
      const stop = pts[pts.length - 1];
      const frames: Frame[] = [[0, `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:0;${translate(start[1], start[2])}`], [start[0], `opacity:1;${translate(start[1], start[2])}`]];
      for (const [t, x, y] of pts) frames.push([t, `opacity:1;${translate(x, y)}`]);
      frames.push([stop[0], `opacity:0;${translate(stop[1], stop[2])}`]);
      pestMarkup.push(`<g class="${tl.track(frames)}"><use href="#${p.kind}"/></g>`);
    }

    for (const e of sim.effects) {
      const color = e.kind === "chip" || e.kind === "crumble" ? spriteColor(theme, { level: e.level as Level }) : e.kind === "big" ? pal.head : pal.body;
      burstMarkup.push(bursts.use(e.kind, e.x, e.y, T(e.t), color));
    }

    for (const p of sim.popups) {
      const text = pixelText(p.text, 1.6);
      const te = T(p.t);
      const cls = tl.track([
        [0, `opacity:0;${translate(p.x, p.y - 8)}`],
        [te, `opacity:0;${translate(p.x, p.y - 8)}`],
        [te, `opacity:1;${translate(p.x, p.y - 8)}`],
        [te + 0.8, `opacity:1;${translate(p.x, p.y - 20)}`],
        [te + 0.82, `opacity:0;${translate(p.x, p.y - 20)}`],
      ]);
      popupMarkup.push(`<g class="${cls}"><path d="${text.d}" transform="translate(${fmt(-text.width / 2)} ${fmt(-text.height / 2)})" fill="${pal.popup}"/></g>`);
    }

    const stand = translate(midX - gnomeW / 2, gnomeY);
    const pf: Frame[] = [[0, stand]];
    const pts = simplify([[0, midX, 0], ...sim.player.map(({ t, x }): Way => [T(t), x, 0]), [Math.min(restore - 0.05, tEnd + 0.9), midX, 0], [duration, midX, 0]]);
    for (const [t, x] of pts) pf.push([t, translate(x - gnomeW / 2, gnomeY)]);
    playerMarkup = `<g class="${tl.track(pf)}"><use href="#gnome"/></g>`;
  } else {
    playerMarkup = `<g transform="translate(${fmt(midX - gnomeW / 2)} ${fmt(gnomeY)})"><use href="#gnome"/></g>`;
  }

  const bar = hud(tl, grid, { theme, title: "CENTIPEDE", clears, resetAt: restore, width });
  const end = sim
    ? banner(tl, {
        theme,
        lines: stageClearLines(grid),
        cx: width / 2,
        cy: layout.top + layout.gridHeight / 2,
        from: tEnd + 0.15,
        to: restore,
      })
    : "";

  const defs = glowDefs(theme) + strips + clip + segmentDef + headDef + gnomeDef + fleaDef + spiderDef + bulletDef + bursts.defs();
  body.push(
    `<g>${cells.join("")}</g>`,
    `<g>${mushroomMarkup.join("")}</g>`,
    `<g>${bulletMarkup.join("")}</g>`,
    `<g${glowAttr(theme)}>${segmentMarkup.join("")}${pestMarkup.join("")}${playerMarkup}</g>`,
    `<g>${burstMarkup.join("")}</g>`,
    `<g>${popupMarkup.join("")}</g>`,
    bar,
    end,
  );
  return { width, height, css: `${tl.css()}\n${bursts.css()}\n${css.join("\n")}`, defs, body: body.join("\n") };
}

export const centipede: Game = { id: "centipede", title: "Centipede", render };
