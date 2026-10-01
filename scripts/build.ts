import { build } from "esbuild";

// The action runs straight from the repo, so dist/ is committed and must be a
// single self-contained file per entry point.
for (const [entry, outfile] of [
  ["src/action.ts", "dist/index.js"],
  ["src/cli.ts", "dist/cli.js"],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    legalComments: "none",
  });
  console.log(`built ${outfile}`);
}
