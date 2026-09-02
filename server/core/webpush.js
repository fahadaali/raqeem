/**
 * إشعارات الدفع (Web Push) بمعيار RFC 8291 + RFC 8292 — بتنفيذ Web Crypto خالص
 * يعمل على Cloudflare Workers و Node دون أي مكتبة أصلية.
 *   • تشفير الحمولة aes128gcm
 *   • توقيع VAPID بخوارزمية ES256
 */
import { b64uEncode, b64uDecode, randomBytes } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' };

const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** يبني مفتاح ECDSA خاصاً من مفاتيح VAPID المولّدة بصيغة base64url */
async function importVapidKey(publicKeyB64u, privateKeyB64u) {
  const pub = b64uDecode(publicKeyB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('صيغة المفتاح العام لـ VAPID غير صحيحة');
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    d: privateKeyB64u.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  };
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** رأس التفويض وفق RFC 8292 */
export async function vapidHeaders(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(enc.encode(JSON.stringify({ aud, exp, sub: subject })));
  const data = `${header}.${payload}`;
  const key = await importVapidKey(publicKey, privateKey);
  const sig = new Uint8Array(await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data)));
  return { Authorization: `vapid t=${data}.${b64uEncode(sig)}, k=${publicKey}` };
}

/**
 * تشفير حمولة الإشعار للمشترك (aes128gcm)
 * @param {{p256dh:string, auth:string}} keys مفاتيح المتصفح المشترك
 */
export async function encryptPayload(plaintext, keys) {
  const uaPublicRaw = b64uDecode(keys.p256dh);
  const authSecret = b64uDecode(keys.auth);
  if (uaPublicRaw.length !== 65) throw new Error('مفتاح p256dh غير صالح');

  const asPair = await subtle.generateKey(P256, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await subtle.exportKey('raw', asPair.publicKey));
  const uaPublic = await subtle.importKey('raw', uaPublicRaw, P256, false, []);

  const ecdhSecret = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: uaPublic }, asPair.privateKey, 256));

  const authInfo = concat(enc.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, authInfo, 32);

  const salt = randomBytes(16);
  const cekBits = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const cek = await subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const body = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const padded = concat(body, new Uint8Array([2]));      // 0x02 = آخر سجل
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // حجم السجل
  header[20] = asPublicRaw.length;
  return concat(header, asPublicRaw, cipher);
}

/**
 * رأس `Topic` وفق RFC 8030: اثنان وثلاثون محرفاً على الأكثر من أبجدية base64url.
 *
 * كانت الوسوم تمرّ كما هي — `finance.request.approved-12` — والنقطة ليست من
 * الأبجدية، فترفضها بعض خدمات الدفع بـ٤٠٠ ويسقط الإشعار على ذلك الجهاز وحده
 * دون أثرٍ يدلّ عليه. فيُطهَّر الوسم هنا حيث يُكتب الرأس، لا في كل مُرسِل.
 */
export const safeTopic = (topic) => {
  const t = String(topic || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return t || null;
};

/**
 * إرسال إشعار دفع واحد.
 * @returns {{ok:boolean, status:number, gone:boolean}}
 */
export async function sendWebPush(subscription, payload, vapid, { ttl = 3600, urgency = 'normal', topic } = {}) {
  const encrypted = await encryptPayload(
    typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys);
  const headers = {
    ...(await vapidHeaders(subscription.endpoint, vapid)),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency
  };
  const safe = safeTopic(topic);
  if (safe) headers.Topic = safe;

  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: encrypted });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** توليد زوج مفاتيح VAPID جديد */
export async function generateVAPIDKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64uEncode(pub), privateKey: jwk.d };
}

export default { sendWebPush, encryptPayload, vapidHeaders, generateVAPIDKeys, safeTopic };
