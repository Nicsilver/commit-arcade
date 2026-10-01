import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateTron, tron } from "../src/games/tron.ts";
import type { TronSim } from "../src/games/tron.ts";
import { PACE } from "../src/game.ts";
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
for (let x = 20; x < 53; x++) for (const cell of grids.left.cells[x]) if (cell) cell.level = 0;

function render(grid: Grid, theme = "github-dark") {
  return renderGame(tron, grid, resolveTheme(theme), "seed");
}

function play(grid: Grid, seed = "sim") {
  return simulateTron(grid, createRng(seed));
}

const playable = Object.entries(grids).filter(([, g]) => activeCells(g).length > 0);

/** A cell is entered only once every trail that crossed it has faded, and never by both cycles at once. */
function trailsNeverTouch(sim: TronSim): string | null {
  const stamps = new Map<number, { tick: number; cycle: number }[]>();
  sim.cycles.forEach((cycle, k) => {
    cycle.cells.forEach((cell, tick) => {
      const list = stamps.get(cell) ?? [];
      list.push({ tick, cycle: k });
      stamps.set(cell, list);
    });
  });
  for (const [cell, list] of stamps) {
    const sorted = [...list].sort((a, b) => a.tick - b.tick);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].tick - sorted[i - 1].tick <= sim.trail) return `cell ${cell} entered at tick ${sorted[i].tick} while the trail from tick ${sorted[i - 1].tick} was live`;
    }
  }
  return null;
}

test("the cycles derez every active day exactly once", () => {
  for (const [name, grid] of playable) {
    const sim = play(grid);
    const cleared = sim.derez.map((e) => e.cell);
    assert.equal(new Set(cleared).size, cleared.length, name);
    assert.equal(cleared.length, activeCells(grid).length, name);
    assert.ok(sim.derez.every((e) => e.t <= sim.harvestEnd + 1e-6), `${name}: a day outlived the harvest`);
  }
});

test("no cycle ever drives into a live trail", () => {
  const extra = Array.from({ length: 8 }, (_, i) => makeGrid(53, 0.15 + i * 0.1, `r${i}`));
  const all: [string, Grid][] = [...playable, ...extra.map((g, i): [string, Grid] => [`random ${i}`, g])];
  for (const [name, grid] of all) {
    if (activeCells(grid).length === 0) continue;
    for (const seed of ["one", "two"]) {
      const sim = play(grid, seed);
      assert.equal(sim.collisions, 0, `${name}/${seed}: a cycle was boxed in`);
      assert.equal(trailsNeverTouch(sim), null, `${name}/${seed}`);
    }
  }
});

test("cycles move one cell at a time and turn at right angles", () => {
  const sim = play(grids.sample);
  const rows = sim.arena.rows;
  for (const cycle of sim.cycles) {
    for (let i = 1; i < cycle.cells.length; i++) {
      const dx = Math.abs(Math.floor(cycle.cells[i] / rows) - Math.floor(cycle.cells[i - 1] / rows));
      const dy = Math.abs((cycle.cells[i] % rows) - (cycle.cells[i - 1] % rows));
      assert.equal(dx + dy, 1);
    }
  }
});

test("the cycles race and cut each other off", () => {
  for (const name of ["sample", "dense"]) {
    const sim = play(grids[name]);
    assert.ok(sim.nearMisses >= 1, `${name}: no near miss`);
    const turns = sim.cycles[0].cells.filter((c, i, cs) => i > 1 && (c % sim.arena.rows === cs[i - 1] % sim.arena.rows) !== (cs[i - 1] % sim.arena.rows === cs[i - 2] % sim.arena.rows)).length;
    assert.ok(turns > 20, `${name}: only ${turns} turns`);
  }
});

test("every trail is gone before the graph comes back", () => {
  for (const name of ["sample", "dense", "left"]) {
    const sim = play(grids[name]);
    const clear = sim.end + PACE.hold - 0.05;
    for (const cycle of sim.cycles) {
      cycle.tail.forEach((t, i) => assert.ok(t <= Math.max(clear, cycle.head[i] + 0.01), `${name}: cell ${i} still has a trail at ${clear}`));
    }
  }
});

test("the rival crashes after the last day and the lap follows", () => {
  for (const [name] of playable) {
    const sim = play(grids[name]);
    assert.ok(sim.crash.t > sim.harvestEnd, name);
    assert.ok(sim.end > sim.crash.t, name);
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
