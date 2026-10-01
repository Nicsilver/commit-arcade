import assert from "node:assert/strict";
import { test } from "node:test";
import { galaga } from "../src/games/galaga.ts";
import { simulateGalaga, type GalagaSim } from "../src/games/galaga-sim.ts";
import { activeCells, sampleGrid } from "../src/grid.ts";
import type { Grid, Level } from "../src/grid.ts";
import { arcadeLayout } from "../src/kit.ts";
import { renderGame } from "../src/render.ts";
import { createRng } from "../src/rng.ts";
import { cellCenter } from "../src/svg.ts";
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
  return renderGame(galaga, grid, resolveTheme(theme), "seed");
}

function simulate(grid: Grid): GalagaSim {
  const layout = arcadeLayout(grid);
  return simulateGalaga(grid, createRng("seed"), {
    width: layout.width,
    centerX: layout.width / 2,
    centerY: layout.top + layout.gridHeight / 2,
    slot: (c) => cellCenter(layout, c.x, c.y),
  });
}

test("galaga clears every active day exactly once", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulate(grid);
    const dead = sim.enemies.filter((e) => e.death !== null);
    assert.equal(dead.length, activeCells(grid).length, name);
    assert.equal(new Set(dead.map((e) => e.cell)).size, dead.length, name);
  }
});

test("galaga keeps divers away from the fighter", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulate(grid);
    assert.ok(sim.minClearance >= 16, `${name}: closest approach ${sim.minClearance}`);
  }
});

test("galaga stages the capture and the rescue on a graph with bosses", () => {
  const sim = simulate(grids.sample);
  assert.ok(sim.capture, "capture");
  assert.ok(sim.rescue, "rescue");
  assert.ok(sim.capture.beamOn < sim.capture.abductEnd);
  assert.ok(sim.rescue.t > sim.capture.returnEnd);
});

test("galaga renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("galaga play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/\.k\d+\{animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("galaga renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
