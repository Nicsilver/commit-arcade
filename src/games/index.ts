import type { Game } from "../game.ts";
import { asteroids } from "./asteroids.ts";
import { bomberman } from "./bomberman.ts";
import { breakout } from "./breakout.ts";
import { centipede } from "./centipede.ts";
import { galaga } from "./galaga.ts";
import { invaders } from "./invaders.ts";
import { pacman } from "./pacman.ts";
import { snake } from "./snake.ts";
import { tetris } from "./tetris.ts";
import { tron } from "./tron.ts";

export const GAMES: Record<string, Game> = {
  snake,
  pacman,
  breakout,
  invaders,
  asteroids,
  tetris,
  bomberman,
  galaga,
  centipede,
  tron,
};
