import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';

/**
 * التخزين السحابي المعزول (المقدمة الاستراتيجية §٣)
 * كل ملف يُحفظ تحت مسار جذري يحمل معرّف الجهة: tenants/{tenant_id}/...
 * ما يسهّل إدارة المساحات وحذف بيانات أي جهة لاحقاً عند الحاجة.
 * المحرّك الافتراضي محلي، وواجهة الاستدعاء نفسها تعمل مع S3 دون تغيير المستدعين.
 */
const localRoot = config.storage.root;

export function buildKey(tenantId, context, originalName) {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 10) || '';
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(8).toString('hex');
  const safeCtx = String(context || 'general').replace(/[^a-z0-9_-]/gi, '');
  return `tenants/${tenantId}/${safeCtx}/${stamp}/${rand}${ext}`;
}

export async function put(key, buffer) {
  if (config.storage.driver === 's3') return putS3(key, buffer);
  const full = path.join(localRoot, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return { key, size: buffer.length };
}

export async function get(key) {
  if (config.storage.driver === 's3') return getS3(key);
  const full = path.join(localRoot, key);
  if (!isInside(full)) throw new Error('مسار غير صالح');
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

export function stream(key) {
  const full = path.join(localRoot, key);
  if (!isInside(full) || !fs.existsSync(full)) return null;
  return fs.createReadStream(full);
}

export async function remove(key) {
  if (config.storage.driver === 's3') return removeS3(key);
  const full = path.join(localRoot, key);
  if (isInside(full) && fs.existsSync(full)) fs.unlinkSync(full);
  return true;
}

/** حذف كامل بيانات جهة (مفيد في مرحلة SaaS) */
export async function purgeTenant(tenantId) {
  const dir = path.join(localRoot, 'tenants', String(tenantId));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function isInside(full) {
  const resolved = path.resolve(full);
  return resolved.startsWith(path.resolve(localRoot) + path.sep);
}

// ── واجهات S3 (تُفعّل بضبط STORAGE_DRIVER=s3 وتثبيت @aws-sdk/client-s3) ──
async function s3client() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: config.storage.s3.region,
    endpoint: config.storage.s3.endpoint || undefined,
    credentials: { accessKeyId: config.storage.s3.accessKey, secretAccessKey: config.storage.s3.secretKey }
  });
}
async function putS3(key, buffer) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await s3client();
  await c.send(new PutObjectCommand({ Bucket: config.storage.s3.bucket, Key: key, Body: buffer }));
  return { key, size: buffer.length };
}
async function getS3(key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await s3client();
  const r = await c.send(new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
  const chunks = []; for await (const ch of r.Body) chunks.push(ch);
  return Buffer.concat(chunks);
}
async function removeS3(key) {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await s3client();
  await c.send(new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
  return true;
}

export default { buildKey, put, get, stream, remove, purgeTenant };
