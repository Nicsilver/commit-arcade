import { fmt } from "./anim.ts";
import type { Cell, Grid } from "./grid.ts";
import type { Theme } from "./theme.ts";

export interface Layout {
  /** Side of one day square. */
  cell: number;
  /** Space between squares. */
  gap: number;
  /** cell + gap. */
  pitch: number;
  radius: number;
  /** Top-left corner of the graph inside the SVG. */
  left: number;
  top: number;
  /** Size of the graph itself. */
  gridWidth: number;
  gridHeight: number;
}

export function makeLayout(grid: Grid, opts: { left?: number; top?: number; cell?: number; gap?: number } = {}): Layout {
  const cell = opts.cell ?? 12;
  const gap = opts.gap ?? 4;
  const pitch = cell + gap;
  return {
    cell,
    gap,
    pitch,
    radius: Math.round(cell / 5),
    left: opts.left ?? 16,
    top: opts.top ?? 16,
    gridWidth: grid.width * pitch - gap,
    gridHeight: grid.height * pitch - gap,
  };
}

/** Top-left pixel of a grid square. */
export function cellOrigin(layout: Layout, x: number, y: number): [number, number] {
  return [layout.left + x * layout.pitch, layout.top + y * layout.pitch];
}

/** Centre pixel of a grid square. */
export function cellCenter(layout: Layout, x: number, y: number): [number, number] {
  const [ox, oy] = cellOrigin(layout, x, y);
  return [ox + layout.cell / 2, oy + layout.cell / 2];
}

export function levelColor(theme: Theme, cell: Cell | null): string {
  if (!cell || cell.level === 0) return theme.empty;
  return theme.levels[cell.level - 1];
}

/** One day square as GitHub draws it. `attrs` is appended raw (class, style...). */
export function cellRect(layout: Layout, cell: Cell, fill: string, attrs = ""): string {
  const [x, y] = cellOrigin(layout, cell.x, cell.y);
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${layout.cell}" height="${layout.cell}" rx="${layout.radius}" fill="${fill}"${attrs ? " " + attrs : ""}/>`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SvgParts {
  width: number;
  height: number;
  title: string;
  css: string;
  defs?: string;
  body: string;
  background: string | null;
}

export function svgDocument(p: SvgParts): string {
  const bg = p.background ? `<rect width="100%" height="100%" fill="${p.background}"/>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(p.width)} ${fmt(p.height)}" width="${fmt(p.width)}" height="${fmt(p.height)}" role="img" aria-label="${esc(p.title)}">`,
    `<title>${esc(p.title)}</title>`,
    `<style>${p.css}</style>`,
    p.defs ? `<defs>${p.defs}</defs>` : "",
    bg,
    p.body,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}
