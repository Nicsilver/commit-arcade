import { fmt } from "./anim.ts";
import { bitmapPath } from "./pixel-font.ts";
import type { Theme } from "./theme.ts";

export function isDark(theme: Theme): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.ink.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** Linear blend of two #rrggbb colours; t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t = 0.5): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  const hex = (i: number) =>
    Math.round(pa[i] + (pb[i] - pa[i]) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}

/**
 * Multi-colour pixel art as one path per colour. Rows use palette characters
 * and "." for empty. An optional outline is the sprite's silhouette stroked
 * underneath, so a white sprite still reads on a white page.
 */
export function pixelSprite(rows: string[], palette: Record<string, string>, scale = 1, outline?: { color: string; width: number }): string {
  const parts: string[] = [];
  if (outline) {
    const silhouette = bitmapPath(
      rows.map((r) => r.replace(/[^.]/g, "#")),
      scale,
    );
    parts.push(`<path d="${silhouette}" fill="${outline.color}" stroke="${outline.color}" stroke-width="${fmt(outline.width)}" stroke-linejoin="round"/>`);
  }
  for (const [key, fill] of Object.entries(palette)) {
    if (!rows.some((r) => r.includes(key))) continue;
    const mask = rows.map((r) => [...r].map((ch) => (ch === key ? "#" : ".")).join(""));
    parts.push(`<path d="${bitmapPath(mask, scale)}" fill="${fill}"/>`);
  }
  return parts.join("");
}

/** Pixel width of the widest row, height of the sprite, at the given scale. */
export function spriteSize(rows: string[], scale = 1): { width: number; height: number } {
  return { width: Math.max(...rows.map((r) => r.length)) * scale, height: rows.length * scale };
}
