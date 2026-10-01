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
  defs.push(`<path id="deb" d="M-1-7h2v2h-2zM5-5h2v2h-2zM6-1h2v2h-2zM4 4h2v2h-2zM-1 5h2v2h-2zM-6 4h2v2h-2zM-8-1h2v2h-2zM-6-5h2v2h-2z"/>`);

  // Shared one-shot effects: every instance replays the same keyframes with its own lag.
  const burstKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.45) rotate(0deg)"],
    [0.4, "opacity:0;transform:scale(1.9) rotate(40deg)"],
    [duration, "opacity:0;transform:scale(1.9) rotate(40deg)"],
  ]);
  const flashKf = tl.keyframes([
    [0, "opacity:.95;transform:scale(.3)"],
    [0.22, "opacity:0;transform:scale(1.5)"],
    [duration, "opacity:0;transform:scale(1.5)"],
  ]);
  const ringKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.2)"],
    [0.55, "opacity:0;transform:scale(2.6)"],
    [duration, "opacity:0;transform:scale(2.6)"],
  ]);
  const bigRingKf = tl.keyframes([
    [0, "opacity:1;transform:scale(.2)"],
    [0.8, "opacity:0;transform:scale(4.2)"],
    [duration, "opacity:0;transform:scale(4.2)"],
  ]);
  const popKf = tl.keyframes([
    [0, "opacity:0;transform:translateY(0px)"],
    [0.08, "opacity:1;transform:translateY(-2px)"],
    [0.9, "opacity:1;transform:translateY(-9px)"],
    [1.2, "opacity:0;transform:translateY(-11px)"],
    [duration, "opacity:0;transform:translateY(-11px)"],
  ]);
  const flame = FLAME * dt;
  const flameKf = tl.keyframes([
    [0, "opacity:1;transform:scale(1.18)"],
    [dt, "opacity:1;transform:scale(1)"],
    [flame - dt * 0.8, "opacity:1;transform:scale(1)"],
    [flame, "opacity:0;transform:scale(.92)"],
    [duration, "opacity:0;transform:scale(.92)"],
  ]);
  const flameMidKf = tl.keyframes([
    [0, "opacity:1"],
    [dt * 2.5, "opacity:1"],
    [flame - dt * 0.4, "opacity:0"],
    [duration, "opacity:0"],
  ]);
  const flameCoreKf = tl.keyframes([
    [0, "opacity:1"],
    [dt * 0.9, "opacity:1"],
    [dt * 1.3, "opacity:0"],
    [dt * 2, "opacity:0"],
    [dt * 2, "opacity:.9"],
    [dt * 2.6, "opacity:0"],
    [duration, "opacity:0"],
  ]);
  const bombLife = new Map<number, string>();
  const bombKf = (life: number): string => {
    const key = Math.round(life * 1000);
    let name = bombLife.get(key);
    if (!name) {
      name = tl.keyframes([
        [0, "opacity:0;transform:scale(.4)"],
        [0.001, "opacity:1;transform:scale(.55)"],
        [0.12, "opacity:1;transform:scale(1)"],
        [life, "opacity:1;transform:scale(1)"],
        [life + 0.001, "opacity:0;transform:scale(1)"],
        [duration, "opacity:0;transform:scale(1)"],
      ]);
      bombLife.set(key, name);
    }
    return name;
  };

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
  const blocks: string[] = [];
  for (const column of grid.cells) {
    for (const cell of column) {
      if (!cell) continue;
      tiles.push(cellRect(layout, cell, theme.empty));
      if (cell.level === 0) continue;
      const [cx, cy] = cellCenter(layout, cell.x, cell.y);
      const fill = levelColor(theme, cell);
      const te = cellSet.get(cell);
      const body = `<rect x="${fmt(cx - 6)}" y="${fmt(cy - 6)}" width="12" height="12" rx="${layout.radius}" fill="${fill}"/><use href="#bk${cell.level}" x="${fmt(cx - 6)}" y="${fmt(cy - 6)}"/>`;
      if (te === undefined) {
        blocks.push(`<g>${body}</g>`);
        continue;
      }
      const rest = "opacity:1;transform:scale(1)";
      const cls = tl.track([
        [0, rest],
        [te, rest],
        [te + 0.03, "opacity:1;transform:scale(1.22)"],
        [te + 0.15, "opacity:0;transform:scale(.4)"],
        [restore, "opacity:0;transform:scale(1)"],
        [fadeEnd, rest],
      ]);
      blocks.push(`<g class="c ${cls}">${body}</g>`);
    }
  }

  // Block crumble: debris scatters outward from the block, plus a white flash.
  const debris: string[] = [];
  for (const b of sim.breaks) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    const color = spriteColor(theme, b.cell);
    debris.push(
      `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><use href="#deb" fill="${color}" class="${tl.useKeyframes(burstKf, t)}"/><circle r="7" fill="#fff" class="${tl.useKeyframes(flashKf, t)}"/></g>`,
    );
  }

  // Power-ups.
  const items: string[] = [];
  const popups: string[] = [];
  const itemRings: string[] = [];
  for (const item of sim.items) {
    const [cx, cy] = px(item.idx);
    const born = at(item.revealed);
    const taken = item.taken === null ? restore : at(item.taken);
    const cls = tl.track([
      [0, "opacity:0;transform:scale(.3)"],
      [born, "opacity:0;transform:scale(.3)"],
      [born + 0.12, "opacity:1;transform:scale(1.25)"],
      [born + 0.3, "opacity:1;transform:scale(1)"],
      [taken, "opacity:1;transform:scale(1)"],
      [taken + 0.18, "opacity:0;transform:scale(1.8)"],
      [duration, "opacity:0;transform:scale(1.8)"],
    ]);
    items.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="c ${cls}"><g class="bob">${powerIcon(item.kind, pal)}</g></g></g>`);
    if (item.taken !== null) {
      const label = pixelText(item.kind === "fire" ? "FIRE UP" : "BOMB UP", 1);
      const lx = Math.min(Math.max(cx - label.width / 2, 12), layout.width - 12 - label.width);
      const ly = cy < 60 ? cy + 12 : cy - 24;
      popups.push(
        `<g transform="translate(${fmt(lx)} ${fmt(ly)})"><path d="${label.d}" fill="#ffffff" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round" paint-order="stroke" class="${tl.useKeyframes(popKf, taken)}"/></g>`,
      );
      itemRings.push(
        `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><circle r="8" fill="none" stroke="${item.kind === "fire" ? pal.flameMid : theme.accent}" stroke-width="2" class="${tl.useKeyframes(ringKf, taken)}"/></g>`,
      );
    }
  }

  // Bombs.
  const bombs: string[] = [];
  for (const p of sim.plants) {
    const [cx, cy] = px(p.idx);
    const life = (p.explode - p.tick) * dt;
    const cls = tl.useKeyframes(bombKf(life), at(p.tick));
    bombs.push(`<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="c ${cls}"><g class="pulse">${bombShape(pal)}</g></g></g>`);
  }

  // Blasts.
  const lastBlastTick = Math.max(...sim.blasts.map((b) => b.tick), 0);
  const blasts: string[] = [];
  const bigRings: string[] = [];
  for (const b of sim.blasts) {
    const [cx, cy] = px(b.idx);
    const t = at(b.tick);
    const outer = crossShape(b.arms, 6, layout.pitch, pal.flameOuter, pal.flameStroke === "none" ? "" : ` stroke="${pal.flameStroke}" stroke-width="1"`);
    const mid = crossShape(b.arms, 3.8, layout.pitch, pal.flameMid, "");
    const core = crossShape(b.arms, 1.7, layout.pitch, pal.flameCore, "");
    blasts.push(
      `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><g class="${tl.useKeyframes(flameKf, t)}">${outer}<g class="${tl.useKeyframes(flameMidKf, t)}">${mid}</g><g class="${tl.useKeyframes(flameCoreKf, t)}">${core}</g></g></g>`,
    );
    if (b.tick === lastBlastTick) {
      bigRings.push(
        `<g transform="translate(${fmt(cx)} ${fmt(cy)})"><circle r="9" fill="none" stroke="${theme.accent}" stroke-width="2.4" class="${tl.useKeyframes(bigRingKf, t)}"/></g>`,
      );
    }
  }

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
    `<g${glowAttr(theme)}>${items.join("")}</g>`,
    `<g${glowAttr(theme)}>${bombs.join("")}</g>`,
    `<g${glowAttr(theme)}>${blasts.join("")}</g>`,
    `<g>${debris.join("")}</g>`,
    `<g${glowAttr(theme)}>${bigRings.join("")}${itemRings.join("")}</g>`,
    `<g class="${posCls}"><g class="${fadeCls}"><g class="${hopCls}"${glowAttr(theme)}>${sprite}</g></g></g>`,
    popups.join(""),
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
