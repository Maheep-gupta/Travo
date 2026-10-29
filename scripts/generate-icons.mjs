#!/usr/bin/env node
// Rasterises the Tavro brand mark (apps/web/public/icon.svg) into the PNG
// icons the web manifest and iOS need. Zero dependencies: the shapes are
// redrawn here as signed-distance tests, anti-aliased by supersampling, and
// encoded with node:zlib. If icon.svg changes, update MARK below to match and
// re-run:  node scripts/generate-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "public");
const SUPERSAMPLE = 5; // 5x5 samples per pixel

// Mark geometry in icon.svg user units (viewBox 0 0 32 32).
const MARK = {
  tile: { size: 32, radius: 9, color: [0x25, 0x2b, 0x28, 1] },
  ring: { cx: 16, cy: 16, r: 8.5, width: 2, color: [0xec, 0xe6, 0xd8, 0.85] },
  // Quarter arc from 12 o'clock clockwise to 3 o'clock, round caps.
  arc: { cx: 16, cy: 16, r: 8.5, width: 2.4, from: -Math.PI / 2, to: 0, color: [0xe2, 0x80, 0x5a, 1] },
  dot: { cx: 16, cy: 16, r: 3, color: [0xe2, 0x80, 0x5a, 1] },
};
const APP_BG = [0x11, 0x14, 0x12, 1]; // #111412, the app's dark background

// --- shape tests (point in mark units -> inside?) ---------------------------

function inRoundedRect(x, y, size, radius) {
  const h = size / 2;
  const qx = Math.abs(x - h) - (h - radius);
  const qy = Math.abs(y - h) - (h - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius <= 0;
}

function inRing(x, y, { cx, cy, r, width }) {
  return Math.abs(Math.hypot(x - cx, y - cy) - r) <= width / 2;
}

function inArc(x, y, { cx, cy, r, width, from, to }) {
  const dx = x - cx;
  const dy = y - cy;
  const angle = Math.atan2(dy, dx); // y points down, so increasing angle = clockwise
  let dist;
  if (angle >= from && angle <= to) {
    dist = Math.abs(Math.hypot(dx, dy) - r);
  } else {
    // Round caps: distance to the nearest endpoint.
    dist = Math.min(
      Math.hypot(x - (cx + r * Math.cos(from)), y - (cy + r * Math.sin(from))),
      Math.hypot(x - (cx + r * Math.cos(to)), y - (cy + r * Math.sin(to))),
    );
  }
  return dist <= width / 2;
}

function inDisc(x, y, { cx, cy, r }) {
  return Math.hypot(x - cx, y - cy) <= r;
}

// --- rendering --------------------------------------------------------------

/**
 * @param {number} px output size in pixels (square)
 * @param {object} opts
 * @param {number[] | null} opts.background full-bleed RGBA fill, or null for transparent
 * @param {"rounded" | "square" | "none"} opts.tile how to draw the #252b28 tile
 * @param {number} opts.markSize width in pixels the 32-unit mark occupies, centred
 */
function render(px, { background, tile, markSize }) {
  const scale = markSize / 32;
  const offset = (px - markSize) / 2;
  const layers = [];
  if (background) layers.push({ color: background, hit: () => true });
  if (tile === "rounded") layers.push({ color: MARK.tile.color, hit: (x, y) => inRoundedRect(x, y, 32, MARK.tile.radius) });
  if (tile === "square") layers.push({ color: MARK.tile.color, hit: () => true });
  layers.push({ color: MARK.ring.color, hit: (x, y) => inRing(x, y, MARK.ring) });
  layers.push({ color: MARK.arc.color, hit: (x, y) => inArc(x, y, MARK.arc) });
  layers.push({ color: MARK.dot.color, hit: (x, y) => inDisc(x, y, MARK.dot) });

  const rgba = Buffer.alloc(px * px * 4);
  const n = SUPERSAMPLE;
  for (let py = 0; py < px; py++) {
    for (let pxl = 0; pxl < px; pxl++) {
      // Accumulate premultiplied colour across sub-samples.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (pxl + (sx + 0.5) / n - offset) / scale;
          const y = (py + (sy + 0.5) / n - offset) / scale;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const layer of layers) {
            if (!layer.hit(x, y)) continue;
            const [lr, lg, lb, la] = layer.color;
            // Source-over in premultiplied space.
            cr = lr * la + cr * (1 - la);
            cg = lg * la + cg * (1 - la);
            cb = lb * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const samples = n * n;
      const alpha = a / samples;
      const i = (py * px + pxl) * 4;
      if (alpha > 0) {
        rgba[i] = Math.round(r / samples / alpha);
        rgba[i + 1] = Math.round(g / samples / alpha);
        rgba[i + 2] = Math.round(b / samples / alpha);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(px, px, rgba);
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // compression, filter, interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- outputs ----------------------------------------------------------------

const ICONS = [
  // "any" purpose: the SVG as-is, transparent outside the rounded tile.
  { file: "icon-192.png", px: 192, opts: { background: null, tile: "rounded", markSize: 192 } },
  { file: "icon-512.png", px: 512, opts: { background: null, tile: "rounded", markSize: 512 } },
  // Maskable: full-bleed app background, no tile (the platform mask supplies
  // the shape). The ring's outer edge (9.5 units) sits at 0.30 x size from the
  // centre, inside the 0.40 x size safe-zone circle.
  { file: "icon-maskable-512.png", px: 512, opts: { background: APP_BG, tile: "none", markSize: (512 * 0.3 * 32) / 9.5 } },
  // iOS rounds the corners itself and fills transparency with black, so the
  // tile colour goes full-bleed.
  { file: "apple-touch-icon.png", px: 180, opts: { background: null, tile: "square", markSize: 180 } },
];

for (const { file, px, opts } of ICONS) {
  const png = render(px, opts);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file}  ${px}x${px}  ${png.length} bytes`);
}
