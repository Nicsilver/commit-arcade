import type { Grid } from "./grid.ts";
import type { Rng } from "./rng.ts";
import type { Theme } from "./theme.ts";

export interface GameContext {
  grid: Grid;
  theme: Theme;
  rng: Rng;
}

export interface GameOutput {
  width: number;
  height: number;
  /** Everything the animation needs, usually Timeline.css() plus static rules. */
  css: string;
  defs?: string;
  body: string;
}

export interface Game {
  id: string;
  /** Shown as the SVG title, e.g. "Snake". */
  title: string;
  render(ctx: GameContext): GameOutput;
}

/**
 * Shared pacing so every game loops the same way: the full graph sits still
 * for a beat, the game plays, the cleared board holds, then the graph fades
 * back in and the loop restarts.
 */
export const PACE = {
  intro: 1.0,
  hold: 1.2,
  restore: 0.6,
  rest: 0.4,
} as const;

/** Loop length for a game whose play phase lasts `play` seconds. */
export function loopDuration(play: number): number {
  return PACE.intro + play + PACE.hold + PACE.restore + PACE.rest;
}

/** When cleared cells start fading back in, for a game whose play phase lasts `play` seconds. */
export function restoreAt(play: number): number {
  return PACE.intro + play + PACE.hold;
}
