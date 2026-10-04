import { crc32, deflateSync } from "node:zlib";
import { fmt } from "../anim.ts";

/**
 * Pixel sprites pre-rendered to PNG, glow included. The browser repaints the
 * whole scene every frame, so one image draw per sprite is far cheaper than
 * several vector paths under a live blur filter, and the glow is blurred once
 * here instead of once per frame.
 */

export interface SpriteImageOptions {
  /** Glow blur radius in user units, as the glow filter would use; 0 for none. */
  sigma: number;
  /** Size of one sprite pixel in user units. */
  cell: number;
  /** Where the sprite's top-left corner sits in the coordinates the markup is placed in. */
  x: number;
  y: number;
  outline?: { color: string; width: number };
}

// Source pixels per sprite pixel. Enough that the browser's downscale averages edges the way vector antialiasing would.
const PX_PER_CELL = 8;
// The glow is too soft to need more than this, which keeps the blur cheap.
const GLOW_PX_PER_CELL = 2;
const OUTLINE_SAMPLES = 4;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const cache = new Map<string, string>();

/** An `<image>` element; `attrs` is appended raw (class, style...). */
export function spriteImage(rows: string[], palette: Record<string, string>, opts: SpriteImageOptions, attrs = ""): string {
  const key = JSON.stringify([rows, palette, opts]);
  let markup = cache.get(key);
  if (markup === undefined) cache.set(key, (markup = render(rows, palette, opts)));
  return `<image${attrs ? " " + attrs : ""} ${markup}`;
}

function render(rows: string[], palette: Record<string, string>, opts: SpriteImageOptions): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const sigmaPx = opts.sigma * (GLOW_PX_PER_CELL / opts.cell);
  // Whole sprite pixels of margin, so both pixel grids line up with the sprite's edges.
  const margin = opts.sigma > 0 ? Math.ceil((sigmaPx * 3 + 1) / GLOW_PX_PER_CELL) : 1;
  const scale = PX_PER_CELL / GLOW_PX_PER_CELL;
  const width = (cols + margin * 2) * PX_PER_CELL;
  const height = (rows.length + margin * 2) * PX_PER_CELL;

  const linear = new Map<string, [number, number, number]>();
  const colour = (hex: string) => {
    let c = linear.get(hex);
    if (!c) linear.set(hex, (c = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]));
    return c;
  };
  const filledAt = (cx: number, cy: number) => cy >= 0 && cy < rows.length && cx >= 0 && cx < cols && rows[cy][cx] !== undefined && rows[cy][cx] !== "." && palette[rows[cy][cx]] !== undefined;
  const reach = opts.outline ? opts.outline.width / 2 / opts.cell : 0;
  const nearFilled = (u: number, v: number) => {
    for (let cy = Math.floor(v - reach); cy <= Math.floor(v + reach); cy++) {
      for (let cx = Math.floor(u - reach); cx <= Math.floor(u + reach); cx++) {
        if (!filledAt(cx, cy)) continue;
        const dx = Math.max(cx - u, 0, u - (cx + 1));
        const dy = Math.max(cy - v, 0, v - (cy + 1));
        if (dx * dx + dy * dy <= reach * reach) return true;
      }
    }
    return false;
  };

  // Sharp sprite, premultiplied linear RGBA.
  const sharp = new Float32Array(width * height * 4);
  const samples = opts.outline ? OUTLINE_SAMPLES : 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / PX_PER_CELL - margin;
          const v = (y + (sy + 0.5) / samples) / PX_PER_CELL - margin;
          const cx = Math.floor(u);
          const cy = Math.floor(v);
          const hex = filledAt(cx, cy) ? palette[rows[cy][cx]] : opts.outline && nearFilled(u, v) ? opts.outline.color : null;
          if (hex === null) continue;
          const [lr, lg, lb] = colour(hex);
          r += lr;
          g += lg;
          b += lb;
          a += 1;
        }
      }
      const i = (y * width + x) * 4;
      const n = samples * samples;
      sharp[i] = r / n;
      sharp[i + 1] = g / n;
      sharp[i + 2] = b / n;
      sharp[i + 3] = a / n;
    }
  }

  let glow: Float32Array | null = null;
  const gw = width / scale;
  const gh = height / scale;
  if (opts.sigma > 0) {
    // Blur at low resolution; sampling the soft result back up loses nothing visible.
    const small = new Float32Array(gw * gh * 4);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) sum += sharp[((y * scale + sy) * width + x * scale + sx) * 4 + c];
          small[(y * gw + x) * 4 + c] = sum / (scale * scale);
        }
      }
    }
    glow = blur(blur(small, gw, gh, sigmaPx, true), gw, gh, sigmaPx, false);
  }

  const rgba = Buffer.alloc(width * height * 4);
  const sampleGlow = (x: number, y: number, c: number) => {
    // Bilinear lookup at the centre of fine pixel (x, y).
    const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / scale - 0.5));
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(gw - 1, x0 + 1);
    const y1 = Math.min(gh - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (px: number, py: number) => glow![(py * gw + px) * 4 + c];
    return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
  };
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = (i - x) / width;
    // The filter puts the sharp sprite over its own blur.
    const sa = sharp[i * 4 + 3];
    const px = [0, 1, 2, 3].map((c) => sharp[i * 4 + c] + (glow ? sampleGlow(x, y, c) * (1 - sa) : 0));
    const a = px[3];
    if (a < 1 / 512) continue;
    const solid = !glow || a > 0.8;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(Math.min(1, Math.max(0, toSrgb(px[c] / a))) * 255);
      // Colour hardly shows where the glow is faint, so it is stored coarser there to keep the file small.
      rgba[i * 4 + c] = solid ? v : Math.min(255, Math.round(v / 16) * 16);
    }
    rgba[i * 4 + 3] = solid ? Math.round(Math.min(1, a) * 255) : Math.round((a * 255) / 4) * 4;
  }

  const unit = opts.cell / PX_PER_CELL;
  return `href="data:image/png;base64,${png(rgba, width, height).toString("base64")}" x="${fmt(opts.x - margin * opts.cell)}" y="${fmt(opts.y - margin * opts.cell)}" width="${fmt(width * unit)}" height="${fmt(height * unit)}"/>`;
}

function blur(src: Float32Array, width: number, height: number, sigma: number, horizontal: boolean): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let k = -radius; k <= radius; k++) {
        const sx = horizontal ? x + k : x;
        const sy = horizontal ? y : y + k;
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const w = kernel[k + radius];
        const s = (sy * width + sx) * 4;
        for (let c = 0; c < 4; c++) out[o + c] += src[s + c] * w;
      }
    }
  }
  return out;
}

function png(rgba: Buffer, width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  // Per-row filter choice: smooth gradients become runs of small numbers that deflate well.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const row = (i: number) => (i < 0 ? 0 : rgba[y * stride + i]);
    const up = (i: number) => (y === 0 || i < 0 ? 0 : rgba[(y - 1) * stride + i]);
    let best = Buffer.alloc(0);
    let bestCost = Infinity;
    let bestType = 0;
    for (let type = 0; type < 5; type++) {
      const line = Buffer.alloc(stride);
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = row(i - 4);
        const b = up(i);
        const c = up(i - 4);
        const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (rgba[y * stride + i] - pred) & 255;
        line[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = line;
        bestType = type;
      }
    }
    raw[y * (stride + 1)] = bestType;
    best.copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
