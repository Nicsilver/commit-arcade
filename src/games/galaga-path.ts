/**
 * A flight path as keyframes: seconds from the start of the flight, position,
 * and the sprite's rotation in degrees (0 = nose down, as in formation).
 */
export interface Route {
  t: number[];
  x: number[];
  y: number[];
  r: number[];
  dur: number;
}

const DEG = Math.PI / 180;

/**
 * Builds a route by driving a turtle: straight runs, circular arcs and cubic
 * curves, each at its own speed. Rotation follows the heading, so a loop turns
 * the sprite through a full circle without any extra bookkeeping.
 */
export class Turtle {
  x: number;
  y: number;
  /** Heading in radians, unwrapped so loops keep counting instead of snapping back. */
  h: number;
  private time = 0;
  private readonly ts: number[] = [0];
  private readonly xs: number[];
  private readonly ys: number[];
  private readonly hs: number[];

  constructor(x: number, y: number, headingDeg: number) {
    this.x = x;
    this.y = y;
    this.h = headingDeg * DEG;
    this.xs = [x];
    this.ys = [y];
    this.hs = [this.h];
  }

  private push(dt: number) {
    this.time += dt;
    this.ts.push(this.time);
    this.xs.push(this.x);
    this.ys.push(this.y);
    this.hs.push(this.h);
  }

  line(length: number, speed: number): this {
    this.x += Math.cos(this.h) * length;
    this.y += Math.sin(this.h) * length;
    this.push(Math.abs(length) / speed);
    return this;
  }

  /** Positive degrees turn clockwise on screen. */
  arc(deg: number, radius: number, speed: number): this {
    const sign = Math.sign(deg) || 1;
    const steps = Math.max(1, Math.ceil(Math.abs(deg) / 22.5));
    const step = (deg * DEG) / steps;
    const cx = this.x + radius * Math.cos(this.h + (sign * Math.PI) / 2);
    const cy = this.y + radius * Math.sin(this.h + (sign * Math.PI) / 2);
    for (let i = 0; i < steps; i++) {
      this.h += step;
      this.x = cx + radius * Math.cos(this.h - (sign * Math.PI) / 2);
      this.y = cy + radius * Math.sin(this.h - (sign * Math.PI) / 2);
      this.push((radius * Math.abs(step)) / speed);
    }
    return this;
  }

  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number, speed: number): this {
    const x0 = this.x;
    const y0 = this.y;
    const approx = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(ex - c2x, ey - c2y);
    const steps = Math.max(4, Math.ceil(approx / 16));
    let px = x0;
    let py = y0;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const v = 1 - u;
      const x = v * v * v * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ex;
      const y = v * v * v * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ey;
      const dx = 3 * v * v * (c1x - x0) + 6 * v * u * (c2x - c1x) + 3 * u * u * (ex - c2x);
      const dy = 3 * v * v * (c1y - y0) + 6 * v * u * (c2y - c1y) + 3 * u * u * (ey - c2y);
      let h = Math.atan2(dy, dx);
      while (h - this.h > Math.PI) h -= 2 * Math.PI;
      while (h - this.h < -Math.PI) h += 2 * Math.PI;
      this.h = h;
      this.x = x;
      this.y = y;
      this.push(Math.hypot(x - px, y - py) / speed);
      px = x;
      py = y;
    }
    return this;
  }

  /** Finishes the route; `finalRotation` overrides the heading at the last vertex (the pivot into formation). */
  done(finalRotation?: number): Route {
    const r = this.hs.map((h) => (h * 180) / Math.PI - 90);
    if (finalRotation !== undefined) r[r.length - 1] = finalRotation;
    return { t: this.ts.slice(), x: this.xs.slice(), y: this.ys.slice(), r, dur: this.time };
  }
}

export interface RoutePoint {
  x: number;
  y: number;
  r: number;
}

export function routeAt(route: Route, t: number): RoutePoint {
  const n = route.t.length;
  if (t <= 0) return { x: route.x[0], y: route.y[0], r: route.r[0] };
  if (t >= route.dur) return { x: route.x[n - 1], y: route.y[n - 1], r: route.r[n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = route.t[hi] - route.t[lo] || 1;
  const u = (t - route.t[lo]) / span;
  return {
    x: route.x[lo] + (route.x[hi] - route.x[lo]) * u,
    y: route.y[lo] + (route.y[hi] - route.y[lo]) * u,
    r: route.r[lo] + (route.r[hi] - route.r[lo]) * u,
  };
}
