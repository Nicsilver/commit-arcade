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
  },
  "github-light": {
    name: "github-light",
    background: null,
    empty: "#eff2f5",
    levels: ["#aceebb", "#4ac26b", "#2da44e", "#116329"],
    ink: "#1f2328",
    muted: "#59636e",
    accent: "#bf8700",
  },
  neon: {
    name: "neon",
    background: "#0b0614",
    empty: "#1a1029",
    levels: ["#3b1d6e", "#6a2fd0", "#b14dff", "#ff4df0"],
    ink: "#f4ecff",
    muted: "#8c7aa8",
    accent: "#23f0ff",
  },
};

export function resolveTheme(name: string, overrides: Partial<Theme> = {}): Theme {
  const base = THEMES[name];
  if (!base) {
    throw new Error(`Unknown theme "${name}". Pick one of: ${Object.keys(THEMES).join(", ")}`);
  }
  return { ...base, ...overrides };
}
