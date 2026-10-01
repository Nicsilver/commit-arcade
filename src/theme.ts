export interface Theme {
  name: string;
  /** null leaves the SVG transparent so it sits on the page background. */
  background: string | null;
  /** Empty day. */
  empty: string;
  /** Levels 1-4, light to heavy. */
  levels: [string, string, string, string];
  /** HUD text, outlines, the paddle and ship. */
  ink: string;
  /** Secondary HUD text. */
  muted: string;
  /** Highlight for the player's sprite where a game has no classic colour. */
  accent: string;
  /**
   * Levels 1-4 for sprites made out of a day (invaders, snake segments, rocks).
   * A step brighter than the graph so even quiet days read as sprites.
   */
  sprites: [string, string, string, string];
  /** Solid fill behind banners, matching the page the image usually sits on. */
  surface: string;
  /** Glow blur radius for sprites; 0 turns glow off. */
  glow: number;
}

export const THEMES: Record<string, Theme> = {
  "github-dark": {
    name: "github-dark",
    background: null,
    empty: "#151b23",
    levels: ["#033a16", "#196c2e", "#2ea043", "#56d364"],
    ink: "#e6edf3",
    muted: "#7d8590",
    accent: "#f5b53d",
    sprites: ["#2ea043", "#3fb950", "#56d364", "#7ee787"],
    surface: "#0d1117",
    glow: 1.6,
  },
  "github-light": {
    name: "github-light",
    background: null,
    empty: "#eff2f5",
    levels: ["#aceebb", "#4ac26b", "#2da44e", "#116329"],
    ink: "#1f2328",
    muted: "#59636e",
    accent: "#8250df",
    sprites: ["#4ac26b", "#2da44e", "#1a7f37", "#116329"],
    surface: "#ffffff",
    glow: 0,
  },
  neon: {
    name: "neon",
    background: "#0b0614",
    empty: "#1a1029",
    levels: ["#3b1d6e", "#6a2fd0", "#b14dff", "#ff4df0"],
    ink: "#f4ecff",
    muted: "#8c7aa8",
    accent: "#23f0ff",
    sprites: ["#8a4dff", "#b46bff", "#e07bff", "#ff6bf5"],
    surface: "#0b0614",
    glow: 3,
  },
};

export function resolveTheme(name: string, overrides: Partial<Theme> = {}): Theme {
  const base = THEMES[name];
  if (!base) {
    throw new Error(`Unknown theme "${name}". Pick one of: ${Object.keys(THEMES).join(", ")}`);
  }
  return { ...base, ...overrides };
}
