import type { Game } from "../game.ts";
import { breakout } from "./breakout.ts";
import { pacman } from "./pacman.ts";
import { snake } from "./snake.ts";

export const GAMES: Record<string, Game> = {
  snake,
  pacman,
  breakout,
};
