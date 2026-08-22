/**
 * توليد أيقونات التطبيق (PNG) بدون تبعيات خارجية —
 * ترميز PNG يدوي عبر zlib للحصول على أيقونات تثبيت للآيفون والأندرويد.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../server/node/env.js';

const OUT = path.join(ROOT, 'web/assets/icons');
fs.mkdirSync(OUT, { recursive: true });

const CRC = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const GREEN_D = [8, 58, 38], GREEN_L = [21, 101, 66], GOLD = [201, 162, 39], GOLD_L = [232, 201, 106], WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** نجمة إسلامية ثمانية (مربعان متقاطعان) — رمز الزخرفة القرآنية */
function inStar(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  const inSquare = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return Math.abs(rx) <= r && Math.abs(ry) <= r;
  };
  return inSquare(0) || inSquare(Math.PI / 4);
}

function drawIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = maskable ? size * 0.12 : 0;
  const radius = maskable ? size / 2 : size * 0.22;
  const cx = size / 2, cy = size / 2;
  const starR = (size - pad * 2) * 0.205;
  const inner = starR * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // خلفية بزوايا دائرية
      const dx = Math.max(radius - x, 0, x - (size - radius));
      const dy = Math.max(radius - y, 0, y - (size - radius));
      const outside = Math.sqrt(dx * dx + dy * dy) > radius;
      if (outside) { buf[i + 3] = 0; continue; }

      let c = mix(GREEN_L, GREEN_D, (x / size) * 0.35 + (y / size) * 0.65);

      // إطار زخرفي دائري
      const dist = Math.hypot(x - cx, y - cy);
      const ringR = (size - pad * 2) * 0.415;
      if (Math.abs(dist - ringR) < size * 0.012) c = mix(c, GOLD, 0.75);

      // النجمة الثمانية الذهبية
      if (inStar(x, y, cx, cy, starR)) {
        const t = Math.min(1, dist / starR);
        c = mix(GOLD_L, GOLD, t);
      }
      // قلب النجمة الفاتح
      if (dist < inner) c = mix(WHITE, GOLD_L, dist / inner);

      // قاعدة تمثل المصحف المفتوح
      const by = size * 0.775, bh = size * 0.045, bw = (size - pad * 2) * 0.20;
      if (y > by && y < by + bh && Math.abs(x - cx) < bw) c = mix(c, GOLD, 0.85);
      const b2y = by + bh * 1.7;
      if (y > b2y && y < b2y + bh * 0.7 && Math.abs(x - cx) < bw * 0.62) c = mix(c, GOLD, 0.6);

      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  }
  return encodePNG(size, size, buf);
}

/** أيقونة مختصرة للاختصارات في القائمة السريعة */
function drawBadge(size, color, glyph) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size * 0.46;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) { buf[i + 3] = 0; continue; }
    let c = color;
    if (glyph === 'check' && y > cy - size * 0.06 && y < cy + size * 0.06 && x > cx - size * 0.22 && x < cx + size * 0.22) c = WHITE;
    if (glyph === 'plus' && ((Math.abs(x - cx) < size * 0.06 && Math.abs(y - cy) < size * 0.24) || (Math.abs(y - cy) < size * 0.06 && Math.abs(x - cx) < size * 0.24))) c = WHITE;
    if (glyph === 'dot' && d < size * 0.18) c = WHITE;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
  return encodePNG(size, size, buf);
}

const sizes = [72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
for (const s of sizes) fs.writeFileSync(path.join(OUT, `icon-${s}.png`), drawIcon(s));
fs.writeFileSync(path.join(OUT, 'icon-maskable-192.png'), drawIcon(192, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'favicon.png'), drawIcon(48));
fs.writeFileSync(path.join(OUT, 'badge-72.png'), drawBadge(72, [255, 255, 255], 'dot'));
fs.writeFileSync(path.join(OUT, 'shortcut-tasks.png'), drawBadge(96, [15, 81, 50], 'check'));
fs.writeFileSync(path.join(OUT, 'shortcut-check.png'), drawBadge(96, [201, 162, 39], 'dot'));
fs.writeFileSync(path.join(OUT, 'shortcut-new.png'), drawBadge(96, [29, 78, 216], 'plus'));

console.log(`✔ تم توليد ${sizes.length + 7} أيقونة في web/assets/icons`);
