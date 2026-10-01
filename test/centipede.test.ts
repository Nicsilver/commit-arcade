import assert from "node:assert/strict";
import { test } from "node:test";
import { centipede, simulateCentipede } from "../src/games/centipede.ts";
import { activeCells, sampleGrid } from "../src/grid.ts";
import type { Grid, Level } from "../src/grid.ts";
import { arcadeLayout } from "../src/kit.ts";
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
  return renderGame(centipede, grid, resolveTheme(theme), "seed");
}

function play(grid: Grid) {
  return simulateCentipede(grid, arcadeLayout(grid), createRng("sim"));
}

test("the blaster destroys every mushroom and segment", () => {
  for (const [name, grid] of Object.entries(grids)) {
    if (activeCells(grid).length === 0) continue;
    const sim = play(grid);
    const cleared = sim.clears.map((c) => c.cell);
    assert.equal(new Set(cleared).size, cleared.length, name);
    assert.equal(cleared.length, activeCells(grid).length, name);
    assert.ok(sim.mushrooms.every((m) => m.died !== null && m.hits === m.maxHits), `${name}: a mushroom survived`);
    assert.ok(sim.segments.every((s) => s.died !== null), `${name}: a segment survived`);
    assert.ok(sim.end > 0, name);
  }
});

test("mushrooms take one to three hits by level", () => {
  const sim = play(grids.dense);
  for (const m of sim.mushrooms.filter((m) => m.day)) {
    assert.equal(m.maxHits, Math.min(m.level, 3));
  }
});

test("segments stay on the board", () => {
  const grid = grids.sample;
  const layout = arcadeLayout(grid);
  const sim = play(grid);
  for (const s of sim.segments) {
    for (const [, x, y] of s.way) {
      assert.ok(y >= layout.top - 16 && y <= layout.top + 9 * layout.pitch, `segment left the field at y=${y}`);
      assert.ok(Number.isFinite(x));
    }
  }
});

test("centipede renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("centipede play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("centipede uses the standard canvas and HUD", () => {
  const svg = render(grids.sample);
  assert.match(svg, /viewBox="0 0 896 216"/);
  assert.ok(svg.includes('class="hud"'));
});

test("centipede renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
