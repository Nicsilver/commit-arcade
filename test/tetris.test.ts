import assert from "node:assert/strict";
import { test } from "node:test";
import { playTetris, solveBoard, tetris } from "../src/games/tetris.ts";
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

const play = (grid: Grid, theme = "github-dark") => playTetris({ grid, theme: THEMES[theme], rng: createRng("test:tetris") });

test("renders on sample, empty, dense and sparse grids", () => {
  for (const grid of [sample, empty, dense, sparse]) {
    const svg = renderGame(tetris, grid, THEMES["github-dark"], "test");
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("@keyframes"));
  }
});

test("output is deterministic", () => {
  const a = renderGame(tetris, sample, THEMES.neon, "seed");
  const b = renderGame(tetris, sample, THEMES.neon, "seed");
  assert.equal(a, b);
});

test("sizes stay within budget", () => {
  const sampleSvg = renderGame(tetris, sample, THEMES["github-dark"], "test");
  assert.ok(sampleSvg.length < 700_000, `sample is ${sampleSvg.length} bytes`);
  const denseSvg = renderGame(tetris, dense, THEMES["github-dark"], "test");
  assert.ok(denseSvg.length < 1_500_000, `dense is ${denseSvg.length} bytes`);
});

test("every active day is cleared exactly once, and the score ends on the total", () => {
  for (const grid of [sample, dense, sparse]) {
    const p = play(grid);
    const cleared = p.clears.map((e) => e.cell);
    assert.equal(new Set(cleared).size, cleared.length);
    assert.deepEqual(new Set(cleared), new Set(activeCells(grid)));
    assert.ok(p.clears.every((e) => e.t >= 0 && e.t <= p.play));
  }
});

test("every block that lands is swept away, and the rows add up", () => {
  for (const grid of [sample, dense, sparse]) {
    const p = play(grid);
    let swept = 0;
    let rows = 0;
    let landed = p.days.length;
    for (const op of p.ops) {
      if (op.type === "clear") {
        swept += op.cleared.length;
        rows += op.rows;
      } else {
        landed += op.blocks.length;
      }
    }
    assert.equal(swept, landed);
    assert.equal(rows, p.rows);
    assert.equal(p.lines.at(-1)?.total ?? 0, p.rows);
  }
});

test("play length is sensible", () => {
  const p = play(sample);
  assert.ok(p.play >= 25 && p.play <= 60, `sample plays ${p.play}`);
  assert.ok(play(dense).play <= 90);
});

test("an empty graph idles without pieces", () => {
  const p = play(empty);
  assert.equal(p.pieces, 0);
  assert.equal(p.clears.length, 0);
  assert.ok(p.play > 0);
});

test("a busy sample finishes on a four-row clear", () => {
  const p = play(sample);
  assert.ok(p.tetrises.length > 0);
});

/** Replays a solution on the stack and returns what is wrong with it, if anything. */
function replay(heights: number[], placements: ReturnType<typeof solveBoard>["placements"], rows: number): string | null {
  const h = heights.slice();
  for (const p of placements) {
    const floor = Math.min(...h);
    const byColumn = new Map<number, number[]>();
    for (const [c, r] of p.cells) byColumn.set(c, [...(byColumn.get(c) ?? []), r].sort((a, b) => a - b));
    for (const [c, rs] of byColumn) {
      if (rs[0] !== h[c] + 1) return `column ${c} does not rest on its stack`;
      if (rs.some((r, i) => i > 0 && r !== rs[i - 1] + 1)) return "piece has a hole in a column";
    }
    if (Math.max(...p.cells.map((c) => c[1])) - floor > 7) return "piece lands above the board";
    if (p.kind !== "x" && p.cells.length !== 4) return "tetromino with the wrong size";
    for (const [c, rs] of byColumn) h[c] = rs[rs.length - 1];
  }
  return h.every((v) => v === rows) ? null : `board ends at ${h.join(",")}, expected ${rows}`;
}

test("the solver empties boards of every shape with legal drops", () => {
  const boards: number[][] = [];
  for (const [seed, width] of [["a", 52], ["b", 53], ["c", 54], ["d", 31], ["e", 12]] as const) {
    boards.push(sampleGrid(seed, width).cells.map((col) => col.filter((c) => c && c.level > 0).length));
  }
  boards.push(Array(53).fill(7), Array(52).fill(7), Array(53).fill(0), Array(10).fill(1), [0, 0, 0, 5, 0, 0, 0]);
  boards.push(Array.from({ length: 53 }, (_, i) => (i % 9 === 3 ? 1 : 0)), Array.from({ length: 40 }, (_, i) => (i * 3) % 8 % 8));
  for (const heights of boards) {
    const solution = solveBoard(heights, createRng(heights.join(",")));
    assert.equal(replay(heights, solution.placements, solution.rows), null);
    assert.ok(solution.filler <= 11);
  }
});

test("gaps a tetromino fits are filled with tetrominoes only", () => {
  const heights = sampleGrid("odd", 53).cells.map((col) => col.filter((c) => c && c.level > 0).length);
  const solution = solveBoard(heights, createRng("odd"));
  assert.equal(solution.filler, 0);
  assert.ok(solution.placements.every((p) => p.kind !== "x" && p.cells.length === 4));
});
