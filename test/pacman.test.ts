import assert from "node:assert/strict";
import { test } from "node:test";
import { ghostModeAt, pacman, positionAt, simulatePacman } from "../src/games/pacman.ts";
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
  narrow: makeGrid(5, 0.8, "d"),
};

function render(grid: Grid, theme = "github-dark") {
  return renderGame(pacman, grid, resolveTheme(theme), "seed");
}

test("Pac-Man eats every active cell exactly once", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const sim = simulatePacman(grid, createRng("t"));
    const eaten = sim.eats.map((e) => e.cell);
    assert.equal(new Set(eaten).size, eaten.length, name);
    assert.equal(eaten.length, activeCells(grid).length, name);
  }
});

test("power pellets sit in the corners of the active area and are not saved for last", () => {
  const sim = simulatePacman(grids.sample, createRng("t"));
  const pellets = sim.eats.filter((e) => e.power);
  assert.equal(pellets.length, 4);
  const xs = activeCells(grids.sample).map((c) => c.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  assert.equal(pellets.filter((e) => e.cell.x < mid).length, 2);
  const lastDot = sim.eats[sim.eats.length - 1];
  assert.ok(!lastDot.power);
  assert.ok(pellets[2].t < sim.end * 0.9);
});

test("Pac-Man clears the last tenth of the dots quickly", () => {
  for (const name of ["sample", "dense"]) {
    const sim = simulatePacman(grids[name], createRng("t"));
    const tenth = sim.eats[Math.floor(sim.eats.length * 0.9)];
    assert.ok(sim.end - tenth.t < sim.end * 0.15, `${name}: ${sim.end - tenth.t} of ${sim.end}`);
  }
});

test("ghosts never touch Pac-Man while they are dangerous", () => {
  for (const name of ["sample", "dense", "sparse"]) {
    const sim = simulatePacman(grids[name], createRng("t"));
    for (let t = 0; t <= sim.end; t += 0.25) {
      const [px, py] = positionAt(sim.pac, t);
      for (const ghost of sim.ghosts) {
        if (ghostModeAt(ghost.spans, t) !== "normal") continue;
        const [gx, gy] = positionAt(ghost.waypoints, t);
        assert.ok(Math.hypot(px - gx, py - gy) >= 0.9, `${name}: ghost on Pac-Man at t=${t}`);
      }
    }
  }
});

test("Pac-Man catches frightened ghosts for the doubling bonus", () => {
  const sim = simulatePacman(grids.sample, createRng("t"));
  assert.ok(sim.ghostEats.length > 0);
  assert.ok(sim.ghostEats.every((e) => [200, 400, 800, 1600].includes(e.points)));
});

test("Pac-Man renders every grid within budget and deterministically", () => {
  for (const [name, grid] of Object.entries(grids)) {
    const svg = render(grid);
    assert.ok(svg.startsWith("<svg"), name);
    assert.ok(svg.length < (name === "dense" ? 1_500_000 : 700_000), `${name}: ${svg.length} bytes`);
    assert.equal(svg, render(grid), name);
  }
});

test("Pac-Man play length stays inside the pacing targets", () => {
  for (const name of ["sample", "dense"]) {
    const svg = render(grids[name]);
    const loop = Number(/animation:k\d+ ([\d.]+)s/.exec(svg)?.[1]);
    assert.ok(loop > 20 && loop < 95, `${name}: loop ${loop}s`);
  }
});

test("Pac-Man uses the standard canvas and HUD", () => {
  const svg = render(grids.sample);
  assert.match(svg, /viewBox="0 0 896 216"/);
  assert.ok(svg.includes('class="hud"'));
});

test("Pac-Man renders in every theme", () => {
  for (const theme of ["github-dark", "github-light", "neon"]) {
    assert.ok(render(grids.sample, theme).includes("<svg"));
  }
});
