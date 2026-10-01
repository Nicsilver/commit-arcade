import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Grid } from "./grid.ts";
import { GAMES } from "./games/index.ts";
import { renderGame, resolveGameId } from "./render.ts";
import { resolveTheme, type Theme } from "./theme.ts";

export interface OutputSpec {
  path: string;
  game: string;
  theme: string;
  overrides: Partial<Theme>;
}

const COLOR_KEYS = ["background", "empty", "ink", "muted", "accent"] as const;

/**
 * Parses one output line, e.g. `dist/snake.svg?game=snake&theme=github-dark`.
 * Colours can be overridden per output: `&accent=#ff00aa&levels=#111,#222,#333,#444`.
 * A `#` inside the query is a colour, not a URL fragment, so this does not use URL.
 */
export function parseOutput(line: string): OutputSpec {
  const [path, query = ""] = line.trim().split("?", 2);
  if (!path) throw new Error(`Output line has no file path: "${line}"`);
  const params = new Map<string, string>();
  for (const part of query.split("&").filter(Boolean)) {
    const [k, v = ""] = part.split("=", 2);
    params.set(k.trim(), decodeURIComponent(v.trim()));
  }
  const overrides: Partial<Theme> = {};
  for (const key of COLOR_KEYS) {
    const v = params.get(key);
    if (v !== undefined) (overrides as Record<string, string | null>)[key] = v === "none" ? null : v;
  }
  const levels = params.get("levels");
  if (levels) {
    const list = levels.split(",").map((s) => s.trim());
    if (list.length !== 4) throw new Error(`levels needs exactly 4 colours, got ${list.length}`);
    overrides.levels = list as Theme["levels"];
  }
  return {
    path,
    game: params.get("game") ?? "snake",
    theme: params.get("theme") ?? "github-dark",
    overrides,
  };
}

export async function writeOutputs(grid: Grid, specs: OutputSpec[], seed: string, log = console.log): Promise<string[]> {
  const written: string[] = [];
  for (const spec of specs) {
    const id = resolveGameId(spec.game);
    const theme = resolveTheme(spec.theme, spec.overrides);
    const started = performance.now();
    const svg = renderGame(GAMES[id], grid, theme, seed);
    await mkdir(dirname(spec.path) || ".", { recursive: true });
    await writeFile(spec.path, svg, "utf8");
    const ms = Math.round(performance.now() - started);
    log(`${spec.path}: ${id}, ${theme.name}, ${(svg.length / 1024).toFixed(0)} KB in ${ms} ms`);
    written.push(spec.path);
  }
  return written;
}
