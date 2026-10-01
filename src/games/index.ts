import type { Game } from "../game.ts";
import { snake } from "./snake.ts";

export const GAMES: Record<string, Game> = {
  snake,
};
