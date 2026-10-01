import { fetchGrid } from "./grid.ts";
import { parseOutput, writeOutputs } from "./outputs.ts";

// The runner passes inputs as INPUT_<NAME> environment variables. Reading
// them directly keeps the action free of runtime dependencies.
function input(name: string): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

async function run() {
  const user = input("github_user_name");
  const token = input("github_token");
  const lines = input("outputs")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (!user) throw new Error("github_user_name is empty");
  if (!token) throw new Error("github_token is empty");
  if (lines.length === 0) throw new Error("outputs is empty: list at least one file to write");

  const grid = await fetchGrid(user, token);
  await writeOutputs(grid, lines.map(parseOutput), user);
}

run().catch((err) => {
  // ::error:: makes the message show up as an annotation on the workflow run.
  console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
