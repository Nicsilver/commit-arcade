/** A keyframe: time in seconds from the start of the loop, and the CSS declarations at that moment. */
export type Frame = [t: number, css: string];

/**
 * Collects CSS keyframe animations that all share one looping duration.
 *
 * Everything in a game loops on the same clock, so each moving thing is
 * described as a list of (time, css) frames and becomes one @keyframes rule.
 * Between frames the browser interpolates linearly, which means a straight
 * run only needs its two ends.
 */
export class Timeline {
  readonly duration: number;
  private readonly rules: string[] = [];
  private count = 0;
  private readonly prefix: string;

  constructor(duration: number, prefix = "k") {
    if (!(duration > 0)) throw new Error("Timeline duration must be positive");
    this.duration = duration;
    this.prefix = prefix;
  }

  /**
   * Registers an animation and returns a class name to put on the element.
   * Two frames at the same time make an instant jump, e.g. teleporting or
   * switching sprites.
   */
  track(frames: Frame[], timing = "linear"): string {
    const name = this.keyframes(frames);
    return this.useKeyframes(name, 0, timing);
  }

  /** Registers bare @keyframes so several elements can share them with different delays. */
  keyframes(frames: Frame[]): string {
    const name = `${this.prefix}${this.count++}`;
    this.rules.push(`@keyframes ${name}{${this.body(frames)}}`);
    return name;
  }

  /**
   * Plays existing keyframes `lag` seconds behind the loop clock. Implemented
   * as a negative delay so the element is animated from the very first frame
   * instead of sitting still while it waits.
   */
  useKeyframes(name: string, lag: number, timing = "linear"): string {
    const cls = `${this.prefix}${this.count++}`;
    const shift = ((lag % this.duration) + this.duration) % this.duration;
    const delay = shift === 0 ? "" : ` -${fmt(this.duration - shift)}s`;
    this.rules.push(`.${cls}{animation:${name} ${fmt(this.duration)}s ${timing}${delay} infinite}`);
    return cls;
  }

  /** Visible only between `from` and `to` seconds (with an optional fade). */
  visible(from: number, to: number, fade = 0): string {
    return this.track(visibilityFrames(from, to, fade));
  }

  /** Visible at the start, gone from `at` until `back`, where it fades in again. */
  hiddenBetween(at: number, back: number, fade = 0): string {
    return this.track([
      [0, "opacity:1"],
      [at, "opacity:1"],
      [at + Math.max(fade, 0.001), "opacity:0"],
      [back, "opacity:0"],
      [back + Math.max(fade, 0.001), "opacity:1"],
    ]);
  }

  css(): string {
    return this.rules.join("\n");
  }

  private body(frames: Frame[]): string {
    if (frames.length === 0) throw new Error("A track needs at least one frame");
    // Times are rounded before sorting: two frames meant to share an instant
    // (one beat ending as the next begins) often differ by float error, and
    // sorting them on that error swaps them and turns a blink into a fade.
    const sorted = frames
      .map(([t, css], i) => ({ t: Math.round(Math.min(Math.max(t, 0), this.duration) * 1e5) / 1e5, css, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i);
    if (sorted[0].t > 0) sorted.unshift({ t: 0, css: sorted[0].css, i: -1 });
    const last = sorted[sorted.length - 1];
    if (last.t < this.duration) sorted.push({ t: this.duration, css: last.css, i: Infinity });

    // Drop frames that sit in the middle of a run of identical values; the
    // interpolation is the same without them and big tracks shrink a lot.
    const kept = sorted.filter(
      (f, i) => i === 0 || i === sorted.length - 1 || !(sorted[i - 1].css === f.css && sorted[i + 1].css === f.css),
    );

    const out: string[] = [];
    let prev = -1;
    for (const f of kept) {
      let pct = Math.round((f.t / this.duration) * 1e6) / 1e4;
      // CSS merges keyframes with equal offsets, so nudge to keep instant jumps.
      if (pct <= prev) pct = Math.round((prev + 0.0001) * 1e4) / 1e4;
      if (pct > 100) pct = 100;
      out.push(`${pct}%{${f.css}}`);
      prev = pct;
    }
    return out.join("");
  }
}

export function visibilityFrames(from: number, to: number, fade = 0): Frame[] {
  const f = Math.max(fade, 0.001);
  return [
    [0, "opacity:0"],
    [from, "opacity:0"],
    [from + f, "opacity:1"],
    [to, "opacity:1"],
    [to + f, "opacity:0"],
  ];
}

export function translate(x: number, y: number, extra = ""): string {
  return `transform:translate(${fmt(x)}px,${fmt(y)}px)${extra ? " " + extra : ""}`;
}

export function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}
