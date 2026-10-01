import { parseArgs } from "node:util";
import { fetchGrid, sampleGrid } from "./grid.ts";
import { parseOutput, writeOutputs, type OutputSpec } from "./outputs.ts";
import { GAME_IDS } from "./render.ts";
import { THEMES } from "./theme.ts";

const HELP = `commit-arcade: classic arcade games played on a GitHub contribution graph

Usage:
  node dist/cli.js --user <login> [--game <id>] [--theme <name>] [--out <dir>]
  node dist/cli.js --user <login> --output "dist/snake.svg?game=snake&theme=github-dark"

Options:
  --user     GitHub login whose graph to play on
  --token    GitHub token (defaults to $GITHUB_TOKEN)
  --sample   Use a generated sample graph instead of fetching one
  --game     ${[...GAME_IDS, "daily", "all"].join(" | ")} (default: all)
  --theme    ${Object.keys(THEMES).join(" | ")} (default: github-dark)
  --out      Directory for --game/--theme mode (default: dist)
  --output   Explicit output line, repeatable; overrides --game/--theme/--out
`;

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      token: { type: "string" },
      sample: { type: "boolean", default: false },
      game: { type: "string", default: "all" },
      theme: { type: "string", default: "github-dark" },
      out: { type: "string", default: "dist" },
      output: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  let specs: OutputSpec[];
  if (values.output?.length) {
    specs = values.output.map(parseOutput);
  } else {
    const games = values.game === "all" ? GAME_IDS : [values.game];
    specs = games.map((game) => ({
      path: `${values.out}/${game}${values.theme === "github-dark" ? "" : "-" + values.theme}.svg`,
      game,
      theme: values.theme,
      overrides: {},
    }));
  }

  let grid;
  if (values.sample) {
    grid = sampleGrid();
  } else {
    if (!values.user) throw new Error("Pass --user <login>, or --sample for a demo graph");
    const token = values.token ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("A GitHub token is needed to read the graph: pass --token or set GITHUB_TOKEN");
    grid = await fetchGrid(values.user, token);
  }
  await writeOutputs(grid, specs, values.user ?? "sample");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
