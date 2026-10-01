import type { Game } from "../game.ts";
import { asteroids } from "./asteroids.ts";
import { breakout } from "./breakout.ts";
import { invaders } from "./invaders.ts";
import { pacman } from "./pacman.ts";
import { snake } from "./snake.ts";
import { tetris } from "./tetris.ts";

export const GAMES: Record<string, Game> = {
  snake,
  pacman,
  breakout,
  invaders,
  asteroids,
  tetris,
};
