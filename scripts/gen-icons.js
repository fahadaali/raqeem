/**
 * توليد أيقونات التطبيق (PNG) من ملف الهوية الرسمي مباشرة —
 * `web/assets/brand/app-icon.svg` هو المصدر الوحيد، فلا يُعاد رسم الشعار
 * ولا تُقارَب هندسته يدوياً (دليل الهوية · البند ٤).
 *
 * لا تبعيات خارجية: قارئ مسارات SVG مصغّر + ترميز PNG عبر zlib.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../server/node/env.js';

const OUT = path.join(ROOT, 'web/assets/icons');
const BRAND = path.join(ROOT, 'web/assets/brand');
fs.mkdirSync(OUT, { recursive: true });

/* ── ترميز PNG ─────────────────────────────────────────────── */
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

/* ── قراءة مسارات SVG وتسطيحها إلى مضلّعات ─────────────────── */
const ARC_SEG = 12;   /* قطع القوس الواحد — يكفي لنعومة الحواف عند ١٠٢٤px */

/** تحويل قوس SVG (A/a) إلى نقاط، بصيغة مركز الدائرة القياسية */
function arcPoints(x1, y1, rx, ry, rot, large, sweep, x2, y2, out) {
  if (rx === 0 || ry === 0) { out.push([x2, y2]); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const a = Math.acos(Math.min(1, Math.max(-1, d)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  for (let i = 1; i <= ARC_SEG; i++) {
    const t = t1 + (dt * i) / ARC_SEG;
    out.push([
      cp * rx * Math.cos(t) - sp * ry * Math.sin(t) + cx,
      sp * rx * Math.cos(t) + cp * ry * Math.sin(t) + cy
    ]);
  }
}

const bez3 = (p0, p1, p2, p3, out) => {
  for (let i = 1; i <= ARC_SEG; i++) {
    const t = i / ARC_SEG, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ]);
  }
};

/** يحوّل السمة `d` إلى قائمة حلقات مغلقة من النقاط */
function flattenPath(d) {
  const tok = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const rings = []; let ring = [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'M') {
      const nx = num(), ny = num();
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      if (ring.length > 2) rings.push(ring);
      ring = [[x, y]]; sx = x; sy = y;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const nx = num(), ny = num();
      x = rel ? x + nx : nx; y = rel ? y + ny : ny; ring.push([x, y]);
    } else if (C === 'H') { const nx = num(); x = rel ? x + nx : nx; ring.push([x, y]); }
    else if (C === 'V') { const ny = num(); y = rel ? y + ny : ny; ring.push([x, y]); }
    else if (C === 'C') {
      const p0 = [x, y];
      const c1 = [rel ? x + num() : num(), rel ? y + num() : num()];
      const c2 = [rel ? x + num() : num(), rel ? y + num() : num()];
      const p3 = [rel ? x + num() : num(), rel ? y + num() : num()];
      bez3(p0, c1, c2, p3, ring); x = p3[0]; y = p3[1];
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
      const nx = num(), ny = num();
      const ex = rel ? x + nx : nx, ey = rel ? y + ny : ny;
      arcPoints(x, y, rx, ry, rot, la, sw, ex, ey, ring);
      x = ex; y = ey;
    } else if (C === 'Z') {
      if (ring.length > 2) rings.push(ring);
      ring = []; x = sx; y = sy;
    } else { i++; }
  }
  if (ring.length > 2) rings.push(ring);
  return rings;
}

const rectRings = (x, y, w, h, r) => {
  const p = [];
  const corner = (cx, cy, from) => {
    for (let k = 0; k <= ARC_SEG; k++) {
      const a = from + (Math.PI / 2) * (k / ARC_SEG);
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  corner(x + w - r, y + r, -Math.PI / 2);
  return [p];
};

const circleRings = (cx, cy, r) => {
  const p = [];
  for (let k = 0; k <= ARC_SEG * 4; k++) {
    const a = (2 * Math.PI * k) / (ARC_SEG * 4);
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return [p];
};

/** يقرأ الشكل من ملف SVG رسمي: rect / path / circle بترتيب ظهورها */
function readShapes(file) {
  const svg = fs.readFileSync(file, 'utf8');
  const box = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 64 64';
  const [, , vw, vh] = box.split(/\s+/).map(Number);
  const shapes = [];
  /* الحدّ `\s` ضروري: بدونه يلتقط `x` قيمةَ `rx` فينزاح الشعار خارج الإطار */
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
  for (const tag of svg.match(/<(rect|path|circle)[^>]*>/g) || []) {
    const fill = attr(tag, 'fill') || '#000000';
    if (fill === 'none') continue;
    if (tag.startsWith('<rect')) {
      shapes.push({ fill, rings: rectRings(
        Number(attr(tag, 'x') || 0), Number(attr(tag, 'y') || 0),
        Number(attr(tag, 'width')), Number(attr(tag, 'height')), Number(attr(tag, 'rx') || 0)) });
    } else if (tag.startsWith('<circle')) {
      shapes.push({ fill, rings: circleRings(
        Number(attr(tag, 'cx')), Number(attr(tag, 'cy')), Number(attr(tag, 'r'))) });
    } else {
      shapes.push({ fill, rings: flattenPath(attr(tag, 'd') || '') });
    }
  }
  return { shapes, vw, vh };
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** هل النقطة داخل الحلقات؟ قاعدة عدد التقاطعات (even-odd تكفي لأشكالنا) */
function inside(rings, px, py) {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

const SS = 3;   /* تنعيم بالتظليل الفائق ٣×٣ */

/**
 * يرسم الأيقونة من ملف الهوية.
 * @param {number} size ضلع الأيقونة بالبكسل
 * @param {{maskable?:boolean}} [o] الصيغة القابلة للقصّ تُحاط بهامش أمان وخلفية ممتدة
 */
function drawIcon(size, o = {}) {
  const { shapes, vw, vh } = readShapes(path.join(BRAND, 'app-icon.svg'));
  const buf = Buffer.alloc(size * size * 4);
  /* الصيغة القابلة للقصّ: الشعار ضمن ٧٨٪ الوسطى وخلفية خضراء تملأ الإطار */
  const inset = o.maskable ? size * 0.11 : 0;
  const span = size - inset * 2;
  const bg = o.maskable ? hex(shapes[0].fill) : null;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const ux = ((px + (sx + 0.5) / SS - inset) / span) * vw;
        const uy = ((py + (sy + 0.5) / SS - inset) / span) * vh;
        let c = bg, hasColor = !!bg;
        /* الأشكال بترتيب الملف: الأخير يعلو ما قبله */
        for (const s of shapes) if (inside(s.rings, ux, uy)) { c = hex(s.fill); hasColor = true; }
        if (!hasColor) continue;
        r += c[0]; g += c[1]; b += c[2]; a += 255;
      }
      const n = SS * SS;
      if (!a) { buf[i + 3] = 0; continue; }
      const k = a / 255;   /* عدد العيّنات المعتمة — يُستخدم لمتوسط اللون */
      buf[i] = Math.round(r / k); buf[i + 1] = Math.round(g / k);
      buf[i + 2] = Math.round(b / k); buf[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, buf);
}

/** أيقونة مختصرة للاختصارات في القائمة السريعة — بألوان الهوية */
function drawBadge(size, color, glyph) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size * 0.46;
  const CREAM = hex('#FBF7EF');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) { buf[i + 3] = 0; continue; }
    let c = color;
    if (glyph === 'check' && y > cy - size * 0.06 && y < cy + size * 0.06 && x > cx - size * 0.22 && x < cx + size * 0.22) c = CREAM;
    if (glyph === 'plus' && ((Math.abs(x - cx) < size * 0.06 && Math.abs(y - cy) < size * 0.24) || (Math.abs(y - cy) < size * 0.06 && Math.abs(x - cx) < size * 0.24))) c = CREAM;
    if (glyph === 'dot' && d < size * 0.18) c = CREAM;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
  return encodePNG(size, size, buf);
}

const SANA = hex('#2F8A6F'), SANA_DARK = hex('#1C5E4C'), APRICOT = hex('#E8A25C'), CREAM = hex('#FBF7EF');

const sizes = [72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
for (const s of sizes) fs.writeFileSync(path.join(OUT, `icon-${s}.png`), drawIcon(s));
fs.writeFileSync(path.join(OUT, 'icon-maskable-192.png'), drawIcon(192, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'favicon.png'), drawIcon(48));
fs.writeFileSync(path.join(OUT, 'badge-72.png'), drawBadge(72, CREAM, 'dot'));
fs.writeFileSync(path.join(OUT, 'shortcut-tasks.png'), drawBadge(96, SANA, 'check'));
fs.writeFileSync(path.join(OUT, 'shortcut-check.png'), drawBadge(96, APRICOT, 'dot'));
fs.writeFileSync(path.join(OUT, 'shortcut-new.png'), drawBadge(96, SANA_DARK, 'plus'));

console.log(`✔ تم توليد ${sizes.length + 7} أيقونة من web/assets/brand/app-icon.svg`);
