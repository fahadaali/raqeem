/**
 * طبقة التشفير المحمولة — تعمل على Node و Cloudflare Workers دون تغيير.
 * تعتمد Web Crypto القياسي بدل مكتبات Node الأصلية.
 *   • رموز الجلسات JWT بخوارزمية HS256
 *   • تجزئة كلمات المرور بـ PBKDF2-HMAC-SHA256 (مع دعم قراءة تجزئات bcrypt القديمة)
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

/* ── ترميز base64url ── */
export function b64uEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const randomToken = (n = 32) => b64uEncode(randomBytes(n));
export const uuid = () => globalThis.crypto.randomUUID();

/* ── مقارنة ثابتة الزمن ── */
export function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ── تجزئة SHA-256 ── */
export async function sha256Hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const hash = new Uint8Array(await subtle.digest('SHA-256', data));
  return [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ═══════════════ رموز الجلسات (JWT — HS256) ═══════════════ */
const hmacKeyCache = new Map();
async function hmacKey(secret) {
  if (!hmacKeyCache.has(secret)) {
    hmacKeyCache.set(secret, await subtle.importKey('raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return hmacKeyCache.get(secret);
}

/** يحوّل "12h" أو "30d" أو رقم ثوانٍ إلى ثوانٍ */
export function parseDuration(v, fallback = 43200) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/^(\d+)\s*([smhd])?$/);
  if (!m) return fallback;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
}

export async function signJWT(payload, secret, { expiresIn = '12h', issuer = 'raqeem-erp' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iss: issuer, iat: now, exp: now + parseDuration(expiresIn) };
  const head = b64uEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const data = `${head}.${b64uEncode(enc.encode(JSON.stringify(body)))}`;
  const sig = new Uint8Array(await subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
  return `${data}.${b64uEncode(sig)}`;
}

export class JWTError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export async function verifyJWT(token, secret, { issuer = 'raqeem-erp' } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new JWTError('رمز غير صالح', 'INVALID');
  const data = `${parts[0]}.${parts[1]}`;
  let valid = false;
  try {
    valid = await subtle.verify('HMAC', await hmacKey(secret), b64uDecode(parts[2]), enc.encode(data));
  } catch { throw new JWTError('رمز غير صالح', 'INVALID'); }
  if (!valid) throw new JWTError('توقيع الرمز غير صحيح', 'INVALID');

  let payload;
  try { payload = JSON.parse(dec.decode(b64uDecode(parts[1]))); }
  catch { throw new JWTError('حمولة الرمز غير صالحة', 'INVALID'); }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new JWTError('انتهت صلاحية الرمز', 'EXPIRED');
  if (issuer && payload.iss !== issuer) throw new JWTError('مُصدر الرمز غير معروف', 'INVALID');
  return payload;
}

/* ═══════════════ كلمات المرور ═══════════════ */

/*
 * سقف Cloudflare Workers لتكرارات PBKDF2 هو ١٠٠٬٠٠٠، وتجاوزه يرفع
 * "iteration counts above 100000 are not supported" على بيئة الإنتاج.
 * والسقف لا تفرضه بيئة التطوير المحلية (workerd) ولا Node، فيظهر الخلل
 * أول مرة على الإنتاج وحده — لذلك هذا الثابت مقيَّد بالسقف ويُدقَّق آلياً.
 * لا ترفعه: الرفع لا يعمل، لا يزيد المتانة.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;

/** ينتج: pbkdf2$sha256$<iterations>$<salt>$<hash> */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const bits = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64uEncode(salt)}$${b64uEncode(bits)}`;
}

async function derive(password, salt, iterations) {
  const key = await subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, , iterations, salt, hash] = stored.split('$');
    const bits = await derive(password, b64uDecode(salt), Number(iterations));
    return timingSafeEqual(bits, b64uDecode(hash));
  }
  // تجزئات bcrypt القديمة — تُقبل للتوافق ثم تُرقّى عند أول دخول ناجح
  if (/^\$2[aby]?\$/.test(stored)) {
    try {
      const bcrypt = (await import('bcryptjs')).default;
      return bcrypt.compareSync(String(password), stored);
    } catch { return false; }
  }
  return false;
}

/**
 * هل تحتاج التجزئة ترقية؟ نعم إن كانت بصيغة قديمة (bcrypt)، أو بعدد تكرارات
 * يتجاوز سقف Workers — فتجزئة وُلّدت على Node بعدد أعلى لا يمكن التحقّق منها
 * بعد الترحيل إلى Cloudflare، فتُرقَّى عند أول دخول ناجح قبل الترحيل.
 */
export const needsRehash = (stored) => {
  const s = String(stored || '');
  if (!s.startsWith('pbkdf2$')) return true;
  return Number(s.split('$')[2]) > PBKDF2_MAX_ITERATIONS;
};

export default {
  b64uEncode, b64uDecode, randomBytes, randomToken, uuid, timingSafeEqual, sha256Hex,
  signJWT, verifyJWT, hashPassword, verifyPassword, needsRehash, parseDuration
};
