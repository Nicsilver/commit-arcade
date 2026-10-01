import { fmt } from "./anim.ts";

export interface Spark {
  /** Where the piece ends up, relative to the burst centre. */
  dx: number;
  dy: number;
  size: number;
  /** Fixed colour; pieces without one take the burst's colour. */
  fill?: string;
  round?: boolean;
}

export interface BurstShape {
  /** Seconds the pieces take to fly out and fade. */
  life: number;
  sparks: Spark[];
  /** Radius an expanding ring reaches; 0 or missing for no ring. */
  ring?: number;
  ringWidth?: number;
  /** Radius of a quick bright flash at the centre. */
  flash?: number;
  flashColor?: string;
}

/**
 * One-shot particle bursts that cost a single short element per event.
 *
 * A burst is drawn once at its final spread and played by scaling the whole
 * group outward while it fades, so placing one only takes a class and the
 * delay that lines it up with its moment in the loop.
 */
export class Bursts {
  private readonly duration: number;
  private readonly prefix: string;
  private readonly rules: string[] = [];
  private readonly shapes: string[] = [];

  constructor(duration: number, prefix = "fx") {
    this.duration = duration;
    this.prefix = prefix;
  }

  define(id: string, shape: BurstShape): void {
    const d = this.duration;
    const pct = (s: number) => Math.round((Math.min(s, d) / d) * 1e6) / 1e4;
    const name = `${this.prefix}-${id}`;
    const rest = "opacity:0;transform:scale(1.12)";
    this.rules.push(
      `@keyframes ${name}{0%{opacity:1;transform:scale(.25);animation-timing-function:cubic-bezier(.1,.8,.3,1)}` +
        `${pct(shape.life * 0.55)}%{opacity:1;transform:scale(.9);animation-timing-function:ease-in}${pct(shape.life)}%{${rest}}100%{${rest}}}` +
        `.${name}{animation:${name} ${fmt(d)}s linear infinite}`,
    );
    const parts: string[] = [];
    if (shape.flash) parts.push(`<circle r="${fmt(shape.flash)}" fill="${shape.flashColor ?? "#fff"}"/>`);
    if (shape.ring) {
      parts.push(`<circle r="${fmt(shape.ring)}" fill="none" stroke="currentColor" stroke-width="${shape.ringWidth ?? 1.6}"/>`);
    }
    for (const s of shape.sparks) {
      const fill = s.fill ?? "currentColor";
      parts.push(
        s.round
          ? `<circle cx="${fmt(s.dx)}" cy="${fmt(s.dy)}" r="${fmt(s.size / 2)}" fill="${fill}"/>`
          : `<rect x="${fmt(s.dx - s.size / 2)}" y="${fmt(s.dy - s.size / 2)}" width="${fmt(s.size)}" height="${fmt(s.size)}" fill="${fill}"/>`,
      );
    }
    this.shapes.push(`<g id="${name}">${parts.join("")}</g>`);
  }

  /** Places a burst centred on (x, y) that fires at loop time `t`. */
  use(id: string, x: number, y: number, t: number, color: string): string {
    const shift = ((t % this.duration) + this.duration) % this.duration;
    const delay = shift === 0 ? "0s" : `-${fmt(Math.round((this.duration - shift) * 1000) / 1000)}s`;
    const name = `${this.prefix}-${id}`;
    return `<use class="${name}" href="#${name}" x="${fmt(x)}" y="${fmt(y)}" style="animation-delay:${delay};transform-origin:${fmt(x)}px ${fmt(y)}px;color:${color}"/>`;
  }

  defs(): string {
    return this.shapes.join("");
  }

  css(): string {
    return this.rules.join("\n");
  }
}

/** Evenly spaced pieces flying outward, with a little size and reach variety. */
export function radialSparks(count: number, reach: number, size: number, turn = 0): Spark[] {
  return Array.from({ length: count }, (_, i) => {
    const a = turn + (i / count) * Math.PI * 2;
    const r = reach * (0.7 + 0.3 * ((i * 7) % 5) / 4);
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, size: size * (i % 2 ? 0.8 : 1.1) };
  });
}
