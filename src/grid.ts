import { createRng } from "./rng.ts";

export type Level = 0 | 1 | 2 | 3 | 4;

export interface Cell {
  /** Week column, 0 = oldest. */
  x: number;
  /** Weekday row, 0 = Sunday. */
  y: number;
  level: Level;
  count: number;
  date: string;
}

/**
 * The contribution calendar as a dense width x 7 grid. The first and last
 * weeks are usually partial; missing days are null and should not be drawn.
 */
export interface Grid {
  width: number;
  height: number;
  cells: (Cell | null)[][];
}

export function cellAt(grid: Grid, x: number, y: number): Cell | null {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  return grid.cells[x][y];
}

export function allCells(grid: Grid): Cell[] {
  return grid.cells.flat().filter((c): c is Cell => c !== null);
}

/** Cells with at least one contribution: the things games eat, break or shoot. */
export function activeCells(grid: Grid): Cell[] {
  return allCells(grid).filter((c) => c.level > 0);
}

const LEVELS: Record<string, Level> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

interface CalendarResponse {
  data?: {
    user: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: {
            contributionDays: {
              contributionCount: number;
              contributionLevel: string;
              date: string;
              weekday: number;
            }[];
          }[];
        };
      };
    } | null;
  };
  errors?: { message: string }[];
}

export async function fetchGrid(login: string, token: string): Promise<Grid> {
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { contributionCount contributionLevel date weekday } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "commit-arcade",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API answered ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as CalendarResponse;
  if (json.errors?.length) {
    throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const user = json.data?.user;
  if (!user) throw new Error(`No GitHub user called "${login}"`);

  const weeks = user.contributionsCollection.contributionCalendar.weeks;
  const cells: (Cell | null)[][] = weeks.map((week, x) => {
    const column: (Cell | null)[] = Array(7).fill(null);
    for (const day of week.contributionDays) {
      column[day.weekday] = {
        x,
        y: day.weekday,
        level: LEVELS[day.contributionLevel] ?? 0,
        count: day.contributionCount,
        date: day.date,
      };
    }
    return column;
  });
  return { width: cells.length, height: 7, cells };
}

/**
 * A believable year of activity for demos and tests: quiet stretches,
 * busy weeks, lighter weekends.
 */
export function sampleGrid(seed = "commit-arcade", width = 53): Grid {
  const rng = createRng(seed);
  const start = new Date(Date.UTC(2025, 9, 5));
  const lastDay = 3;
  let mood = 0.4;
  const cells: (Cell | null)[][] = [];
  for (let x = 0; x < width; x++) {
    mood = Math.min(1, Math.max(0, mood + (rng() - 0.5) * 0.5));
    const column: (Cell | null)[] = [];
    for (let y = 0; y < 7; y++) {
      if (x === width - 1 && y > lastDay) {
        column.push(null);
        continue;
      }
      const weekend = y === 0 || y === 6;
      const chance = mood * (weekend ? 0.45 : 0.85);
      let count = 0;
      if (rng() < chance) count = 1 + Math.floor(rng() ** 2 * 14);
      const level: Level = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4;
      const date = new Date(start.getTime() + (x * 7 + y) * 86_400_000).toISOString().slice(0, 10);
      column.push({ x, y, level, count, date });
    }
    cells.push(column);
  }
  return { width, height: 7, cells };
}
