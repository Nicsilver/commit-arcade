import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateTron, tron } from "../src/games/tron.ts";
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
  left: makeGrid(53, 0.3, "e"),
};
// Everything on one side leaves the other cycle with nothing to harvest.
for (let x = 20; x < 53; x++) for (const cell of grids.left.cells[x]) if (cell) cell.level = 0;

function render(grid: Grid, theme = "github-dark") {
  return renderGame(tron, grid, resolveTheme(theme), "seed");
}

test("the cycles derez every active day exactly once", () => {
  for (const [name, grid] of Object.entries(grids)) {
    if (activeCells(grid).length === 0) continue;
    const sim = simulateTron(grid);
    const cleared = sim.derez.map((e) => e.cell);
    assert.equal(new Set(cleared).size, cleared.length, name);
    assert.equal(cleared.length, activeCells(grid).length, name);
    assert.ok(sim.derez.every((e) => e.t <= sim.harvestEnd + 1e-6), `${name}: a day outlived the harvest`);
  }
});

test("no cell is ever driven over twice", () => {
  for (const [name, grid] of Object.entries(grids)) {
    if (activeCells(grid).length === 0) continue;
    const sim = simulateTron(grid);
    const all = sim.cycles.flatMap((c) => c.cells);
    assert.equal(new Set(all).size, all.length, name);
  }
});

test("cycles only turn at right angles", () => {
  const sim = simulateTron(grids.sample);
  const rows = sim.arena.rows;
  for (const cycle of sim.cycles) {
    for (let i = 1; i < cycle.cells.length; i++) {
      const dx = Math.abs(Math.floor(cycle.cells[i] / rows) - Math.floor(cycle.cells[i - 1] / rows));
      const dy = Math.abs((cycle.cells[i] % rows) - (cycle.cells[i - 1] % rows));
      assert.equal(dx + dy, 1);
    }
  }
});

test("the rival crashes after the last day and the lap follows", () => {
  for (const name of ["sample", "dense", "left"]) {
    const sim = simulateTron(grids[name]);
    assert.ok(sim.crash.t > sim.harvestEnd, name);
    assert.ok(sim.end > sim.crash.t, name);
    const player = sim.cycles[0];
    assert.ok(player.head[player.head.length - 1] > sim.end, `${name}: the player stops before the stage ends`);
  }
});

test("tron renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("tron play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("tron uses the standard canvas and HUD", () => {
  const svg = render(grids.sample);
  assert.match(svg, /viewBox="0 0 896 216"/);
  assert.ok(svg.includes('class="hud"'));
});

test("tron renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
