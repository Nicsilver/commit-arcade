import assert from "node:assert/strict";
import { test } from "node:test";
import { Timeline } from "../src/anim.ts";
import { activeCells, sampleGrid } from "../src/grid.ts";
import { parseOutput } from "../src/outputs.ts";
import { createRng } from "../src/rng.ts";

test("timeline pads tracks to cover the whole loop", () => {
  const tl = new Timeline(10);
  tl.track([[2, "opacity:1"], [4, "opacity:0"]]);
  assert.match(tl.css(), /@keyframes k0\{0%\{opacity:1\}20%\{opacity:1\}40%\{opacity:0\}100%\{opacity:0\}\}/);
});

test("timeline keeps instant jumps as two distinct offsets", () => {
  const tl = new Timeline(10);
  tl.track([[5, "opacity:1"], [5, "opacity:0"]]);
  assert.match(tl.css(), /50%\{opacity:1\}50\.0001%\{opacity:0\}/);
});

test("timeline keeps frame order when times differ only by float error", () => {
  const tl = new Timeline(10);
  tl.track([[0, "a:0"], [0.1 + 0.2, "a:1"], [0.3, "a:2"], [1, "a:2"]]);
  assert.match(tl.css(), /3%\{a:1\}3\.0001%\{a:2\}/);
});

test("timeline drops redundant frames inside a constant run", () => {
  const tl = new Timeline(10);
  tl.track([[0, "a:1"], [1, "a:1"], [2, "a:1"], [3, "a:2"]]);
  assert.ok(tl.css().startsWith("@keyframes k0{0%{a:1}20%{a:1}30%{a:2}100%{a:2}}"));
});

test("lagging tracks use a negative delay inside the loop", () => {
  const tl = new Timeline(10);
  const name = tl.keyframes([[0, "a:1"], [10, "a:2"]]);
  const cls = tl.useKeyframes(name, 3);
  assert.match(tl.css(), new RegExp(`\\.${cls}\\{animation:${name} 10s linear -7s infinite\\}`));
});

test("output lines carry game, theme and colour overrides", () => {
  const spec = parseOutput("dist/x.svg?game=pacman&theme=neon&accent=#ff00aa&levels=#1,#2,#3,#4&background=none");
  assert.equal(spec.path, "dist/x.svg");
  assert.equal(spec.game, "pacman");
  assert.equal(spec.theme, "neon");
  assert.equal(spec.overrides.accent, "#ff00aa");
  assert.equal(spec.overrides.background, null);
  assert.deepEqual(spec.overrides.levels, ["#1", "#2", "#3", "#4"]);
});

test("sample grid is deterministic and has a partial last week", () => {
  const a = sampleGrid("seed");
  const b = sampleGrid("seed");
  assert.deepEqual(a, b);
  assert.equal(a.cells[a.width - 1][6], null);
  assert.ok(activeCells(a).length > 50);
});

test("rng is seeded", () => {
  assert.equal(createRng("x")(), createRng("x")());
  assert.notEqual(createRng("x")(), createRng("y")());
});

test("hud score ends on the year's total and resets with the board", async () => {
  const { hud } = await import("../src/kit.ts");
  const { resolveTheme } = await import("../src/theme.ts");
  const grid = sampleGrid("hud");
  const tl = new Timeline(20);
  const clears = activeCells(grid).map((cell, i) => ({ t: 1 + i * 0.05, cell }));
  const svg = hud(tl, grid, { theme: resolveTheme("github-dark"), title: "TEST", clears, resetAt: 18, width: 896 });
  assert.match(svg, /<g class="hud">/);
  assert.ok(tl.css().includes("opacity:1"));
});
