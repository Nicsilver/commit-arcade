import assert from "node:assert/strict";
import { test } from "node:test";
import { bomberman } from "../src/games/bomberman.ts";
import { FLAME, FUSE, simulateBomberman } from "../src/games/bomberman-sim.ts";
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
  return renderGame(bomberman, grid, resolveTheme(theme), "seed");
}

test("bomberman breaks every active block exactly once", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulateBomberman(grid, createRng("seed"));
    const broken = sim.breaks.map((b) => b.cell);
    assert.equal(new Set(broken).size, broken.length, name);
    assert.equal(broken.length, activeCells(grid).length, name);
  }
});

test("bomberman never stands in flames and only steps to neighbouring cells", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulateBomberman(grid, createRng("seed"));
    const { cols } = sim;
    const inFlames = (idx: number, tick: number) =>
      sim.blasts.some((b) => {
        if (tick < b.tick || tick >= b.tick + FLAME) return false;
        const dx = Math.abs((idx % cols) - (b.idx % cols));
        const dy = Math.abs(Math.floor(idx / cols) - Math.floor(b.idx / cols));
        return (dy === 0 && dx <= b.range) || (dx === 0 && dy <= b.range);
      });
    for (let t = 0; t < sim.path.length; t++) {
      assert.ok(!inFlames(sim.path[t], t), `${name}: in flames at tick ${t}`);
      if (t > 0) {
        const step = Math.abs((sim.path[t] % cols) - (sim.path[t - 1] % cols)) + Math.abs(Math.floor(sim.path[t] / cols) - Math.floor(sim.path[t - 1] / cols));
        assert.ok(step <= 1, `${name}: jump at tick ${t}`);
      }
    }
    for (const p of sim.plants) assert.ok(p.explode - p.tick <= FUSE, name);
  }
});

test("bomberman renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("bomberman play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("bomberman renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
