import { nowUTC } from './sql.js';
import { randomBytes, timingSafeEqual, sha256Hex } from './crypto.js';
import { badRequest, unauthorized } from './errors.js';

/**
 * أمن المنصة (المستوى ٣): مراقبة محاولات الدخول، والتحقّق بخطوتين لمالكي المنصة.
 *
 * لوحة المالك هي الطبقة الوحيدة التي تتجاوز عزل الجهات، وكانت تُحمى بكلمة مرور
 * وحدها. هنا تُضاف طبقة ثانية قائمة على المعيار (RFC 6238 / TOTP) تعمل مع أي
 * تطبيق مصادقة، ومبنية على Web Crypto فتعمل على Node و Cloudflare معاً.
 */

/* ═════════════════ مراقبة محاولات الدخول ═════════════════ */

/** يسجّل محاولة دخول — ناجحة أو فاشلة — لمراجعتها عبر المنصة */
export async function recordLoginAttempt(app, { email, tenantId = null, userId = null, success, reason = null, ip = '', userAgent = '' }) {
  try {
    await app.db.run(
      `INSERT INTO login_attempts(email,tenant_id,user_id,success,reason,ip,user_agent,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      String(email || '').slice(0, 160).toLowerCase(), tenantId, userId,
      success ? 1 : 0, reason, String(ip || '').slice(0, 60),
      String(userAgent || '').slice(0, 250), nowUTC());
  } catch { /* المراقبة ثانوية — لا تُفشل الدخول */ }
}

/** ملخّص أمني عبر المنصة خلال فترة */
export async function loginSecurityReport(app, { hours = 24, limit = 100 } = {}) {
  const from = new Date(Date.now() - hours * 3600_000).toISOString();
  const one = async (sql, ...p) => Number((await app.db.get(sql, ...p))?.c ?? 0);

  const topFailures = await app.db.all(
    `SELECT email, COUNT(*) AS attempts, MAX(created_at) AS last_at,
            COUNT(DISTINCT ip) AS ips
     FROM login_attempts WHERE success=0 AND created_at >= ?
     GROUP BY email ORDER BY attempts DESC LIMIT 15`, from);

  const topIPs = await app.db.all(
    `SELECT ip, COUNT(*) AS attempts, COUNT(DISTINCT email) AS emails, MAX(created_at) AS last_at
     FROM login_attempts WHERE success=0 AND created_at >= ? AND ip <> ''
     GROUP BY ip ORDER BY attempts DESC LIMIT 15`, from);

  const recent = await app.db.all(
    `SELECT a.*, t.name AS tenant_name FROM login_attempts a
     LEFT JOIN tenants t ON t.id = a.tenant_id
     WHERE a.created_at >= ? ORDER BY a.id DESC LIMIT ?`, from, Math.min(500, limit));

  return {
    hours,
    total: await one('SELECT COUNT(*) AS c FROM login_attempts WHERE created_at >= ?', from),
    failed: await one('SELECT COUNT(*) AS c FROM login_attempts WHERE success=0 AND created_at >= ?', from),
    succeeded: await one('SELECT COUNT(*) AS c FROM login_attempts WHERE success=1 AND created_at >= ?', from),
    distinct_ips: await one('SELECT COUNT(DISTINCT ip) AS c FROM login_attempts WHERE created_at >= ?', from),
    suspended_accounts: await one(`SELECT COUNT(*) AS c FROM users WHERE status='suspended'`),
    top_failed_accounts: topFailures,
    top_failed_ips: topIPs,
    recent
  };
}

export async function pruneLoginAttempts(app, { keepDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  const r = await app.db.run('DELETE FROM login_attempts WHERE created_at < ?', cutoff);
  return { removed: r.changes };
}

/* ═════════════════ التحقّق بخطوتين (TOTP — RFC 6238) ═════════════════ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** سرّ جديد بطول ٢٠ بايت (المعيار الموصى به) */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

/** رابط otpauth الذي تقرأه تطبيقات المصادقة */
export const totpUri = (secret, { account, issuer = 'Raqeem Platform' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);

  const key = await globalThis.crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buf));

  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** الرمز الحالي — يُستخدم في التدقيق وفي توليد رموز الاختبار */
export const totpNow = (secret, at = Date.now()) =>
  hotp(base32Decode(secret), Math.floor(at / 30000));

/**
 * يتحقّق من رمز بنافذة تسامح ±خطوة واحدة (٣٠ ثانية) لفروق الساعة.
 */
export async function verifyTotp(secret, token, { window = 1, at = Date.now() } = {}) {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const bytes = base32Decode(secret);
  if (!bytes.length) return false;
  const step = Math.floor(at / 30000);
  const enc = new TextEncoder();
  for (let i = -window; i <= window; i++) {
    const expected = await hotp(bytes, step + i);
    if (timingSafeEqual(enc.encode(expected), enc.encode(code))) return true;
  }
  return false;
}

/* ── رموز الاسترداد ── */

export function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const b = randomBytes(5);
    codes.push([...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, 10).toUpperCase());
  }
  return codes;
}

export const hashBackupCodes = (codes) => Promise.all(codes.map(c => sha256Hex(c)));

/** يستهلك رمز استرداد مرة واحدة ويعيد القائمة المتبقية */
export async function consumeBackupCode(stored, code) {
  const list = Array.isArray(stored) ? stored : [];
  const hash = await sha256Hex(String(code || '').trim().toUpperCase());
  const idx = list.indexOf(hash);
  if (idx < 0) return { ok: false, remaining: list };
  const remaining = list.slice();
  remaining.splice(idx, 1);
  return { ok: true, remaining };
}

/**
 * بوابة التحقّق بخطوتين عند الدخول.
 * تُستدعى بعد التحقق من كلمة المرور وقبل إصدار الجلسة.
 */
export async function assertSecondFactor(app, user, token, backupCodes) {
  if (!user.totp_enabled) return { required: false };
  if (!token) throw unauthorized('يلزم رمز التحقّق بخطوتين');

  if (await verifyTotp(user.totp_secret, token)) return { required: true, method: 'totp' };

  const consumed = await consumeBackupCode(backupCodes, token);
  if (consumed.ok) {
    await app.db.run('UPDATE users SET totp_backup=? WHERE id=?', JSON.stringify(consumed.remaining), user.id);
    return { required: true, method: 'backup', remaining: consumed.remaining.length };
  }
  throw unauthorized('رمز التحقّق غير صحيح');
}

/** هل يُلزَم هذا الحساب بالتحقّق بخطوتين ولم يفعّله بعد؟ */
export const needsTotpSetup = (user, settings) =>
  !!(settings?.require_2fa_admins && user?.is_platform_admin && !user?.totp_enabled);
