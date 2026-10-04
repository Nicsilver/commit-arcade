import { Timeline, fmt, translate, type Frame } from "../anim.ts";
import { PACE, loopDuration, restoreAt, type Game, type GameContext, type GameOutput } from "../game.ts";
import type { Cell } from "../grid.ts";
import { arcadeLayout, banner, glowAttr, glowDefs, hud, spriteColor, stageClearLines, type ClearEvent } from "../kit.ts";
import { pixelText } from "../pixel-font.ts";
import { isDark, mix } from "../sprite-kit.ts";
import { cellCenter, cellRect, levelColor } from "../svg.ts";
import type { Theme } from "../theme.ts";
import { FLAME, simulateBomberman, type PowerKind } from "./bomberman-sim.ts";

const OUTLINE = "#1b1f3b";
const TARGET_PLAY = 58;
const DEBRIS = "M-1-7h2v2h-2zM5-5h2v2h-2zM6-1h2v2h-2zM4 4h2v2h-2zM-1 5h2v2h-2zM-6 4h2v2h-2zM-8-1h2v2h-2zM-6-5h2v2h-2z";
/** Centre of the bomb artwork's bounding box, which the scale-in grows from. */
const BOMB_CENTER = [0.1, -1.6];

interface Palette {
  flameOuter: string;
  flameMid: string;
  flameCore: string;
  flameStroke: string;
  bombBody: string;
  bombRim: string;
  fuse: string;
  spark: string;
}

/**
 * One-shot effects share a few elements instead of one each: every slot plays
 * its events back to back on a single keyframe track, parked invisible in
 * between, so the browser has far fewer infinite animations to service.
 * Events must be added in start order; a slot is only reused for the same key.
 */
class Pool {
  private readonly slots: { key: string; end: number; layers: Frame[][] }[] = [];

  private readonly idle: string[];

  constructor(idle: string[]) {
    this.idle = idle;
  }

  add(key: string, start: number, end: number, layers: Frame[][]): void {
    let slot = this.slots.find((s) => s.key === key && s.end <= start);
    if (!slot) {
      slot = { key, end: 0, layers: this.idle.map((css): Frame[] => [[0, css]]) };
      this.slots.push(slot);
    }
    const open = slot;
    layers.forEach((frames, i) => open.layers[i].push([start, this.idle[i]], ...frames, [end, this.idle[i]]));
    slot.end = end;
  }

  markup(tl: Timeline, draw: (key: string, classes: string[]) => string): string {
    return this.slots.map((s) => draw(s.key, s.layers.map((frames) => tl.track(frames)))).join("");
  }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function paletteFor(theme: Theme): Palette {
  if (isDark(theme)) {
    return { flameOuter: "#ff7a1f", flameMid: "#ffd43b", flameCore: "#fffbe6", flameStroke: "none", bombBody: "#232842", bombRim: "#8f9bc4", fuse: "#d9b27a", spark: "#ffe14d" };
  }
  return { flameOuter: "#ff5f1f", flameMid: "#ffb21f", flameCore: "#fff6d0", flameStroke: "#b83c00", bombBody: "#161a2e", bombRim: "#0b0e1a", fuse: "#8a5a22", spark: "#ff9a1f" };
}

function render(ctx: GameContext): GameOutput {
  const { grid, theme } = ctx;
  const pal = paletteFor(theme);
  const layout = arcadeLayout(grid);
  const sim = simulateBomberman(grid, ctx.rng);
  const hasPlay = sim.breaks.length > 0;
  const dt = hasPlay ? Math.min(0.14, Math.max(0.085, TARGET_PLAY / sim.ticks)) : 0.14;
  const play = hasPlay ? Math.round(sim.ticks * dt * 100) / 100 : 3;
  const duration = loopDuration(play);
  const restore = restoreAt(play);
  const fadeEnd = restore + PACE.restore;
  const tl = new Timeline(duration);
  const at = (tick: number) => PACE.intro + tick * dt;
  const { cols, rows } = sim;

  const px = (idx: number): [number, number] => cellCenter(layout, (idx % cols) - 1, Math.floor(idx / cols) - 1);

  const cellSet = new Map<Cell, number>();
  for (const b of sim.breaks) cellSet.set(b.cell, at(b.tick));

  const defs: string[] = [glowDefs(theme)];
  for (let level = 1; level <= 4; level++) {
    const fill = theme.levels[level - 1];
    const mortar = luminance(fill) < 0.3 ? mix(fill, "#ffffff", 0.22) : mix(fill, "#000000", 0.32);
    defs.push(`<path id="bk${level}" d="M0 4H12M0 8H12M6 0V4M3 4V8M9 4V8M6 8V12" stroke="${mortar}" stroke-width="1" fill="none"/>`);
  }

  // Arena: faint floor under the lane so Bomberman visibly walks somewhere.
  const floor: string[] = [];
  const tiles: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const x = (i % cols) - 1;
    const y = Math.floor(i / cols) - 1;
    const lane = x < 0 || y < 0 || x >= grid.width || y >= grid.height;
    if (!lane) continue;
    const [cx, cy] = cellCenter(layout, x, y);
    floor.push(`<rect x="${fmt(cx - 6)}" y="${fmt(cy - 6)}" width="12" height="12" rx="2.4" fill="${theme.empty}" opacity=".5"/>`);
  }
  const glow = (inner: string) => (theme.glow > 0 ? `<g${glowAttr(theme)}>${inner}</g>` : inner);

  // Blocks: unbroken ones are static; the rest share one fading group per break
  // tick, and a pooled copy plays the crumble.
  const blocks: string[] = [];
  const doomed = new Map<number, string[]>();
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      tiles.push(cellRect(layout, cell, theme.empty));
      if (cell.level === 0) continue;
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      const fill = levelColor(theme, cell);
      const body = `<rect x="${fmt(cx - 6)}" y="${fmt(cy - 6)}" width="12" height="12" rx="${layout.radius}" fill="${fill}"/><use href="#bk${cell.level}" x="${fmt(cx - 6)}" y="${fmt(cy - 6)}"/>`;
      const te = cellSet.get(cell);
      if (te === undefined) {
        blocks.push(body);
        continue;
      }
      const group = doomed.get(te);
      if (group) group.push(body);
      else doomed.set(te, [body]);
    }
  }
  for (const [te, bodies] of [...doomed].sort((a, b) => a[0] - b[0])) {
    const cls = tl.track([
      [0, "opacity:1"],
      [te, "opacity:1"],
      [te, "opacity:0"],
      [restore, "opacity:0"],
      [fadeEnd, "opacity:1"],
    ]);
    blocks.push(`<g class="${cls}">${bodies.join("")}</g>`);
  }

  const byTick = [...sim.breaks].sort((a, b) => a.tick - b.tick);
  const crumbles = new Pool(["opacity:0;transform:translate(0px,0px) scale(1)"]);
  const debris = new Pool([`fill:${spriteColor(theme, { level: 1 })};opacity:0;transform:translate(0px,0px) scale(1.9) rotate(40deg)`]);
  const flashes = new Pool(["opacity:0;transform:translate(0px,0px) scale(1.5)"]);
  for (const b of byTick) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    const rest = "opacity:1;" + translate(cx, cy, "scale(1)");
    crumbles.add(String(b.cell.level), t, t + 0.15, [
      [
        [t, rest],
        [t + 0.03, "opacity:1;" + translate(cx, cy, "scale(1.22)")],
        [t + 0.15, "opacity:0;" + translate(cx, cy, "scale(.4)")],
      ],
    ]);
    const color = spriteColor(theme, b.cell);
    debris.add("", t, t + 0.4, [
      [
        [t, `fill:${color};opacity:1;` + translate(cx, cy, "scale(.45) rotate(0deg)")],
        [t + 0.4, `fill:${color};opacity:0;` + translate(cx, cy, "scale(1.9) rotate(40deg)")],
      ],
    ]);
    flashes.add("", t, t + 0.22, [
      [
        [t, "opacity:.95;" + translate(cx, cy, "scale(.3)")],
        [t + 0.22, "opacity:0;" + translate(cx, cy, "scale(1.5)")],
      ],
    ]);
  }
  blocks.push(
    crumbles.markup(tl, (level, [cls]) => {
      const fill = theme.levels[Number(level) - 1];
      return `<g class="${cls}"><rect x="-6" y="-6" width="12" height="12" rx="${layout.radius}" fill="${fill}"/><use href="#bk${level}" x="-6" y="-6"/></g>`;
    }),
  );
  const debrisMarkup = [
    debris.markup(tl, (_, [cls]) => `<path d="${DEBRIS}" class="${cls}"/>`),
    flashes.markup(tl, (_, [cls]) => `<circle r="7" fill="#fff" class="${cls}"/>`),
  ].join("");

  // Power-ups.
  const items: string[] = [];
  const popups = new Pool(["opacity:0;transform:translate(0px,0px)"]);
  const itemRings = new Pool(["opacity:0;transform:translate(0px,0px) scale(2.6)"]);
  const taken = [...sim.items].filter((i) => i.taken !== null).sort((a, b) => a.taken! - b.taken!);
  for (const item of sim.items) {
    const [cx, cy] = px(item.idx);
    const born = at(item.revealed);
    const gone = item.taken === null ? restore : at(item.taken);
    const cls = tl.track([
      [0, "opacity:0;transform:scale(.3)"],
      [born, "opacity:0;transform:scale(.3)"],
      [born + 0.12, "opacity:1;transform:scale(1.25)"],
      [born + 0.3, "opacity:1;transform:scale(1)"],
      [gone, "opacity:1;transform:scale(1)"],
      [gone + 0.18, "opacity:0;transform:scale(1.8)"],
      [duration, "opacity:0;transform:scale(1.8)"],
    ]);
    items.push(glow(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="c ${cls}"><g class="bob">${powerIcon(item.kind, pal)}</g></g></g>`));
  }
  for (const item of taken) {
    const [cx, cy] = px(item.idx);
    const t = at(item.taken!);
    const label = pixelText(item.kind === "fire" ? "FIRE UP" : "BOMB UP", 1);
    const lx = Math.min(Math.max(cx - label.width / 2, 12), layout.width - 12 - label.width);
    const ly = cy < 60 ? cy + 12 : cy - 24;
    popups.add(label.d, t, t + 1.2, [
      [
        [t, "opacity:0;" + translate(lx, ly)],
        [t + 0.08, "opacity:1;" + translate(lx, ly - 2)],
        [t + 0.9, "opacity:1;" + translate(lx, ly - 9)],
        [t + 1.2, "opacity:0;" + translate(lx, ly - 11)],
      ],
    ]);
    itemRings.add(item.kind === "fire" ? pal.flameMid : theme.accent, t, t + 0.55, [
      [
        [t, "opacity:1;" + translate(cx, cy, "scale(.2)")],
        [t + 0.55, "opacity:0;" + translate(cx, cy, "scale(2.6)")],
      ],
    ]);
  }
  const popupMarkup = popups.markup(
    tl,
    (d, [cls]) => `<path d="${d}" fill="#ffffff" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round" paint-order="stroke" class="${cls}"/>`,
  );

  // Bombs: scaling about the artwork's centre is baked into the translation so
  // a moving slot can still pop in around the bomb itself.
  const bombs = new Pool(["opacity:0;transform:translate(0px,0px) scale(1)"]);
  const bombCss = (cx: number, cy: number, scale: number, opacity: number) =>
    `opacity:${opacity};` + translate(cx + BOMB_CENTER[0] * (1 - scale), cy + BOMB_CENTER[1] * (1 - scale), `scale(${scale})`);
  for (const p of [...sim.plants].sort((a, b) => a.tick - b.tick)) {
    const [cx, cy] = px(p.idx);
    const t = at(p.tick);
    const life = (p.explode - p.tick) * dt;
    bombs.add("", t, t + life + 0.001, [
      [
        [t, bombCss(cx, cy, 0.4, 0)],
        [t + 0.001, bombCss(cx, cy, 0.55, 1)],
        [t + 0.12, bombCss(cx, cy, 1, 1)],
        [t + life, bombCss(cx, cy, 1, 1)],
        [t + life + 0.001, bombCss(cx, cy, 1, 0)],
      ],
    ]);
  }
  const bombMarkup = bombs.markup(tl, (_, [cls]) => `<g class="${cls}"${glowAttr(theme)}><g class="pulse">${bombShape(pal)}</g></g>`);

  // Blasts: the cross shape depends on the arm lengths, so slots are per shape.
  const flame = FLAME * dt;
  const blasts = new Pool([
    "opacity:0;transform:translate(0px,0px) scale(.92)",
    "opacity:0",
    "opacity:0",
  ]);
  const lastBlastTick = Math.max(...sim.blasts.map((b) => b.tick), 0);
  const bigRings = new Pool(["opacity:0;transform:translate(0px,0px) scale(4.2)"]);
  for (const b of [...sim.blasts].sort((a, c) => a.tick - c.tick)) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    blasts.add(b.arms.join(","), t, t + flame, [
      [
        [t, "opacity:1;" + translate(cx, cy, "scale(1.18)")],
        [t + dt, "opacity:1;" + translate(cx, cy, "scale(1)")],
        [t + flame - dt * 0.8, "opacity:1;" + translate(cx, cy, "scale(1)")],
        [t + flame, "opacity:0;" + translate(cx, cy, "scale(.92)")],
      ],
      [
        [t, "opacity:1"],
        [t + dt * 2.5, "opacity:1"],
        [t + flame - dt * 0.4, "opacity:0"],
      ],
      [
        [t, "opacity:1"],
        [t + dt * 0.9, "opacity:1"],
        [t + dt * 1.3, "opacity:0"],
        [t + dt * 2, "opacity:0"],
        [t + dt * 2, "opacity:.9"],
        [t + dt * 2.6, "opacity:0"],
      ],
    ]);
    if (b.tick === lastBlastTick) {
      bigRings.add("", t, t + 0.8, [
        [
          [t, "opacity:1;" + translate(cx, cy, "scale(.2)")],
          [t + 0.8, "opacity:0;" + translate(cx, cy, "scale(4.2)")],
        ],
      ]);
    }
  }
  const blastMarkup = blasts.markup(tl, (key, [flameCls, midCls, coreCls]) => {
    const arms = key.split(",").map(Number) as [number, number, number, number];
    const outer = crossShape(arms, 6, layout.pitch, pal.flameOuter, pal.flameStroke === "none" ? "" : ` stroke="${pal.flameStroke}" stroke-width="1"`);
    const mid = crossShape(arms, 3.8, layout.pitch, pal.flameMid, "");
    const core = crossShape(arms, 1.7, layout.pitch, pal.flameCore, "");
    return `<g class="${flameCls}"${glowAttr(theme)}>${outer}<g class="${midCls}">${mid}</g><g class="${coreCls}">${core}</g></g>`;
  });
  const ringMarkup =
    bigRings.markup(tl, (_, [cls]) => glow(`<circle r="9" fill="none" stroke="${theme.accent}" stroke-width="2.4" class="${cls}"/>`)) +
    itemRings.markup(tl, (color, [cls]) => glow(`<circle r="8" fill="none" stroke="${color}" stroke-width="2" class="${cls}"/>`));

  // Bomberman.
  const start = px(0);
  const path = sim.path.slice();
  while (path.length < sim.ticks + 1) path.push(path[path.length - 1]);
  const pts = path.map((idx) => px(idx));
  const posFrames: Frame[] = [[0, translate(pts[0][0], pts[0][1])]];
  const walkRuns: [number, number][] = [];
  const faceFrames: Frame[] = [[0, face(0, 1)]];
  let facing = "d";
  let runStart = -1;
  for (let k = 0; k < path.length - 1; k++) {
    const dx = pts[k + 1][0] - pts[k][0];
    const dy = pts[k + 1][1] - pts[k][1];
    const moving = dx !== 0 || dy !== 0;
    if (moving && runStart < 0) runStart = k;
    if (!moving && runStart >= 0) {
      walkRuns.push([runStart, k]);
      runStart = -1;
    }
    if (moving) {
      const dir = dx > 0 ? "r" : dx < 0 ? "l" : dy > 0 ? "d" : "u";
      if (dir !== facing) {
        const prev = faceFrames[faceFrames.length - 1][1];
        faceFrames.push([at(k), prev], [at(k), faceCss(dir)]);
        facing = dir;
      }
    }
    if (k > 0) {
      const vx = pts[k][0] - pts[k - 1][0];
      const vy = pts[k][1] - pts[k - 1][1];
      if (vx !== dx || vy !== dy) posFrames.push([at(k), translate(pts[k][0], pts[k][1])]);
    }
  }
  if (runStart >= 0) walkRuns.push([runStart, path.length - 1]);
  const endTick = path.length - 1;
  posFrames.push([at(endTick), translate(pts[endTick][0], pts[endTick][1])]);
  const hide = fadeEnd - 0.2;
  posFrames.push([hide, translate(pts[endTick][0], pts[endTick][1])], [hide, translate(start[0], start[1])], [duration, translate(start[0], start[1])]);
  const posCls = tl.track(posFrames);
  const faceCls = tl.track([...faceFrames, [hide, faceFrames[faceFrames.length - 1][1]], [hide, face(0, 1)]]);

  const walkFrames: Frame[] = [[0, "opacity:0"]];
  const standFrames: Frame[] = [[0, "opacity:1"]];
  for (const [a, b] of walkRuns) {
    walkFrames.push([at(a), "opacity:0"], [at(a), "opacity:1"], [at(b), "opacity:1"], [at(b), "opacity:0"]);
    standFrames.push([at(a), "opacity:1"], [at(a), "opacity:0"], [at(b), "opacity:0"], [at(b), "opacity:1"]);
  }
  const walkCls = tl.track(walkFrames);
  const standCls = tl.track(standFrames);

  const fadeCls = tl.track([
    [0, "opacity:1"],
    [restore + 0.1, "opacity:1"],
    [hide, "opacity:0"],
    [duration - 0.45, "opacity:0"],
    [duration - 0.1, "opacity:1"],
  ]);

  const cheer = PACE.intro + play + 0.1;
  const hop: Frame[] = [[0, "transform:translateY(0px)"], [cheer, "transform:translateY(0px)"]];
  for (let k = 0; k < 3; k++) {
    const t = cheer + k * 0.4;
    hop.push([t + 0.2, "transform:translateY(-6px)"], [t + 0.4, "transform:translateY(0px)"]);
  }
  const hopCls = tl.track(hasPlay ? hop : [[0, "transform:translateY(0px)"]]);
  const armsUp = tl.track(hasPlay ? [[0, "opacity:0"], [cheer, "opacity:0"], [cheer, "opacity:1"], [restore, "opacity:1"], [restore + 0.05, "opacity:0"]] : [[0, "opacity:0"]]);
  const armsDown = tl.track(hasPlay ? [[0, "opacity:1"], [cheer, "opacity:1"], [cheer, "opacity:0"], [restore, "opacity:0"], [restore + 0.05, "opacity:1"]] : [[0, "opacity:1"]]);

  const clears: ClearEvent[] = sim.breaks.map((b) => ({ t: at(b.tick), cell: b.cell }));
  const hudMarkup = hud(tl, grid, { theme, title: "BOMBERMAN", clears, resetAt: restore, width: layout.width });
  const gridCy = layout.top + layout.gridHeight / 2;
  const endCard = banner(tl, { theme, lines: stageClearLines(grid), cx: layout.width / 2, cy: gridCy, from: PACE.intro + play + 0.2, to: restore });

  const walkPeriod = fmt(dt * 2);
  const css = [
    ".c{transform-box:fill-box;transform-origin:center}",
    ".pulse{transform-box:fill-box;transform-origin:center;animation:pulse .4s ease-in-out infinite}",
    "@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}",
    ".spark{transform-box:fill-box;transform-origin:center;animation:spark .22s steps(1) infinite}",
    "@keyframes spark{0%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}",
    ".bob{animation:bob 1s ease-in-out infinite}",
    "@keyframes bob{0%,100%{transform:translateY(-1.2px)}50%{transform:translateY(1.2px)}}",
    `.fa{animation:fa ${walkPeriod}s steps(1) infinite}.fb{animation:fb ${walkPeriod}s steps(1) infinite}`,
    "@keyframes fa{0%{transform:translateY(-1.6px)}50%{transform:translateY(0)}}",
    "@keyframes fb{0%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}",
    ".nod{animation:nod .9s ease-in-out infinite}",
    "@keyframes nod{0%,100%{transform:translate(0,0)}50%{transform:translate(.8px,-.6px)}}",
    tl.css(),
  ].join("\n");

  const sprite = bomberSprite(theme, { standCls, walkCls, faceCls, armsUp, armsDown });
  const body = [
    `<g>${floor.join("")}</g>`,
    `<g>${tiles.join("")}</g>`,
    `<g>${blocks.join("")}</g>`,
    items.join(""),
    bombMarkup,
    blastMarkup,
    debrisMarkup,
    ringMarkup,
    `<g class="${posCls}"><g class="${fadeCls}"><g class="${hopCls}"${glowAttr(theme)}>${sprite}</g></g></g>`,
    popupMarkup,
    hudMarkup,
    endCard,
  ].join("\n");

  return { width: layout.width, height: layout.height, css, defs: defs.join(""), body };
}

function faceCss(dir: string): string {
  switch (dir) {
    case "l":
      return face(-2.2, 1);
    case "r":
      return face(2.2, 1);
    case "u":
      return face(0, 0);
    default:
      return face(0, 1);
  }
}

function face(x: number, visible: number): string {
  return `transform:translate(${fmt(x)}px,0px);opacity:${visible}`;
}

function crossShape(arms: [number, number, number, number], half: number, pitch: number, fill: string, extra: string): string {
  const [u, d, l, r] = arms;
  const h = `<rect x="${fmt(-(l * pitch + half))}" y="${fmt(-half)}" width="${fmt((l + r) * pitch + 2 * half)}" height="${fmt(2 * half)}" rx="${fmt(half * 0.85)}" fill="${fill}"${extra}/>`;
  const v = `<rect x="${fmt(-half)}" y="${fmt(-(u * pitch + half))}" width="${fmt(2 * half)}" height="${fmt((u + d) * pitch + 2 * half)}" ry="${fmt(half * 0.85)}" rx="${fmt(half * 0.85)}" fill="${fill}"${extra}/>`;
  const c = `<circle r="${fmt(half * 1.45)}" fill="${fill}"${extra}/>`;
  return h + v + c;
}

function bombShape(pal: Palette): string {
  return (
    `<circle cx="0" cy="1.2" r="5.8" fill="${pal.bombBody}" stroke="${pal.bombRim}" stroke-width="1"/>` +
    `<ellipse cx="-2" cy="-.6" rx="1.7" ry="1.1" fill="#fff" opacity=".75" transform="rotate(-30 -2 -.6)"/>` +
    `<rect x="-1.5" y="-6.1" width="3" height="2.2" rx=".6" fill="${pal.bombRim}"/>` +
    `<path d="M0-6.1Q1.6-8.4 3.4-8" stroke="${pal.fuse}" stroke-width="1.3" fill="none" stroke-linecap="round"/>` +
    `<g class="spark"><circle cx="4" cy="-8.2" r="2" fill="${pal.spark}"/><circle cx="4" cy="-8.2" r="0.9" fill="#fff"/></g>`
  );
}

function powerIcon(kind: PowerKind, pal: Palette): string {
  const panel = kind === "fire" ? "#e8461e" : "#2f6bff";
  const icon =
    kind === "fire"
      ? `<path d="M0-4.4C1.2-2.6 3.2-1.6 3.2 1A3.2 3.2 0 0 1-3.2 1C-3.2-.4-2.4-1.4-1.6-2.2 -1.4-1-.8-.6-.4-.6-.8-2.2-.6-3.4 0-4.4Z" fill="${pal.flameMid}"/>` +
        `<path d="M0-.6C.8 0 1.6.8 1.6 1.8A1.6 1.6 0 0 1-1.6 1.8C-1.6 1-.9.4 0-.6Z" fill="#fff"/>`
      : `<circle cx="-.4" cy="1" r="3" fill="#10142a"/><circle cx="-1.4" cy="0" r=".9" fill="#fff" opacity=".8"/>` +
        `<path d="M.8-1.6Q2.2-3.4 3.6-3" stroke="#fff" stroke-width="1" fill="none" stroke-linecap="round"/><circle cx="3.9" cy="-3.1" r="1" fill="${pal.spark}"/>`;
  return `<rect x="-7" y="-7" width="14" height="14" rx="3" fill="${panel}" stroke="#fff" stroke-width="1.4"/>${icon}`;
}

interface SpriteTracks {
  standCls: string;
  walkCls: string;
  faceCls: string;
  armsUp: string;
  armsDown: string;
}

function bomberSprite(theme: Theme, t: SpriteTracks): string {
  const o = OUTLINE;
  const dark = isDark(theme);
  const shadow = `<ellipse cx="0" cy="8.6" rx="6.4" ry="1.9" fill="#000" opacity="${dark ? 0.45 : 0.22}"/>`;
  const foot = (x: number, cls?: string) => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="5.6" width="4.4" height="3" rx="1.2" fill="#f4f7ff" stroke="${o}" stroke-width=".9"/>`;
  const hand = (x: number, y: number, cls?: string) => `<circle${cls ? ` class="${cls}"` : ""} cx="${x}" cy="${y}" r="1.9" fill="#ff8fc0" stroke="${o}" stroke-width=".9"/>`;
  const feetStand = `<g class="${t.standCls}">${foot(-5)}${foot(0.6)}</g>`;
  const feetWalk = `<g class="${t.walkCls}">${foot(-5, "fa")}${foot(0.6, "fb")}</g>`;
  const handsDown = `<g class="${t.armsDown}"><g class="${t.standCls}">${hand(-6.5, 3)}${hand(6.5, 3)}</g><g class="${t.walkCls}">${hand(-6.5, 3, "fb")}${hand(6.5, 3, "fa")}</g></g>`;
  const handsUp = `<g class="${t.armsUp}">${hand(-7, -3.5)}${hand(7, -3.5)}</g>`;
  const body = `<rect x="-4.7" y=".4" width="9.4" height="6.4" rx="2.2" fill="#3b6cff" stroke="${o}" stroke-width="1.1"/><rect x="-2" y="2" width="4" height="1.5" rx=".7" fill="#9db8ff"/>`;
  const helmet = `<circle cx="0" cy="-5.6" r="6.9" fill="#fafcff" stroke="${o}" stroke-width="1.3"/><path d="M-4.6-9.6A6 6 0 0 1 .6-11.6" stroke="#c8d3ee" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  const faceParts = `<g class="${t.faceCls}"><ellipse cx="0" cy="-4.8" rx="4.4" ry="3.5" fill="#ffd9bd" stroke="${o}" stroke-width=".8"/><rect x="-2.6" y="-6.2" width="1.4" height="2.6" rx=".6" fill="${o}"/><rect x="1.2" y="-6.2" width="1.4" height="2.6" rx=".6" fill="${o}"/></g>`;
  const antenna = `<path d="M0-12.2V-10.6" stroke="${o}" stroke-width="1.3"/><g class="nod"><circle cx="0" cy="-13" r="2" fill="#ff6fae" stroke="${o}" stroke-width=".9"/></g>`;
  return `${shadow}${feetStand}${feetWalk}${body}${handsDown}${handsUp}${helmet}${faceParts}${antenna}`;
}

export const bomberman: Game = { id: "bomberman", title: "Bomberman", render };
