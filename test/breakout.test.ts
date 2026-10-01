import assert from "node:assert/strict";
import { test } from "node:test";
import { renderGame } from "../src/render.ts";
import { activeCells, sampleGrid, type Grid, type Level } from "../src/grid.ts";
import { createRng } from "../src/rng.ts";
import { makeLayout } from "../src/svg.ts";
import { THEMES } from "../src/theme.ts";
import { breakout, pacePlay, simulateBreakout } from "../src/games/breakout.ts";

function withLevels(grid: Grid, pick: (x: number, y: number, level: Level) => Level): Grid {
  return {
    ...grid,
    cells: grid.cells.map((col, x) => col.map((c, y) => (c ? { ...c, level: pick(x, y, c.level) } : c))),
  };
}

const sample = sampleGrid();
const empty = withLevels(sample, () => 0);
const dense = withLevels(sample, () => 4);
const sparse = withLevels(sample, (x, y) => (y === 3 && [4, 20, 33, 47].includes(x) ? 3 : 0));

function play(grid: Grid) {
  return simulateBreakout(grid, makeLayout(grid, { left: 14, top: 14 }), createRng("test"));
}

test("every active cell is cleared during play", () => {
  for (const grid of [sample, dense, sparse]) {
    const sim = play(grid);
    const removed = new Set(sim.hits.filter((h) => h.final).map((h) => h.cell));
    assert.equal(removed.size, activeCells(grid).length);
    assert.ok(sim.length > 0);
  }
});

test("two-hit bricks take two hits unless the fireball smashes them", () => {
  const sim = play(withLevels(sample, (x, y, l) => (l > 0 ? 4 : l)));
  const first = new Map<unknown, number>();
  for (const h of sim.hits) first.set(h.cell, (first.get(h.cell) ?? 0) + (h.final ? 0 : 1));
  assert.ok([...first.values()].some((n) => n === 1));
});

test("the ball never travels close to horizontal after the serve", () => {
  const sim = play(sample);
  for (let i = 1; i < sim.ball.length; i++) {
    const [t0, x0, y0] = sim.ball[i - 1];
    const [t1, x1, y1] = sim.ball[i];
    if (t1 - t0 < 0.05) continue;
    const slope = Math.abs(y1 - y0) / Math.max(Math.abs(x1 - x0), 1e-6);
    assert.ok(slope > 0.4, `segment ${i} too flat: ${slope}`);
  }
});

test("play length stays within the pacing budget", () => {
  assert.ok(pacePlay(play(sample)).length >= 25 && pacePlay(play(sample)).length <= 60);
  assert.ok(pacePlay(play(dense)).length < 90);
});

test("renders every grid shape within the size budget", () => {
  for (const theme of Object.values(THEMES)) {
    const svg = renderGame(breakout, sample, theme, "seed");
    assert.ok(svg.length < 700_000, `sample ${theme.name} is ${svg.length} bytes`);
    assert.ok(svg.startsWith("<svg"));
  }
  const dark = THEMES["github-dark"];
  assert.ok(renderGame(breakout, dense, dark, "seed").length < 1_500_000);
  assert.ok(renderGame(breakout, sparse, dark, "seed").includes("@keyframes"));
  assert.ok(renderGame(breakout, empty, dark, "seed").includes("@keyframes"));
});

test("rendering is deterministic", () => {
  const dark = THEMES["github-dark"];
  assert.equal(renderGame(breakout, sample, dark, "seed"), renderGame(breakout, sample, dark, "seed"));
});
