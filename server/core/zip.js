/**
 * كاتب/قارئ ZIP محمول — يستخدم CompressionStream القياسي بدل node:zlib
 * ليعمل على Cloudflare Workers و Node بالشيفرة نفسها.
 * يُستخدم لتوليد وقراءة ملفات Excel (xlsx).
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const te = new TextEncoder();
const bytes = (v) => (v instanceof Uint8Array ? v : te.encode(String(v)));
const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data); writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch { return null; }
}
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data); writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

const DOS_TIME = ((12 << 11) | (0 << 5) | 0) & 0xffff;
const DOS_DATE = (((2024 - 1980) << 9) | (1 << 5) | 1) & 0xffff;

/** @param {{name:string, data:Uint8Array|string}[]} entries */
export async function zip(entries) {
  const files = [];
  const chunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = te.encode(e.name);
    const raw = bytes(e.data);
    const deflated = await deflateRaw(raw);
    const useDeflate = deflated && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBuf.length, true);

    chunks.push(local, nameBuf, body);
    files.push({ nameBuf, crc, csize: body.length, usize: raw.length, offset, method });
    offset += local.length + nameBuf.length + body.length;
  }

  const central = [];
  let cdSize = 0;
  for (const f of files) {
    const h = new Uint8Array(46);
    const hv = new DataView(h.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true); hv.setUint16(6, 20, true);
    hv.setUint16(8, 0x0800, true);
    hv.setUint16(10, f.method, true);
    hv.setUint16(12, DOS_TIME, true); hv.setUint16(14, DOS_DATE, true);
    hv.setUint32(16, f.crc, true);
    hv.setUint32(20, f.csize, true);
    hv.setUint32(24, f.usize, true);
    hv.setUint16(28, f.nameBuf.length, true);
    hv.setUint32(42, f.offset, true);
    central.push(h, f.nameBuf);
    cdSize += h.length + f.nameBuf.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return concat([...chunks, ...central, eocd]);
}

/** فك ضغط ZIP → خريطة { name: Uint8Array } */
export async function unzip(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= 0 && i > data.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ملف مضغوط غير صالح');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const td = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = td.decode(data.slice(p + 46, p + 46 + nameLen));

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const slice = data.slice(start, start + csize);
    out[name] = method === 8 ? await inflateRaw(slice) : slice;

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** ضغط gzip محمول (للنسخ الاحتياطي) */
export async function gzip(data) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(bytes(data)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
