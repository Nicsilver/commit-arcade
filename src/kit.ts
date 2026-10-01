import { fmt, type Timeline } from "./anim.ts";
import { activeCells, type Cell, type Grid } from "./grid.ts";
import { pixelText } from "./pixel-font.ts";
import { makeLayout, type Layout } from "./svg.ts";
import type { Theme } from "./theme.ts";

/**
 * Every game draws on the same canvas so a README that rotates games daily
 * doesn't reflow, and the graph sits in the same place in all of them.
 */
export const CANVAS = {
  width: 896,
  height: 216,
  /** Top of the graph; above it is the HUD and a one-cell lane. */
  gridTop: 48,
  hudY: 10,
} as const;

/** The standard layout: graph centred horizontally at CANVAS.gridTop. */
export function arcadeLayout(grid: Grid): Layout & { width: number; height: number } {
  const probe = makeLayout(grid);
  const width = Math.max(CANVAS.width, probe.gridWidth + 52);
  const layout = makeLayout(grid, { left: Math.round((width - probe.gridWidth) / 2), top: CANVAS.gridTop });
  return { ...layout, width, height: CANVAS.height };
}

/** Colour for a sprite made out of a day: brighter than the graph cell it came from. */
export function spriteColor(theme: Theme, cell: Pick<Cell, "level">): string {
  return theme.sprites[Math.max(1, cell.level) - 1];
}

export const GLOW_ID = "glow";

/** Filter definition for glowing sprites; empty when the theme has glow off. */
export function glowDefs(theme: Theme): string {
  if (theme.glow <= 0) return "";
  return (
    `<filter id="${GLOW_ID}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${fmt(theme.glow)}" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  );
}

/**
 * Attribute to put on sprite groups (never on the graph's hundreds of cells,
 * which would make the image slow to paint).
 */
export function glowAttr(theme: Theme): string {
  return theme.glow > 0 ? ` filter="url(#${GLOW_ID})"` : "";
}

export interface ClearEvent {
  /** Seconds from the start of the loop. */
  t: number;
  cell: Cell;
}

export interface HudOptions {
  theme: Theme;
  /** Game name shown in the middle, e.g. "PAC-MAN". */
  title: string;
  /** When each day was eaten / broken / shot. Drives the score. */
  clears: ClearEvent[];
  /** When the score drops back to zero, usually restoreAt(play). */
  resetAt: number;
  width: number;
}

const DIGITS = 6;
const HUD_SCALE = 2;

/**
 * Arcade score bar. The score counts contributions as the game clears the days
 * that hold them, so it ends on the year's total, which HI shows from the start.
 */
export function hud(tl: Timeline, grid: Grid, opts: HudOptions): string {
  const { theme, width } = opts;
  const total = activeCells(grid).reduce((sum, c) => sum + c.count, 0);
  const y = CANVAS.hudY;
  const out: string[] = [];

  const label = (text: string, x: number, fill: string) => {
    const p = pixelText(text, HUD_SCALE);
    out.push(`<path d="${p.d}" transform="translate(${fmt(x)} ${y})" fill="${fill}"/>`);
    return p.width;
  };

  const left = 26;
  const scoreX = left + label("SCORE", left, theme.muted) + 10;
  out.push(scoreDigits(tl, opts, scoreX, y, theme.ink));

  const title = pixelText(opts.title, HUD_SCALE);
  out.push(`<path d="${title.d}" transform="translate(${fmt((width - title.width) / 2)} ${y})" fill="${theme.accent}"${glowAttr(theme)}/>`);

  const hi = pad(total);
  const hiText = pixelText(hi, HUD_SCALE);
  const hiX = width - 26 - hiText.width;
  out.push(`<path d="${hiText.d}" transform="translate(${fmt(hiX)} ${y})" fill="${theme.ink}"/>`);
  label("HI", hiX - 10 - pixelText("HI", HUD_SCALE).width, theme.muted);

  return `<g class="hud">${out.join("")}</g>`;
}

function pad(n: number): string {
  return String(Math.min(n, 10 ** DIGITS - 1)).padStart(DIGITS, "0");
}

/**
 * One path per (position, digit) with an opacity track that is 1 while that
 * position shows that digit. Only digits a position actually shows get drawn.
 */
function scoreDigits(tl: Timeline, opts: HudOptions, x: number, y: number, fill: string): string {
  const steps: { t: number; value: number }[] = [{ t: 0, value: 0 }];
  let running = 0;
  for (const e of [...opts.clears].sort((a, b) => a.t - b.t)) {
    running += e.cell.count;
    steps.push({ t: e.t, value: running });
  }
  steps.push({ t: opts.resetAt, value: 0 });

  const advance = 6 * HUD_SCALE;
  const out: string[] = [];
  for (let pos = 0; pos < DIGITS; pos++) {
    const shown = steps.map((s) => ({ t: s.t, d: pad(s.value)[pos] }));
    const runs: { t: number; d: string }[] = [];
    for (const s of shown) {
      if (runs.length && runs[runs.length - 1].t === s.t) runs[runs.length - 1] = s;
      else if (!runs.length || runs[runs.length - 1].d !== s.d) runs.push(s);
    }
    for (const digit of new Set(runs.map((r) => r.d))) {
      const glyph = pixelText(digit, HUD_SCALE);
      const transform = `translate(${fmt(x + pos * advance)} ${y})`;
      if (runs.length === 1) {
        out.push(`<path d="${glyph.d}" transform="${transform}" fill="${fill}"/>`);
        continue;
      }
      const frames: [number, string][] = [];
      runs.forEach((r, i) => {
        const on = r.d === digit ? "opacity:1" : "opacity:0";
        if (i > 0) frames.push([r.t, runs[i - 1].d === digit ? "opacity:1" : "opacity:0"]);
        frames.push([r.t, on]);
      });
      out.push(`<path class="${tl.track(frames)}" d="${glyph.d}" transform="${transform}" fill="${fill}"/>`);
    }
  }
  return out.join("");
}

export interface BannerOptions {
  theme: Theme;
  lines: string[];
  /** Centre of the banner. */
  cx: number;
  cy: number;
  from: number;
  to: number;
}

/** The shared end-of-stage card: a panel with a big headline that blinks twice, then holds. */
export function banner(tl: Timeline, opts: BannerOptions): string {
  const { theme } = opts;
  const texts = opts.lines.map((line, i) => pixelText(line, i === 0 ? 4 : 2));
  const gap = 8;
  const innerH = texts.reduce((h, p) => h + p.height, 0) + gap * (texts.length - 1);
  const innerW = Math.max(...texts.map((p) => p.width));
  const w = innerW + 40;
  const h = innerH + 28;
  const x = opts.cx - w / 2;
  const y = opts.cy - h / 2;

  const f = opts.from;
  const blink = tl.track([
    [0, "opacity:0"],
    [f, "opacity:0"],
    [f, "opacity:1"],
    [f + 0.18, "opacity:1"],
    [f + 0.18, "opacity:0"],
    [f + 0.3, "opacity:0"],
    [f + 0.3, "opacity:1"],
    [f + 0.48, "opacity:1"],
    [f + 0.48, "opacity:0"],
    [f + 0.6, "opacity:0"],
    [f + 0.6, "opacity:1"],
    [opts.to, "opacity:1"],
    [opts.to + 0.25, "opacity:0"],
  ]);

  const parts = [
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="8" fill="${theme.surface}" fill-opacity="0.92" stroke="${theme.accent}" stroke-width="2"/>`,
  ];
  let ty = y + 14;
  texts.forEach((p, i) => {
    const fill = i === 0 ? theme.accent : theme.ink;
    parts.push(`<path d="${p.d}" transform="translate(${fmt(opts.cx - p.width / 2)} ${fmt(ty)})" fill="${fill}"${i === 0 ? glowAttr(theme) : ""}/>`);
    ty += p.height + gap;
  });
  return `<g class="${blink}">${parts.join("")}</g>`;
}

/** The standard end card text: same headline everywhere, the year's total underneath. */
export function stageClearLines(grid: Grid): string[] {
  const total = activeCells(grid).reduce((sum, c) => sum + c.count, 0);
  return ["STAGE CLEAR", `${total} CONTRIBUTIONS`];
}
