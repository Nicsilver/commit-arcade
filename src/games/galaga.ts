import { Timeline, fmt, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { isDark, mix, pixelSprite } from "../sprite-kit.ts";
import { cellCenter, cellRect } from "../svg.ts";
import type { Theme } from "../theme.ts";
import { routeAt, type Route } from "./galaga-path.ts";
import { BREATH_STEP, FIGHTER_Y, SEP, breathAt, simulateGalaga, type EnemyRec } from "./galaga-sim.ts";

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

function frames(rows: string[], pal: Record<string, string>, outline?: { color: string; width: number }): string {
  const w = 13 * SPRITE_SCALE;
  const h = rows.length * SPRITE_SCALE;
  return `<g transform="translate(${fmt(-w / 2)} ${fmt(-h / 2)})">${pixelSprite(rows, pal, SPRITE_SCALE, outline)}</g>`;
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
    defs.push(`<g id="e-${kind}${level}-a">${frames(look.a, enemyPalette(theme, level), outline)}</g>`);
    defs.push(`<g id="e-${kind}${level}-b">${frames(look.b, enemyPalette(theme, level), outline)}</g>`);
    if (kind === "boss") {
      defs.push(`<g id="e-${kind}${level}-c">${frames(look.a, enemyPalette(theme, level, true), outline)}</g>`);
      defs.push(`<g id="e-${kind}${level}-d">${frames(look.b, enemyPalette(theme, level, true), outline)}</g>`);
    }
  }
  defs.push(`<g id="shipw">${shipArt(true, theme)}</g><g id="shipr">${shipArt(false, theme)}</g>`);
  const boomStroke = dark ? "" : ` stroke="#7a1f10" stroke-width="1" stroke-linejoin="round"`;
  defs.push(
    `<g id="bs"><polygon points="${starPoints(12, 5.2, 8)}" fill="#ff5a3c"${boomStroke}/><polygon points="${starPoints(8.4, 3.6, 8)}" fill="#ffd23a"/><circle r="3.6" fill="#fff"/></g>`,
    `<circle id="br" r="6" fill="none" stroke="#7fe3ff" stroke-width="2"/>`,
    `<path id="bp" d="M-1-12h2v3h-2zM9-9l2 2-2 2-2-2zM11 0h3v2h-3zM8 8l2 2-2 2-2-2zM-1 9h2v3h-2zM-9 8l2 2-2 2-2-2zM-14 0h3v2h-3zM-9-9l2 2-2 2-2-2z"/>`,
  );

  const starKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.3)"],
    [0.1, "opacity:1;transform:scale(1)"],
    [0.4, "opacity:0;transform:scale(1.45)"],
    [duration, "opacity:0;transform:scale(1.45)"],
  ]);
  const ringKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.4)"],
    [0.4, "opacity:0;transform:scale(3.2)"],
    [duration, "opacity:0;transform:scale(3.2)"],
  ]);
  const sparkKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.5) rotate(0deg)"],
    [0.55, "opacity:0;transform:scale(2.1) rotate(35deg)"],
    [duration, "opacity:0;transform:scale(2.1) rotate(35deg)"],
  ]);
  const bulletKfs = new Map<string, string>();

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
      const s = sizes[li];
      for (const dy of [0, -layout.height]) {
        dots.push(`<rect class="${tw}" style="animation-delay:${delay}s" x="${x}" y="${fmt(y + dy)}" width="${s}" height="${s}" fill="${color}"/>`);
      }
    }
    layers.push(`<g class="sc" style="animation-duration:${fmt(layout.height / speeds[li])}s">${dots.join("")}</g>`);
  }

  const tiles: string[] = [];
  for (const column of grid.cells) for (const cell of column) if (cell) tiles.push(cellRect(layout, cell, theme.empty));

  // Formation.
  const css = (x: number, y: number, r: number, op = 1) => `opacity:${op};transform:translate(${fmt(x)}px,${fmt(y)}px) rotate(${fmt(r)}deg)`;
  const capture = sim.capture;
  const rescue = sim.rescue;
  const lookId = (e: EnemyRec) => `e-${e.kind}${e.kind === "bee" ? e.cell.level : e.kind === "butterfly" ? 3 : 4}`;
  const enemyEls: string[] = [];
  const clears: ClearEvent[] = [];

  interface Raw {
    t: number;
    x: number;
    y: number;
    r: number;
    op: number;
  }

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
    const raw: Raw[] = [{ t: 0, x: sx, y: sy, r: 0, op: 1 }];
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

    const id = lookId(e);
    const flap = (suffix: string[]) => `<use href="#${id}-${suffix[0]}" class="fa"/><use href="#${id}-${suffix[1]}" class="fb"/>`;
    if (e.kind !== "boss") {
      const cls = tl.track(raw.map((q): Frame => [q.t, `opacity:${q.op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px) rotate(${fmt(q.r)}deg)`]));
      enemyEls.push(`<g class="${cls}">${flap(["a", "b"])}</g>`);
      continue;
    }
    const hit = e.hit === null ? null : at(e.hit);
    const healthy = tl.track(hit === null ? [[0, "opacity:1"]] : [[0, "opacity:1"], [hit, "opacity:1"], [hit, "opacity:0"], [restore, "opacity:0"], [restore, "opacity:1"]]);
    const hurt = tl.track(hit === null ? [[0, "opacity:0"]] : [[0, "opacity:0"], [hit, "opacity:0"], [hit, "opacity:1"], [restore, "opacity:1"], [restore, "opacity:0"]]);
    const look = `<g class="${healthy}">${flap(["a", "b"])}</g><g class="${hurt}">${flap(["c", "d"])}</g>`;
    // The captive ship hangs below its captor without turning with it, so position and rotation get separate tracks.
    const pos = tl.track(raw.map((q): Frame => [q.t, `opacity:${q.op};transform:translate(${fmt(q.x)}px,${fmt(q.y)}px)`]));
    const rot = tl.track(raw.map((q): Frame => [q.t, `transform:rotate(${fmt(q.r)}deg)`]));
    let captive = "";
    if (isCaptor && capture) {
      const shown = at(capture.abductEnd);
      const gone = rescue ? at(rescue.t) : restore;
      const capTrack = tl.track([[0, "opacity:0"], [shown, "opacity:0"], [shown, "opacity:1"], [gone, "opacity:1"], [gone, "opacity:0"]]);
      captive = `<use href="#shipr" class="${capTrack}" y="19"/>`;
    }
    enemyEls.push(`<g class="${pos}"><g class="${rot}">${look}</g>${captive}</g>`);
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
    const grow = tl.track([
      [0, "opacity:0;transform:scaleY(.05)"],
      [on, "opacity:0;transform:scaleY(.05)"],
      [on + 0.12, "opacity:1;transform:scaleY(.2)"],
      [on + 0.55, "opacity:1;transform:scaleY(1)"],
      [off, "opacity:1;transform:scaleY(1)"],
      [off + 0.3, "opacity:0;transform:scaleY(1)"],
    ]);
    beam = `<g transform="translate(${fmt(hx)} ${fmt(top)})"><g class="${grow}" style="transform-origin:0 0"><polygon points="${fmt(-w0)} 0 ${fmt(w0)} 0 ${fmt(w1)} ${fmt(height)} ${fmt(-w1)} ${fmt(height)}" fill="#4db8ff" opacity=".28"/>${lines.join("")}</g></g>`;
  }

  // Breathing.
  const breath: Frame[] = [[0, "transform:scale(1)"]];
  for (let k = 0; k * BREATH_STEP <= sim.end + 1e-6; k++) breath.push([at(k * BREATH_STEP), `transform:scale(${(1 + breathAt(k * BREATH_STEP)).toFixed(4)})`]);
  breath.push([at(sim.end) + 0.01, "transform:scale(1)"], [duration, "transform:scale(1)"]);
  const breathCls = hasPlay ? tl.track(breath) : tl.track([[0, "transform:scale(1)"]]);

  // Shots.
  const shotEls: string[] = [];
  for (const s of sim.shots) {
    const dist = s.y0 - s.yEnd;
    const dur = Math.round((s.tEnd - s.t) * scale * 200) / 200;
    if (dist < 1 || dur <= 0) continue;
    const key = `${Math.round(dist * 2)}:${dur}`;
    let name = bulletKfs.get(key);
    if (!name) {
      name = tl.keyframes([
        [0, "opacity:1;transform:translateY(0px)"],
        [dur, "opacity:1;transform:translateY(" + fmt(-dist) + "px)"],
        [dur + 0.001, "opacity:0;transform:translateY(" + fmt(-dist) + "px)"],
        [duration, "opacity:0;transform:translateY(" + fmt(-dist) + "px)"],
      ]);
      bulletKfs.set(key, name);
    }
    const cls = tl.useKeyframes(name, at(s.t));
    shotEls.push(`<g transform="translate(${fmt(s.x)} ${fmt(s.y0)})"><g class="${cls}"><rect x="-1.4" y="-5" width="2.8" height="10" rx="1" fill="${theme.accent}"/><rect x="-.5" y="-5" width="1" height="8" fill="#fff"/></g></g>`);
  }

  // Explosions.
  const boomEls: string[] = [];
  for (const b of sim.booms) {
    const t = at(b.t);
    const k = b.size === "l" ? 1.9 : b.size === "m" ? 1.35 : 1;
    const parts = [
      `<use href="#bs" class="${tl.useKeyframes(starKf, t)}"/>`,
      `<use href="#br" class="${tl.useKeyframes(ringKf, t)}"/>`,
      `<use href="#bp" fill="${theme.accent}" class="${tl.useKeyframes(sparkKf, t)}"/>`,
    ];
    if (b.size === "l") parts.push(`<use href="#br" class="${tl.useKeyframes(ringKf, t + 0.12)}" stroke="${theme.accent}"/>`);
    boomEls.push(`<g transform="translate(${fmt(b.x)} ${fmt(b.y)}) scale(${k})">${parts.join("")}</g>`);
  }

  // Fighter.
  const keyCss = (k: { x: number; y: number; rot: number; scale: number }) => `transform:translate(${fmt(k.x)}px,${fmt(k.y)}px) rotate(${fmt(k.rot)}deg) scale(${fmt(k.scale)})`;
  const fighterFrames: Frame[] = [];
  for (const k of sim.fighter) fighterFrames.push([at(k.t), keyCss(k)]);
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
    flyer = `<g${glowAttr(theme)}><use href="#shipw" class="${tl.track(ff)}"/></g>`;
  }

  const stageCss = [
    ".sc{animation:scroll linear infinite}",
    `@keyframes scroll{from{transform:translateY(0)}to{transform:translateY(${layout.height}px)}}`,
    ".tw0{animation:tw .9s ease-in-out infinite}.tw1{animation:tw 1.4s ease-in-out infinite}.tw2{animation:tw 2.1s ease-in-out infinite}",
    "@keyframes tw{0%,100%{opacity:.95}50%{opacity:.25}}",
    ".fa{animation:flapa .7s steps(1) infinite}.fb{animation:flapb .7s steps(1) infinite}",
    "@keyframes flapa{0%{opacity:1}50%{opacity:0}}@keyframes flapb{0%{opacity:0}50%{opacity:1}}",
    ".bl{animation:beam .6s linear infinite}",
    "@keyframes beam{0%{opacity:0}30%{opacity:1}100%{opacity:0}}",
    `.breath{transform-origin:${fmt(cx)}px ${fmt(cy)}px}`,
  ].join("\n");

  const hudMarkup = hud(tl, grid, { theme, title: "GALAGA", clears, resetAt: restore, width: layout.width });
  const endCard = banner(tl, { theme, lines: stageClearLines(grid), cx, cy, from: playEnd + 0.2, to: restore });

  const body = [
    `<g>${layers.join("")}</g>`,
    `<g>${tiles.join("")}</g>`,
    `<g class="breath ${breathCls}"${glowAttr(theme)}>${beam}${enemyEls.join("")}</g>`,
    `<g${glowAttr(theme)}>${shotEls.join("")}</g>`,
    `<g${glowAttr(theme)}>${boomEls.join("")}</g>`,
    flyer,
    `<g class="${fighterCls}"><g class="${fadeCls}"${glowAttr(theme)}><use href="#shipw"/><use href="#shipw" x="${SEP}" class="${shipB}"/></g></g>`,
    hudMarkup,
    endCard,
  ].join("\n");

  return { width: layout.width, height: layout.height, css: `${stageCss}\n${tl.css()}`, defs: defs.join(""), body };
}

export const galaga: Game = { id: "galaga", title: "Galaga", render };
