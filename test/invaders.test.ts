import assert from "node:assert/strict";
import { test } from "node:test";
import { renderGame } from "../src/render.ts";
import { activeCells, sampleGrid, type Grid, type Level } from "../src/grid.ts";
import { createRng } from "../src/rng.ts";
import { THEMES } from "../src/theme.ts";
import { invaders, offsetAt, simulateInvaders } from "../src/games/invaders.ts";

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

test("every active cell is shot down during play", () => {
  for (const grid of [sample, dense, sparse]) {
    const sim = simulateInvaders(grid, createRng("test"));
    assert.equal(new Set(sim.kills.map((k) => k.cell)).size, activeCells(grid).length);
    assert.ok(sim.kills.every((k) => k.t <= sim.length));
  }
});

test("each shot lands on the invader's position at the moment of the hit", () => {
  const sim = simulateInvaders(sample, createRng("test"));
  const { layout } = sim.field;
  for (const shot of sim.shots) {
    if (!shot.cell) continue;
    const centre = layout.left + shot.cell.x * layout.pitch + layout.cell / 2 + offsetAt(sim.march, shot.hit);
    assert.ok(Math.abs(shot.x - centre) < 0.01);
  }
});

test("the formation steps in small increments", () => {
  const { march } = simulateInvaders(sample, createRng("test"));
  assert.ok(march.times.length > 20);
  for (let i = 1; i < march.offsets.length; i++) assert.equal(Math.abs(march.offsets[i] - march.offsets[i - 1]), 2);
  assert.ok(march.offsets.every((o) => Math.abs(o) <= 8));
});

test("bombs miss the cannon, bunkers get chipped and the mystery ship is shot down", () => {
  const sim = simulateInvaders(sample, createRng("test"));
  const cannonAt = (t: number) => {
    const p = sim.cannonPath;
    let i = 0;
    while (i < p.length - 1 && p[i + 1].t <= t) i++;
    if (i >= p.length - 1) return p[p.length - 1].x;
    return p[i].x + ((p[i + 1].x - p[i].x) * (t - p[i].t)) / Math.max(p[i + 1].t - p[i].t, 1e-6);
  };
  assert.ok(sim.bombs.length > 5);
  for (const bomb of sim.bombs) {
    const arrives = bomb.t + (sim.field.cannonY - 7 - bomb.y0) / 170;
    assert.ok(Math.abs(cannonAt(arrives) - bomb.x) >= 19);
  }
  assert.ok(sim.ufos.some((u) => u.hit !== null));
  assert.ok(sim.chips.length > 0);
});

test("play length stays within the pacing budget", () => {
  const sample_ = simulateInvaders(sample, createRng("test")).length;
  assert.ok(sample_ >= 25 && sample_ <= 60, `sample play is ${sample_}s`);
  assert.ok(simulateInvaders(dense, createRng("test")).length < 90);
});

test("renders every grid shape within the size budget", () => {
  for (const theme of Object.values(THEMES)) {
    const svg = renderGame(invaders, sample, theme, "seed");
    assert.ok(svg.length < 700_000, `sample ${theme.name} is ${svg.length} bytes`);
  }
  const dark = THEMES["github-dark"];
  assert.ok(renderGame(invaders, dense, dark, "seed").length < 1_500_000);
  assert.ok(renderGame(invaders, sparse, dark, "seed").includes("@keyframes"));
  assert.ok(renderGame(invaders, empty, dark, "seed").includes("@keyframes"));
});

test("rendering is deterministic", () => {
  const dark = THEMES["github-dark"];
  assert.equal(renderGame(invaders, sample, dark, "seed"), renderGame(invaders, sample, dark, "seed"));
});

test("the last invaders fall quickly", () => {
  const sim = simulateInvaders(sample, createRng("test"));
  const times = sim.kills.map((k) => k.t);
  const tail = times[times.length - 1] - times[Math.floor(times.length * 0.9)];
  assert.ok(tail < 3.5, `last 10% took ${tail}s`);
});

test("every day keeps its empty tile and the hardware follows the theme", () => {
  const neon = renderGame(invaders, sample, THEMES.neon, "seed");
  const tiles = neon.split(`fill="${THEMES.neon.empty}"`).length - 1;
  assert.ok(tiles >= sample.cells.flat().filter(Boolean).length);
  assert.ok(!neon.includes("#20ff20"));
  assert.ok(renderGame(invaders, sample, THEMES["github-dark"], "seed").includes("#20ff20"));
});
