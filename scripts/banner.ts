import { writeFile } from "node:fs/promises";
import { fmt, Timeline } from "../src/anim.ts";
import { bitmapPath, pixelText } from "../src/pixel-font.ts";

// The README's marquee. Generated rather than drawn by hand so it shares the
// games' pixel font and stays a plain animated SVG that GitHub can show.

const W = 896;
const H = 272;
const R = 22;
const SPECTRUM = ["#ff4d6d", "#ff7a3d", "#f5b53d", "#14b88a", "#2f8cff", "#7c5cff", "#ff4df0"];

const CRAB = [
  [
    "..#.....#..",
    "...#...#...",
    "..#######..",
    ".##.###.##.",
    "###########",
    "#.#######.#",
    "#.#.....#.#",
    "...##.##...",
  ],
  [
    "..#.....#..",
    "#..#...#..#",
    "#.#######.#",
    "###.###.###",
    "###########",
    ".#########.",
    "..#.....#..",
    ".#.......#.",
  ],
];

const GHOST = [
  "....####....",
  "..########..",
  ".##########.",
  ".#..####..#.",
  "#....##....#",
  "#..##..##..#",
  "############",
  "############",
  "############",
  "##.###.###.#",
  "#...#...#..#",
];

const tl = new Timeline(4.8, "m");
const out: string[] = [];

// Cabinet panel with a faint scanline overlay.
out.push(
  `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a0b2e"/><stop offset="1" stop-color="#07040f"/></linearGradient>` +
    `<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#ffffff" fill-opacity="0.04"/></pattern>` +
    `<linearGradient id="title" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" spreadMethod="repeat">` +
    SPECTRUM.concat(SPECTRUM[0]).map((c, i) => `<stop offset="${fmt(i / SPECTRUM.length)}" stop-color="${c}"/>`).join("") +
    `<animateTransform attributeName="gradientTransform" type="translate" values="0 0;${W} 0" dur="6s" repeatCount="indefinite"/>` +
    `</linearGradient>` +
    `<filter id="glow" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `</defs>`,
);
out.push(`<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="${R}" fill="url(#bg)" stroke="#3b1d6e" stroke-width="3"/>`);
out.push(`<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="${R}" fill="url(#scan)"/>`);

// Chasing marquee bulbs: every bulb shares one pulse, offset along the border.
const bulbs: [number, number][] = [];
const inset = 16;
const step = 26;
for (let x = inset + R; x <= W - inset - R; x += step) bulbs.push([x, inset]);
for (let y = inset + step; y <= H - inset - step; y += step) bulbs.push([W - inset, y]);
for (let x = W - inset - R; x >= inset + R; x -= step) bulbs.push([x, H - inset]);
for (let y = H - inset - step; y >= inset + step; y -= step) bulbs.push([inset, y]);
const pulse = tl.keyframes([
  [0, "opacity:1"],
  [0.35, "opacity:1"],
  [0.6, "opacity:.18"],
  [4.8, "opacity:.18"],
]);
bulbs.forEach(([x, y], i) => {
  const color = i % 2 ? "#f5b53d" : "#ff4df0";
  const cls = tl.useKeyframes(pulse, (i * 4.8) / bulbs.length * 3);
  out.push(`<circle class="${cls}" cx="${fmt(x)}" cy="${fmt(y)}" r="3.6" fill="${color}" filter="url(#glow)"/>`);
});

// Title with a hard drop shadow, then the moving spectrum fill on top.
const title = pixelText("COMMIT ARCADE", 7);
const tx = (W - title.width) / 2;
const ty = 74;
out.push(`<path d="${title.d}" transform="translate(${fmt(tx + 5)} ${fmt(ty + 5)})" fill="#3b1d6e"/>`);
out.push(`<path d="${title.d}" transform="translate(${fmt(tx)} ${fmt(ty)})" fill="url(#title)" filter="url(#glow)"/>`);

const sub = pixelText("10 CLASSIC GAMES ON YOUR CONTRIBUTION GRAPH", 2);
out.push(`<path d="${sub.d}" transform="translate(${fmt((W - sub.width) / 2)} 150)" fill="#e9dcff"/>`);

// Invaders marching beside the title, ghost drifting under it.
const crabScale = 3;
const crabW = 11 * crabScale;
for (const [side, x] of [
  ["l", tx - crabW - 26],
  ["r", tx + title.width + 26],
] as const) {
  const y = ty + 6;
  for (let f = 0; f < 2; f++) {
    const cls = tl.track([
      [0, `opacity:${f === 0 ? 1 : 0}`],
      [0.6, `opacity:${f === 0 ? 1 : 0}`],
      [0.6, `opacity:${f === 0 ? 0 : 1}`],
      [1.2, `opacity:${f === 0 ? 0 : 1}`],
      [1.2, `opacity:${f === 0 ? 1 : 0}`],
      [1.8, `opacity:${f === 0 ? 1 : 0}`],
      [1.8, `opacity:${f === 0 ? 0 : 1}`],
      [2.4, `opacity:${f === 0 ? 0 : 1}`],
      [2.4, `opacity:${f === 0 ? 1 : 0}`],
      [3.0, `opacity:${f === 0 ? 1 : 0}`],
      [3.0, `opacity:${f === 0 ? 0 : 1}`],
      [3.6, `opacity:${f === 0 ? 0 : 1}`],
      [3.6, `opacity:${f === 0 ? 1 : 0}`],
      [4.2, `opacity:${f === 0 ? 1 : 0}`],
      [4.2, `opacity:${f === 0 ? 0 : 1}`],
      [4.8, `opacity:${f === 0 ? 0 : 1}`],
    ]);
    out.push(`<path class="${cls}" d="${bitmapPath(CRAB[f], crabScale, x, y)}" fill="${side === "l" ? "#14f0a0" : "#23f0ff"}" filter="url(#glow)"/>`);
  }
}

// Pac-Man chases a frightened ghost along the bottom of the marquee.
const laneY = 200;
const runFrom = -40;
const runTo = W + 40;
const chase = tl.track([
  [0, `transform:translateX(${runFrom}px)`],
  [4.8, `transform:translateX(${runTo}px)`],
]);
const mouth = `<path d="M0 0 L11.3 -6.5 A13 13 0 1 0 11.3 6.5 Z" fill="#ffe600"><animate attributeName="d" values="M0 0 L11.3 -6.5 A13 13 0 1 0 11.3 6.5 Z;M0 0 L13 -0.6 A13 13 0 1 0 13 0.6 Z;M0 0 L11.3 -6.5 A13 13 0 1 0 11.3 6.5 Z" dur=".28s" repeatCount="indefinite"/></path>`;
const ghost = `<path d="${bitmapPath(GHOST, 2, 0, 0)}" fill="#2121ff"/><path d="M6 8h2v2h-2zM14 8h2v2h-2z" fill="#ffb8ff"/>`;
// Each dot disappears as Pac-Man's mouth reaches it and is back for the next pass.
for (let x = 40; x < W - 40; x += 28) {
  const eatenAt = ((x - 14 - runFrom) / (runTo - runFrom)) * 4.8;
  const cls = tl.track([
    [0, "opacity:.75"],
    [eatenAt, "opacity:.75"],
    [eatenAt, "opacity:0"],
    [4.8, "opacity:0"],
  ]);
  out.push(`<rect class="${cls}" x="${x - 2}" y="${laneY - 2}" width="4" height="4" rx="1" fill="#ffd9a8"/>`);
}

out.push(
  `<g class="${chase}"><g transform="translate(0 ${laneY})" filter="url(#glow)">` +
    `<g transform="translate(64 -11)">${ghost}</g>` +
    `<g transform="translate(14 0)">${mouth}</g>` +
    `</g></g>`,
);

const coin = pixelText("INSERT COIN", 2);
const blink = tl.track([
  [0, "opacity:1"],
  [0.6, "opacity:1"],
  [0.6, "opacity:0"],
  [1.2, "opacity:0"],
  [1.2, "opacity:1"],
  [1.8, "opacity:1"],
  [1.8, "opacity:0"],
  [2.4, "opacity:0"],
  [2.4, "opacity:1"],
  [3.0, "opacity:1"],
  [3.0, "opacity:0"],
  [3.6, "opacity:0"],
  [3.6, "opacity:1"],
  [4.2, "opacity:1"],
  [4.2, "opacity:0"],
  [4.8, "opacity:0"],
]);
out.push(`<path class="${blink}" d="${coin.d}" transform="translate(${fmt((W - coin.width) / 2)} 228)" fill="#23f0ff" filter="url(#glow)"/>`);

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Commit Arcade: 10 classic games on your contribution graph">`,
  `<style>${tl.css()}</style>`,
  ...out,
  `</svg>`,
].join("\n");

await writeFile("assets/banner.svg", svg, "utf8");
console.log(`assets/banner.svg ${(svg.length / 1024).toFixed(0)} KB`);
