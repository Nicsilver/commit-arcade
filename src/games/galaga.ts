import { Timeline, fmt, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { isDark, mix, pixelSprite } from "../sprite-kit.ts";
import { cellCenter, cellOrigin } from "../svg.ts";
import type { Theme } from "../theme.ts";
import { routeAt, type Route } from "./galaga-path.ts";
import { BREATH_STEP, FIGHTER_Y, SEP, breathAt, simulateGalaga, type EnemyRec } from "./galaga-sim.ts";
import { spriteImage } from "./galaga-sprites.ts";

const TARGET_PLAY = 58;
const MIN_SCALE = 0.6;
const SPRITE_SCALE = 1.1;
const SHIP_SCALE = 1.25;

const BEE_BODY = [
  ".....R.R.....",
  "....PPPPP....",
  "...PPPPPPP...",
  "...PWPPPWP...",
  "...PPPPPPP...",
  "....DPDPD....",
  ".....PPP.....",
  "......P......",
];
const BEE_WINGS_A = ["BB.........BB", "BBB.......BBB", ".BBB.....BBB.", "..BB.....BB.."];
const BEE_WINGS_B = ["..BB.....BB..", ".BBB.....BBB.", "BBB.......BBB", "BB.........BB"];

const FLY_A = [
  "P.....R.....P",
  "PP....D....PP",
  "PPP..DWD..PPP",
  "PPRP.DDD.PRPP",
  "PPPP.DDD.PPPP",
  ".PPP.DDD.PPP.",
  "..PP..D..PP..",
  "...P..D..P...",
  "......D......",
];
const FLY_B = [
  "......R......",
  ".....DDD.....",
  "..PP.DWD.PP..",
  ".PPPPDDDPPPP.",
  ".PRPPDDDPPRP.",
  ".PPPPDDDPPPP.",
  "..PP..D..PP..",
  "......D......",
  "......D......",
];

const BOSS_A = [
  "Y....YYY....Y",
  "YY..PPPPP..YY",
  ".YYPPPPPPPYY.",
  "..PPWPPPWPP..",
  "VVPPPPPPPPPVV",
  "VVVPDPPPDPVVV",
  ".VV.PDDDP.VV.",
  "..V..PPP..V..",
  ".....P.P.....",
  "....PP.PP....",
];
const BOSS_B = [
  "Y....YYY....Y",
  "YY..PPPPP..YY",
  ".YYPPPPPPPYY.",
  "..PPWPPPWPP..",
  "..VPPPPPPPV..",
  ".VVVPDPPPDVVV",
  "VV..PDDDP..VV",
  "V....PPP....V",
  ".....P.P.....",
  "....PP.PP....",
];

const SHIP = [
  "......W......",
  "......W......",
  ".....WWW.....",
  ".....WBW.....",
  "R....WBW....R",
  "R...WWBWW...R",
  "RR..WWWWW..RR",
  "RR.WWWRWWW.RR",
  "RRRWWWWWWWRRR",
  "RRRWW.W.WWRRR",
  "RRR.W.W.W.RRR",
  "R.R.......R.R",
];

function mergeRows(body: string[], wings: string[], wingsAt: number): string[] {
  const out: string[][] = Array.from({ length: body.length }, () => Array(13).fill("."));
  wings.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && (out[y + wingsAt][x] = ch)));
  body.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && (out[y][x] = ch)));
  return out.map((r) => r.join(""));
}

function enemyPalette(theme: Theme, level: number, damaged = false): Record<string, string> {
  const base = spriteColor(theme, { level: level as 1 | 2 | 3 | 4 });
  const P = damaged ? "#6f8cff" : base;
  return {
    D: mix(P, "#000000", 0.42),
    P,
    W: "#ffffff",
    R: "#ff4b5c",
    B: "#4d8dff",
    Y: "#ffd23a",
    V: damaged ? "#c9a0ff" : "#a05cff",
  };
}

interface Look {
  a: string[];
  b: string[];
}

function lookFor(kind: EnemyRec["kind"]): Look {
  if (kind === "bee") return { a: mergeRows(BEE_BODY, BEE_WINGS_A, 0), b: mergeRows(BEE_BODY, BEE_WINGS_B, 3) };
  if (kind === "butterfly") return { a: FLY_A, b: FLY_B };
  return { a: BOSS_A, b: BOSS_B };
}

function shipArt(white: boolean, theme: Theme): string {
  const pal = white
    ? { W: "#f4f7ff", R: "#ff3b3b", B: "#3b7bff" }
    : { W: "#ff8a8a", R: "#b3202c", B: "#ffd0d0" };
  const w = 13 * SHIP_SCALE;
  const h = SHIP.length * SHIP_SCALE;
  const outline = { color: isDark(theme) ? "#0a0d1a" : "#1b1f3b", width: 1.2 };
  return `<g transform="translate(${fmt(-w / 2)} ${fmt(-h / 2)})">${pixelSprite(SHIP, pal, SHIP_SCALE, outline)}</g>`;
}

function starPoints(r: number, inner: number, points: number): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${fmt(Math.cos(a) * rad)} ${fmt(Math.sin(a) * rad)}`);
  }
  return pts.join(" ");
}

/** One play of a pooled effect: when it starts, how long it lasts and the frames it runs, relative to that start. */
interface Beat {
  t: number;
  life: number;
  frames: Frame[];
}

/**
 * Spreads plays over as few lanes as possible; a lane is one element that
 * replays its plays one after another instead of every play owning an element.
 */
function packLanes<T extends { t: number; life: number }>(plays: T[]): T[][] {
  const lanes: T[][] = [];
  const free: number[] = [];
  for (const play of [...plays].sort((a, b) => a.t - b.t)) {
    const i = free.findIndex((end) => end <= play.t);
    const lane = i < 0 ? lanes.length : i;
    if (i < 0) lanes.push([]);
    lanes[lane].push(play);
    free[lane] = play.t + play.life + 0.002;
  }
  return lanes;
}

/**
 * Frames for a lane. Between plays the element sits in the state its last
 * play ended in (invisible), then jumps to the next play's first frame.
 */
function laneFrames(beats: Beat[]): Frame[] {
  const out: Frame[] = [[0, beats[0].frames[beats[0].frames.length - 1][1]]];
  for (const beat of beats) {
    out.push([beat.t, out[out.length - 1][1]]);
    for (const [dt, css] of beat.frames) out.push([beat.t + dt, css]);
  }
  return out;
}

function num(n: number): string {
  return String(Math.round(n * 1e4) / 1e4);
}

interface Raw {
  t: number;
  x: number;
  y: number;
  r: number;
  op: number;
}

/** The enemy's state at `t` along its track, interpolated the way the browser will. */
function poseAt(raw: Raw[], t: number): Raw {
  const sorted = [...raw].sort((a, b) => Math.round(a.t * 1e5) - Math.round(b.t * 1e5));
  let i = sorted.length - 1;
  while (i > 0 && sorted[i].t > t) i--;
  const a = sorted[i];
  const b = sorted[i + 1];
  if (!b || b.t <= a.t) return { ...a, t };
  const u = (t - a.t) / (b.t - a.t);
  const lerp = (p: number, q: number) => p + (q - p) * u;
  return { t, x: lerp(a.x, b.x), y: lerp(a.y, b.y), r: lerp(a.r, b.r), op: lerp(a.op, b.op) };
}

/**
 * Drops keys the browser would interpolate to within `tol` (one tolerance per
 * value) anyway. Keys at the same instant are jumps and always stay.
 */
function thin<T extends { t: number }>(keys: T[], values: (key: T) => number[], tol: number[]): T[] {
  const keep = keys.map(() => false);
  const same = (a: T, b: T) => Math.round(a.t * 1e5) === Math.round(b.t * 1e5);
  const run = (first: number, last: number) => {
    keep[first] = keep[last] = true;
    const stack: [number, number][] = [[first, last]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      const va = values(keys[a]);
      const vb = values(keys[b]);
      let worst = 1;
      let at = -1;
      for (let k = a + 1; k < b; k++) {
        const u = (keys[k].t - keys[a].t) / (keys[b].t - keys[a].t);
        const vk = values(keys[k]);
        const err = Math.max(...vk.map((v, i) => Math.abs(v - (va[i] + (vb[i] - va[i]) * u)) / tol[i]));
        if (err > worst) {
          worst = err;
          at = k;
        }
      }
      if (at < 0) continue;
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  };
  let first = 0;
  for (let i = 1; i <= keys.length; i++) {
    if (i === keys.length || same(keys[i], keys[i - 1])) {
      if (i - 1 >= first) run(first, i - 1);
      first = i;
    }
  }
  return keys.filter((_, i) => keep[i]);
}

/**
 * Glow filter with a fixed region around the element's own origin. The stock
 * one is sized from whatever its group holds, which for a pooled element means
 * everywhere it has ever been.
 */
function glowRegion(theme: Theme, id: string, halfWidth: number, halfHeight: number): string {
  if (theme.glow <= 0) return "";
  return (
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="${fmt(-halfWidth)}" y="${fmt(-halfHeight)}" width="${fmt(halfWidth * 2)}" height="${fmt(halfHeight * 2)}">` +
    `<feGaussianBlur stdDeviation="${fmt(theme.glow)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  );
}

function filterAttr(theme: Theme, id: string): string {
  return theme.glow > 0 ? ` filter="url(#${id})"` : "";
}

function render(ctx: GameContext): GameOutput {
  const { grid, theme, rng } = ctx;
  const dark = isDark(theme);
  const layout = arcadeLayout(grid);
  const cx = layout.width / 2;
  const cy = layout.top + layout.gridHeight / 2;
  const sim = simulateGalaga(grid, rng, {
    width: layout.width,
    centerX: cx,
    centerY: cy,
    slot: (c) => cellCenter(layout, c.x, c.y),
  });
  const hasPlay = sim.enemies.length > 0;
  const scale = hasPlay ? Math.min(1, Math.max(MIN_SCALE, TARGET_PLAY / sim.end)) : 1;
  const play = hasPlay ? Math.round(sim.end * scale * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (tau: number) => PACE.intro + tau * scale;
  const playEnd = PACE.intro + play;

  const defs: string[] = [glowDefs(theme)];
  const outline = dark ? undefined : { color: "#1b1f3b", width: 0.7 };
  const kindsUsed = new Set(sim.enemies.map((e) => `${e.kind}:${e.kind === "bee" ? e.cell.level : e.kind === "butterfly" ? 3 : 4}`));
  for (const key of kindsUsed) {
    const [kind, lv] = key.split(":");
    const level = Number(lv);
    const look = lookFor(kind as EnemyRec["kind"]);
    const flap = (pal: Record<string, string>) => {
      const one = (rows: string[], cls: string) => {
        const w = 13 * SPRITE_SCALE;
        const h = rows.length * SPRITE_SCALE;
        return spriteImage(rows, pal, { sigma: theme.glow, cell: SPRITE_SCALE, x: -w / 2, y: -h / 2, outline }, `class="${cls}"`);
      };
      return one(look.a, "fa") + one(look.b, "fb");
    };
    defs.push(`<g id="e-${kind}${level}">${flap(enemyPalette(theme, level))}</g>`);
    if (kind === "boss") defs.push(`<g id="e-${kind}${level}h">${flap(enemyPalette(theme, level, true))}</g>`);
  }
  defs.push(`<g id="shipw">${shipArt(true, theme)}</g><g id="shipr">${shipArt(false, theme)}</g>`);
  const boomStroke = dark ? "" : ` stroke="#7a1f10" stroke-width="1" stroke-linejoin="round"`;
  defs.push(
    `<g id="bs"><polygon points="${starPoints(12, 5.2, 8)}" fill="#ff5a3c"${boomStroke}/><polygon points="${starPoints(8.4, 3.6, 8)}" fill="#ffd23a"/><circle r="3.6" fill="#fff"/></g>`,
    `<circle id="br" r="6" fill="none" stroke="#7fe3ff" stroke-width="2"/>`,
    `<path id="bp" d="M-1-12h2v3h-2zM9-9l2 2-2 2-2-2zM11 0h3v2h-3zM8 8l2 2-2 2-2-2zM-1 9h2v3h-2zM-9 8l2 2-2 2-2-2zM-14 0h3v2h-3zM-9-9l2 2-2 2-2-2z"/>`,
  );

  // Stars: three drifting layers, each a set of tiny twinkling dots drawn twice so the scroll tiles.
  const starColors = dark ? ["#ff7a7a", "#7ad0ff", "#ffe27a", "#ffffff", "#8dffa8", "#cfa0ff"] : ["#d9534f", "#2f8fd4", "#c79a00", "#6a6f85", "#2fa05a", "#8250df"];
  const layers: string[] = [];
  const speeds = [26, 44, 70];
  const sizes = [1, 1.3, 1.7];
  for (let li = 0; li < 3; li++) {
    const dots: string[] = [];
    for (let i = 0; i < 22; i++) {
      const x = fmt(rng() * layout.width);
      const y = rng() * layout.height;
      const color = starColors[Math.floor(rng() * starColors.length)];
      const tw = `tw${Math.floor(rng() * 3)}`;
      const delay = fmt(-rng() * 3);
      const side = fmt(sizes[li]);
      const dot = (dy: number) => `M${x} ${fmt(y + dy)}h${side}v${side}h-${side}z`;
      dots.push(`<path class="${tw}" style="animation-delay:${delay}s" d="${dot(0)}${dot(-layout.height)}" fill="${color}"/>`);
    }
    layers.push(`<g class="sc" style="animation-duration:${fmt(layout.height / speeds[li])}s">${dots.join("")}</g>`);
  }

  // One path for the whole graph: hundreds of separate rects cost a draw call each, every frame.
  const r = layout.radius;
  const inner = layout.cell - r * 2;
  const tiles = [`<path fill="${theme.empty}" d="`];
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      const [x, y] = cellOrigin(layout, cell.x, cell.y);
      tiles.push(`M${fmt(x + r)} ${fmt(y)}h${inner}a${r} ${r} 0 0 1 ${r} ${r}v${inner}a${r} ${r} 0 0 1-${r} ${r}h-${inner}a${r} ${r} 0 0 1-${r}-${r}v-${inner}a${r} ${r} 0 0 1 ${r}-${r}z`);
    }
  }
  tiles.push('"/>');

  // Formation.
  const css = (x: number, y: number, r: number, op = 1) => `opacity:${op};transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(r)}deg)`;
  const capture = sim.capture;
  const rescue = sim.rescue;
  const lookId = (e: EnemyRec) => `e-${e.kind}${e.kind === "bee" ? e.cell.level : e.kind === "butterfly" ? 3 : 4}`;
  const enemyEls: string[] = [];
  const clears: ClearEvent[] = [];

  const routeRaw = (route: Route, start: number, upTo: number | null, raw: Raw[]) => {
    for (let i = 0; i < route.t.length; i++) {
      if (upTo !== null && route.t[i] >= upTo) break;
      raw.push({ t: at(start + route.t[i]), x: route.x[i], y: route.y[i], r: route.r[i], op: 1 });
    }
    if (upTo !== null) {
      const p = routeAt(route, upTo);
      raw.push({ t: at(start + upTo), x: p.x, y: p.y, r: p.r, op: 1 });
    }
  };

  for (const e of sim.enemies) {
    const [sx, sy] = e.slot;
    let raw: Raw[] = [{ t: 0, x: sx, y: sy, r: 0, op: 1 }];
    const rest = (t: number, op = 1) => raw.push({ t, x: sx, y: sy, r: 0, op });
    const isCaptor = capture !== null && capture.boss === e.id;
    let dives = e.dives;
    if (isCaptor) {
      const c = dives[0];
      rest(at(c.start));
      routeRaw(c.route, c.start, null, raw);
      const last = c.route.t.length - 1;
      raw.push({ t: at(capture.returnStart), x: c.route.x[last], y: c.route.y[last], r: c.route.r[last], op: 1 });
      raw.push({ t: at(capture.returnStart), x: capture.hover[0], y: capture.hover[1], r: 0, op: 1 });
      rest(at(capture.returnEnd));
      dives = dives.slice(1);
    }
    for (const d of dives) {
      rest(at(d.start));
      if (d.killed) {
        routeRaw(d.route, d.start, d.end - d.start, raw);
      } else {
        routeRaw(d.route, d.start, null, raw);
        rest(at(d.end));
      }
    }
    if (e.death !== null) {
      const td = at(e.death);
      if (!e.dives.some((d) => d.killed)) rest(td);
      const last = raw[raw.length - 1];
      raw.push({ ...last, t: td + 0.001, op: 0 });
      clears.push({ t: td, cell: e.cell });
    }
    rest(restore, 0);
    rest(fadeEnd);
    raw.sort((a, b) => Math.round(a.t * 1e5) - Math.round(b.t * 1e5));
    raw = thin(raw, (q) => [q.x, q.y, q.r, q.op], [0.04, 0.04, 0.15, 0.002]);

    const id = lookId(e);
    const pose = (q: Raw, op = q.op) => `opacity:${op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px) rotate(${fmt(q.r)}deg)`;
    if (e.kind !== "boss") {
      enemyEls.push(`<use href="#${id}" class="${tl.track(raw.map((q): Frame => [q.t, pose(q)]))}"/>`);
      continue;
    }
    const hit = e.hit === null ? null : at(e.hit);
    if (!isCaptor || !capture) {
      if (hit === null) {
        enemyEls.push(`<use href="#${id}" class="${tl.track(raw.map((q): Frame => [q.t, pose(q)]))}"/>`);
        continue;
      }
      // A hit boss changes look for good, so each look gets its own element and track.
      const p = poseAt(raw, hit);
      const healthy: Frame[] = [...raw.filter((q) => q.t < hit).map((q): Frame => [q.t, pose(q)]), [hit, pose(p)], [hit, pose(p, 0)], ...raw.filter((q) => q.t >= restore).map((q): Frame => [q.t, pose(q)])];
      const hurt: Frame[] = [
        [0, pose(raw[0], 0)],
        [hit, pose(p, 0)],
        [hit, pose(p)],
        ...raw.filter((q) => q.t > hit && q.t < restore).map((q): Frame => [q.t, pose(q)]),
        ...raw.filter((q) => q.t >= restore).map((q): Frame => [q.t, pose(q, 0)]),
      ];
      enemyEls.push(`<use href="#${id}" class="${tl.track(healthy)}"/><use href="#${id}h" class="${tl.track(hurt)}"/>`);
      continue;
    }
    const healthy = tl.track(hit === null ? [[0, "opacity:1"]] : [[0, "opacity:1"], [hit, "opacity:1"], [hit, "opacity:0"], [restore, "opacity:0"], [restore, "opacity:1"]]);
    const hurt = tl.track(hit === null ? [[0, "opacity:0"]] : [[0, "opacity:0"], [hit, "opacity:0"], [hit, "opacity:1"], [restore, "opacity:1"], [restore, "opacity:0"]]);
    const look = `<use href="#${id}" class="${healthy}"/><use href="#${id}h" class="${hurt}"/>`;
    // The captive ship hangs below its captor without turning with it, so position and rotation get separate tracks.
    const pos = tl.track(raw.map((q): Frame => [q.t, `opacity:${q.op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px)`]));
    const rot = tl.track(raw.map((q): Frame => [q.t, `transform:rotate(${fmt(q.r)}deg)`]));
    const shown = at(capture.abductEnd);
    const gone = rescue ? at(rescue.t) : restore;
    const capTrack = tl.track([[0, "opacity:0"], [shown, "opacity:0"], [shown, "opacity:1"], [gone, "opacity:1"], [gone, "opacity:0"]]);
    enemyEls.push(`<g class="${pos}"><g class="${rot}">${look}</g><use href="#shipr" class="${capTrack}" y="19"/></g>`);
  }

  // Tractor beam, drawn in formation space so it stays attached to the boss as the formation breathes.
  let beam = "";
  if (capture) {
    const [hx, hy] = capture.hover;
    const top = hy + 9;
    const height = FIGHTER_Y + 16 - top;
    const w0 = 5;
    const w1 = 22;
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const y = (height / 6) * (i + 0.5);
      const half = w0 + ((w1 - w0) * y) / height;
      lines.push(`<path class="bl" style="animation-delay:${fmt(-i * 0.09)}s" d="M${fmt(-half)} ${fmt(y)}Q0 ${fmt(y + 5)} ${fmt(half)} ${fmt(y)}" fill="none" stroke="#bfeaff" stroke-width="1.6"/>`);
    }
    const on = at(capture.beamOn);
    const off = at(capture.beamOff);
    const shown = tl.track([
      [0, "opacity:0"],
      [on, "opacity:0"],
      [on + 0.12, "opacity:1"],
      [off, "opacity:1"],
      [off + 0.3, "opacity:0"],
    ]);
    const grow = tl.track([
      [0, "transform:scaleY(.05)"],
      [on, "transform:scaleY(.05)"],
      [on + 0.12, "transform:scaleY(.2)"],
      [on + 0.55, "transform:scaleY(1)"],
    ]);
    beam = `<g class="${shown}"${glowAttr(theme)}><g transform="translate(${fmt(hx)} ${fmt(top)})"><g class="${grow}" style="transform-origin:0 0"><polygon points="${fmt(-w0)} 0 ${fmt(w0)} 0 ${fmt(w1)} ${fmt(height)} ${fmt(-w1)} ${fmt(height)}" fill="#4db8ff" opacity=".28"/>${lines.join("")}</g></g></g>`;
  }

  // Breathing.
  const breath: Frame[] = [[0, "transform:scale(1)"]];
  for (let k = 0; k * BREATH_STEP <= sim.end + 1e-6; k++) breath.push([at(k * BREATH_STEP), `transform:scale(${(1 + breathAt(k * BREATH_STEP)).toFixed(4)})`]);
  breath.push([at(sim.end) + 0.01, "transform:scale(1)"], [duration, "transform:scale(1)"]);
  const breathCls = hasPlay ? tl.track(breath) : tl.track([[0, "transform:scale(1)"]]);

  // Shots and explosions replay on a few shared elements.
  const reach = Math.ceil(theme.glow * 3) + 1;
  const shotBeats: Beat[] = [];
  for (const s of sim.shots) {
    const dist = s.y0 - s.yEnd;
    const dur = Math.round((s.tEnd - s.t) * scale * 200) / 200;
    if (dist < 1 || dur <= 0) continue;
    const from = `translate(${fmt(s.x)}px,${fmt(s.y0)}px)`;
    const to = `translate(${fmt(s.x)}px,${fmt(s.y0 - dist)}px)`;
    shotBeats.push({
      t: at(s.t),
      life: dur + 0.001,
      frames: [[0, `opacity:1;transform:${from}`], [dur, `opacity:1;transform:${to}`], [dur + 0.001, `opacity:0;transform:${to}`]],
    });
  }
  // The glow filter sits on the lane itself, with a region of one bullet plus the blur, and is skipped while the lane is at opacity 0.
  defs.push(glowRegion(theme, "glow-shot", 1.4 + reach, 5 + reach));
  const shotEls = packLanes(shotBeats).map(
    (lane) => `<g class="${tl.track(laneFrames(lane))}"${filterAttr(theme, "glow-shot")}><rect x="-1.4" y="-5" width="2.8" height="10" rx="1" fill="${theme.accent}"/><rect x="-.5" y="-5" width="1" height="8" fill="#fff"/></g>`,
  );

  // Each slot is a group that moves to its explosion and holds one element per part, replaying explosions in turn.
  const BOOM_LIFE = 0.55;
  const boomScale = (b: { size: string }) => (b.size === "l" ? 1.9 : b.size === "m" ? 1.35 : 1);
  const boomPose = (k: number, extra = "") => `scale(${num(k)})${extra}`;
  const boomRegions = new Map<string, number>();
  const slots = packLanes(sim.booms.map((b) => ({ t: at(b.t), life: BOOM_LIFE, b })));
  const boomEls = slots.map((slot) => {
    const star: Beat[] = [];
    const ring: Beat[] = [];
    const spark: Beat[] = [];
    const ring2: Beat[] = [];
    for (const { t, b } of slot) {
      const k = boomScale(b);
      star.push({
        t,
        life: 0.4,
        frames: [[0, `opacity:1;transform:${boomPose(k * 0.3)}`], [0.1, `opacity:1;transform:${boomPose(k)}`], [0.4, `opacity:0;transform:${boomPose(k * 1.45)}`]],
      });
      const ringFrames: Frame[] = [[0, `opacity:1;transform:${boomPose(k * 0.4)}`], [0.4, `opacity:0;transform:${boomPose(k * 3.2)}`]];
      ring.push({ t, life: 0.4, frames: ringFrames });
      spark.push({
        t,
        life: 0.55,
        frames: [[0, `opacity:1;transform:${boomPose(k * 0.5, " rotate(0deg)")}`], [0.55, `opacity:0;transform:${boomPose(k * 2.1, " rotate(35deg)")}`]],
      });
      if (b.size === "l") ring2.push({ t: t + 0.12, life: 0.4, frames: ringFrames });
    }
    const parts = [
      `<use href="#bs" class="${tl.track(laneFrames(star))}"/>`,
      `<use href="#br" class="${tl.track(laneFrames(ring))}"/>`,
      `<use href="#bp" fill="${theme.accent}" class="${tl.track(laneFrames(spark))}"/>`,
    ];
    if (ring2.length) parts.push(`<use href="#br" class="${tl.track(laneFrames(ring2))}" stroke="${theme.accent}"/>`);
    // A glow filter costs a blur even while everything inside is invisible, but not while its group is at opacity 0.
    const move = slot.map(({ t, b }): Beat => {
      const place = `translate(${fmt(b.x)}px,${fmt(b.y)}px)`;
      return { t, life: BOOM_LIFE, frames: [[0, `opacity:1;transform:${place}`], [BOOM_LIFE, `opacity:1;transform:${place}`], [BOOM_LIFE + 0.001, `opacity:0;transform:${place}`]] };
    });
    // The blur region only has to hold the biggest explosion the slot plays (the spark flies out to about 30 units).
    const half = Math.ceil(30 * Math.max(...slot.map(({ b }) => boomScale(b)))) + reach;
    boomRegions.set(`glow-boom-${half}`, half);
    return `<g class="${tl.track(laneFrames(move))}"${filterAttr(theme, `glow-boom-${half}`)}>${parts.join("")}</g>`;
  });
  for (const [id, half] of boomRegions) defs.push(glowRegion(theme, id, half, half));

  // Fighter.
  const keyCss = (k: { x: number; y: number; rot: number; scale: number }) => `transform:translate(${fmt(k.x)}px,${fmt(k.y)}px) rotate(${fmt(k.rot)}deg) scale(${fmt(k.scale)})`;
  const fighterFrames: Frame[] = [];
  for (const k of thin(sim.fighter, (f) => [f.x, f.y, f.rot, f.scale], [0.04, 0.04, 0.15, 0.002])) fighterFrames.push([at(k.t), keyCss(k)]);
  const startKey = sim.fighter[0] ?? { x: cx, y: FIGHTER_Y, rot: 0, scale: 1, t: 0 };
  const endKey = sim.fighter[sim.fighter.length - 1] ?? startKey;
  const hideAt = restore + 0.3;
  fighterFrames.push([hideAt, keyCss(endKey)], [hideAt, keyCss(startKey)], [duration, keyCss(startKey)]);
  const fighterCls = tl.track(hasPlay ? fighterFrames : [[0, keyCss(startKey)]]);
  const fadeFrames: Frame[] = sim.fade.map((k) => [at(k.t), `opacity:${k.opacity}`]);
  fadeFrames.push([restore, "opacity:1"], [hideAt, "opacity:0"], [duration - 0.45, "opacity:0"], [duration - 0.1, "opacity:1"]);
  const fadeCls = tl.track(hasPlay ? fadeFrames : [[0, "opacity:1"]]);
  const dualAt = rescue ? at(rescue.dockAt) : -1;
  const shipB = tl.track(rescue ? [[0, "opacity:0"], [dualAt, "opacity:0"], [dualAt, "opacity:1"], [restore, "opacity:1"], [hideAt, "opacity:0"]] : [[0, "opacity:0"]]);
  let flyer = "";
  if (rescue) {
    const t0 = at(rescue.t);
    const t1 = at(rescue.dockAt);
    const ff: Frame[] = [[0, "opacity:0"], [t0, "opacity:0"]];
    const [fx0, fy0] = rescue.from;
    const [fx1, fy1] = rescue.to;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const ease = u * u * (3 - 2 * u);
      const x = fx0 + (fx1 - fx0) * ease;
      const y = fy0 + (fy1 - fy0) * ease - Math.sin(Math.PI * u) * 26;
      ff.push([t0 + (t1 - t0) * u, `opacity:1;transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(720 * (1 - ease))}deg)`]);
    }
    ff.push([t1 + 0.001, `opacity:0;transform:translate(${fmt(fx1)}px,${fmt(fy1)}px) rotate(0deg)`], [duration, `opacity:0;transform:translate(${fmt(fx1)}px,${fmt(fy1)}px) rotate(0deg)`]);
    // Hidden outside the flight so the glow filter is skipped.
    flyer = `<g class="${tl.visible(t0, t1 + 0.002)}"${glowAttr(theme)}><use href="#shipw" class="${tl.track(ff)}"/></g>`;
  }

  const stageCss = [
    ".sc{animation:scroll linear infinite}",
    `@keyframes scroll{from{transform:translateY(0)}to{transform:translateY(${layout.height}px)}}`,
    ".tw0{animation:tw .9s ease-in-out infinite}.tw1{animation:tw 1.4s ease-in-out infinite}.tw2{animation:tw 2.1s ease-in-out infinite}",
    "@keyframes tw{0%,100%{opacity:.95}50%{opacity:.25}}",
    // The wing flap is one animated variable on the root that every sprite reads, instead of an animation per sprite.
    // Browsers that cannot animate it just show the first frame.
    "@property --fa{syntax:'*';inherits:true;initial-value:visible}@property --fb{syntax:'*';inherits:true;initial-value:hidden}",
    ":root{animation:flap .7s steps(1) infinite}@keyframes flap{0%{--fa:visible;--fb:hidden}50%{--fa:hidden;--fb:visible}100%{--fa:visible;--fb:hidden}}",
    ".fa{visibility:var(--fa,visible)}.fb{visibility:var(--fb,hidden)}",
    ".bl{animation:beam .6s linear infinite}",
    "@keyframes beam{0%{opacity:0}30%{opacity:1}100%{opacity:0}}",
    `.breath{transform-origin:${fmt(cx)}px ${fmt(cy)}px}`,
  ].join("\n");

  const hudMarkup = hud(tl, grid, { theme, title: "GALAGA", clears, resetAt: restore, width: layout.width });
  const endCard = banner(tl, { theme, lines: stageClearLines(grid), cx, cy, from: playEnd + 0.2, to: restore });

  const body = [
    `<g>${layers.join("")}</g>`,
    `<g>${tiles.join("")}</g>`,
    `<g class="breath ${breathCls}">${beam}${enemyEls.join("")}</g>`,
    shotEls.join(""),
    boomEls.join(""),
    flyer,
    `<g class="${fighterCls}"><g class="${fadeCls}"${glowAttr(theme)}><use href="#shipw"/><use href="#shipw" x="${SEP}" class="${shipB}"/></g></g>`,
    hudMarkup,
    endCard,
  ].join("\n");

  return { width: layout.width, height: layout.height, css: `${stageCss}\n${tl.css()}`, defs: defs.join(""), body };
}

export const galaga: Game = { id: "galaga", title: "Galaga", render };
