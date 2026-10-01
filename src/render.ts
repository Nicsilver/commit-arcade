import type { Game } from "./game.ts";
import { GAMES } from "./games/index.ts";
import type { Grid } from "./grid.ts";
import { createRng } from "./rng.ts";
import { svgDocument } from "./svg.ts";
import type { Theme } from "./theme.ts";

export const GAME_IDS = Object.keys(GAMES);

/** "daily" picks a game by UTC date, so a scheduled workflow rotates through all of them. */
export function resolveGameId(id: string, now = new Date()): string {
  if (id === "daily") {
    const day = Math.floor(now.getTime() / 86_400_000);
    return GAME_IDS[day % GAME_IDS.length];
  }
  if (!GAMES[id]) {
    throw new Error(`Unknown game "${id}". Pick one of: ${[...GAME_IDS, "daily"].join(", ")}`);
  }
  return id;
}

export function renderGame(game: Game, grid: Grid, theme: Theme, seed: string): string {
  const out = game.render({ grid, theme, rng: createRng(`${seed}:${game.id}`) });
  return svgDocument({
    width: out.width,
    height: out.height,
    title: `${game.title} played on a GitHub contribution graph`,
    css: out.css,
    defs: out.defs,
    body: out.body,
    background: theme.background,
  });
}
