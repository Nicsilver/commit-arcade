import assert from "node:assert/strict";
import { test } from "node:test";
import { asteroids, playAsteroids } from "../src/games/asteroids.ts";
import { activeCells, sampleGrid, type Grid } from "../src/grid.ts";
import { renderGame } from "../src/render.ts";
import { createRng } from "../src/rng.ts";
import { THEMES } from "../src/theme.ts";

function withLevels(grid: Grid, keep: (x: number, y: number) => boolean, level: 0 | 4): Grid {
  return {
    ...grid,
    cells: grid.cells.map((col, x) => col.map((c, y) => (c && keep(x, y) ? { ...c, level } : c && { ...c, level: 0 }))),
  };
}

const sample = sampleGrid();
const empty = withLevels(sample, () => false, 0);
const dense = withLevels(sample, () => true, 4);
const sparse = withLevels(sample, (x, y) => (x * 7 + y) % 61 === 3, 4);

const play = (grid: Grid, theme = "github-dark") =>
  playAsteroids({ grid, theme: THEMES[theme], rng: createRng("test:asteroids") });

test("renders on sample, empty, dense and sparse grids", () => {
  for (const grid of [sample, empty, dense, sparse]) {
    const svg = renderGame(asteroids, grid, THEMES["github-dark"], "test");
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("@keyframes"));
  }
});

test("output is deterministic", () => {
  const a = renderGame(asteroids, sample, THEMES.neon, "seed");
  const b = renderGame(asteroids, sample, THEMES.neon, "seed");
  assert.equal(a, b);
});

test("sizes stay within budget", () => {
  const sampleSvg = renderGame(asteroids, sample, THEMES["github-dark"], "test");
  assert.ok(sampleSvg.length < 700_000, `sample is ${sampleSvg.length} bytes`);
  const denseSvg = renderGame(asteroids, dense, THEMES["github-dark"], "test");
  assert.ok(denseSvg.length < 1_500_000, `dense is ${denseSvg.length} bytes`);
});

test("every active cell is shot exactly once during play", () => {
  for (const grid of [sample, dense, sparse]) {
    const p = play(grid);
    const shot = p.hits.map((h) => h.cell);
    assert.equal(new Set(shot).size, shot.length);
    assert.deepEqual(
      new Set(shot),
      new Set(activeCells(grid)),
    );
    assert.ok(p.hits.every((h) => h.t >= 0 && h.t <= p.play));
  }
});

test("play length is sensible", () => {
  assert.ok(play(sample).play >= 25 && play(sample).play <= 60);
  assert.ok(play(dense).play <= 90);
});

test("an empty graph idles without shooting", () => {
  const p = play(empty);
  assert.equal(p.hits.length, 0);
  assert.ok(p.play > 0);
});

test("the ship never stands on a live cell", () => {
  const p = play(sample);
  const { layout } = p;
  const cells = activeCells(sample);
  const dead = new Map(p.hits.map((h) => [h.cell, h.t]));
  for (const pose of p.poses) {
    for (const c of cells) {
      const x0 = layout.left + c.x * layout.pitch;
      const y0 = layout.top + c.y * layout.pitch;
      const inside = pose.x > x0 && pose.x < x0 + layout.cell && pose.y > y0 && pose.y < y0 + layout.cell;
      assert.ok(!inside || dead.get(c)! <= pose.t);
    }
  }
});
