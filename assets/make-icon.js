/* Generates assets/icon.png (1024²) + assets/splash.png (2732²) for @capacitor/assets.
 * Pure Node, no deps. Run: node assets/make-icon.js  */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function png(w, h, draw) {
  const buf = Buffer.alloc(w * h * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  draw(put, w, h);
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    buf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const c = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(c) >>> 0);
    return Buffer.concat([len, c, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const NAVY = [11, 27, 53], RED = [238, 38, 59], WHITE = [255, 255, 255], CANTON = [56, 89, 148];

function drawFlag(put, W, H, scale) {
  const fw = Math.round(560 * scale), fh = Math.round(368 * scale);
  const fx = Math.round((W - fw) / 2), fy = Math.round((H - fh) / 2);
  const r = Math.round(22 * scale);
  const stripeH = fh / 6;
  const cw = Math.round(fw * 0.45), ch = Math.round(fh * 0.5);
  for (let y = fy; y < fy + fh; y++) {
    for (let x = fx; x < fx + fw; x++) {
      // rounded corners
      const cx = x < fx + r ? fx + r : x > fx + fw - r ? fx + fw - r : x;
      const cy = y < fy + r ? fy + r : y > fy + fh - r ? fy + fh - r : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      let col;
      if (x - fx < cw && y - fy < ch) col = CANTON;
      else col = Math.floor((y - fy) / stripeH) % 2 === 0 ? RED : WHITE;
      put(x, y, col[0], col[1], col[2]);
    }
  }
}

function build(w, h, flagScale, out) {
  const data = png(w, h, (put, W, H) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, NAVY[0], NAVY[1], NAVY[2]);
    drawFlag(put, W, H, flagScale * (w / 1024));
  });
  fs.writeFileSync(path.join(__dirname, out), data);
  console.log(out, data.length, "bytes");
}

build(1024, 1024, 1.4, "icon.png");
build(1024, 1024, 0.62, "icon-foreground.png"); // android adaptive safe-zone
build(2732, 2732, 0.42, "splash.png");
build(2732, 2732, 0.42, "splash-dark.png");
