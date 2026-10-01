import type { Game } from "../game.ts";
import { pacman } from "./pacman.ts";
import { snake } from "./snake.ts";

export const GAMES: Record<string, Game> = {
  snake,
  pacman,
};
