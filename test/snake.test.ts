import assert from "node:assert/strict";
import { test } from "node:test";
import { snake, simulateSnake } from "../src/games/snake.ts";
import { activeCells, sampleGrid } from "../src/grid.ts";
import type { Grid, Level } from "../src/grid.ts";
import { renderGame } from "../src/render.ts";
import { createRng } from "../src/rng.ts";
import { resolveTheme } from "../src/theme.ts";

function makeGrid(width: number, density: number, seed: string): Grid {
  const rng = createRng(seed);
  const cells: Grid["cells"] = [];
  for (let x = 0; x < width; x++) {
    const column: Grid["cells"][number] = [];
    for (let y = 0; y < 7; y++) {
      if (x === width - 1 && y > 3) {
        column.push(null);
        continue;
      }
      const level = (rng() < density ? 1 + Math.floor(rng() * 4) : 0) as Level;
      column.push({ x, y, level, count: level, date: "2025-01-01" });
    }
    cells.push(column);
  }
  return { width, height: 7, cells };
}

const grids: Record<string, Grid> = {
  sample: sampleGrid(),
  empty: makeGrid(53, 0, "a"),
  dense: makeGrid(53, 1, "b"),
  sparse: makeGrid(53, 0.02, "c"),
  narrow: makeGrid(4, 0.8, "d"),
};

function render(grid: Grid, theme = "github-dark") {
  return renderGame(snake, grid, resolveTheme(theme), "seed");
}

test("snake eats every active cell exactly once", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulateSnake(grid, () => 40);
    const eaten = sim.eats.map((e) => e.cell);
    assert.equal(new Set(eaten).size, eaten.length, name);
    assert.equal(eaten.length, activeCells(grid).length, name);
  }
});

test("snake never runs into itself or leaves the lane", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulateSnake(grid, () => 40);
    const grew = new Set(sim.eats.filter((e) => e.grew).map((e) => e.step));
    let body = [sim.path[0]];
    for (let step = 1; step < sim.path.length; step++) {
      const head = sim.path[step];
      const prev = sim.path[step - 1];
      const dx = Math.abs((head % sim.cols) - (prev % sim.cols));
      const dy = Math.abs(Math.floor(head / sim.cols) - Math.floor(prev / sim.cols));
      assert.equal(dx + dy, 1, `${name}: step ${step} is not a single move`);
      if (!grew.has(step)) body.pop();
      assert.ok(!body.includes(head), `${name}: head hit its body at step ${step}`);
      body = [head, ...body];
    }
  }
});

test("snake length is capped on a dense graph", () => {
  const sim = simulateSnake(grids.dense);
  const growth = sim.eats.filter((e) => e.grew).length;
  assert.ok(sim.maxLength <= 64);
  assert.ok(growth + 1 <= sim.maxLength);
  assert.ok(growth < sim.eats.length);
});

test("snake renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("snake play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("snake uses the standard canvas and HUD", () => {
  const svg = render(grids.sample);
  assert.match(svg, /viewBox="0 0 896 216"/);
  assert.ok(svg.includes('class="hud"'));
});

test("snake renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
