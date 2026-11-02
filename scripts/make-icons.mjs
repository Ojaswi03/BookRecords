/* Generates ShelfScout's app icons as PNGs with zero dependencies.
 * Run with: npm run icons */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

const BG = [20, 18, 15, 255];
const SHELF = [92, 70, 48, 255];
const SHELF_TOP = [138, 106, 71, 255];
const CREAM = [242, 235, 223, 255];
const BRASS = [217, 161, 92, 255];
const SAGE = [148, 194, 164, 255];
const WOOD = [122, 90, 58, 255];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // no filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(size) {
  const SS = 4;
  const w = size * SS;
  const px = Buffer.alloc(w * w * 4);
  const n = (v) => v * w;

  const set = (x, y, c) => {
    const i = (y * w + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  };

  for (let i = 0; i < px.length; i += 4) {
    px[i] = BG[0];
    px[i + 1] = BG[1];
    px[i + 2] = BG[2];
    px[i + 3] = 255;
  }

  // Rounded rectangle in device pixels (edges smoothed by supersampling).
  const roundRect = (x0, y0, x1, y1, r, c) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(w, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
        const pxx = x + 0.5;
        const pyy = y + 0.5;
        const cx = Math.min(Math.max(pxx, x0 + r), x1 - r);
        const cy = Math.min(Math.max(pyy, y0 + r), y1 - r);
        const dx = pxx - cx;
        const dy = pyy - cy;
        if (dx * dx + dy * dy <= r * r) set(x, y, c);
      }
    }
  };

  // Shelf
  roundRect(n(0.16), n(0.705), n(0.84), n(0.762), n(0.014), SHELF);
  roundRect(n(0.16), n(0.705), n(0.84), n(0.723), n(0.009), SHELF_TOP);

  // Four books resting on the shelf
  roundRect(n(0.225), n(0.4), n(0.335), n(0.708), n(0.012), SAGE);
  roundRect(n(0.225), n(0.428), n(0.335), n(0.442), n(0.004), CREAM);
  roundRect(n(0.225), n(0.664), n(0.335), n(0.678), n(0.004), CREAM);

  roundRect(n(0.35), n(0.285), n(0.465), n(0.708), n(0.012), CREAM);
  roundRect(n(0.35), n(0.315), n(0.465), n(0.332), n(0.004), BRASS);
  roundRect(n(0.35), n(0.652), n(0.465), n(0.668), n(0.004), BRASS);

  roundRect(n(0.48), n(0.365), n(0.6), n(0.708), n(0.012), BRASS);
  roundRect(n(0.48), n(0.395), n(0.6), n(0.412), n(0.004), BG);

  roundRect(n(0.615), n(0.46), n(0.715), n(0.708), n(0.012), WOOD);
  roundRect(n(0.615), n(0.49), n(0.715), n(0.505), n(0.004), BRASS);

  // Bookmark hanging out of the middle book
  roundRect(n(0.515), n(0.3), n(0.548), n(0.405), n(0.004), SAGE);

  // Downsample with a box filter for smooth edges at small sizes.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
        }
      }
      const count = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

const outputs = [
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["apple-touch-icon.png", 180],
  ["favicon-32.png", 32],
];

for (const [name, size] of outputs) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePNG(size, size, render(size)));
  console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
console.log(`Icons written to ${outDir}`);
