import { Hono } from 'hono';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { audit } from '../middleware/audit.js';
import { findScoped } from '../scope.js';
import { buildKey } from '../storage.js';
import { assertQuota } from '../billing.js';

const router = new Hono();

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/svg+xml',
  /* الرسائل الصوتية في المحادثات — ما يخرج به مسجّل المتصفح على أجهزة الجميع:
     ويب-إم على أندرويد وسطح المكتب، وإم-بي-فور على آبل، والباقي احتياطاً */
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a',
  'application/pdf', 'text/csv', 'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const asFiles = (value) => (Array.isArray(value) ? value : [value]).filter(f => f && typeof f === 'object' && 'arrayBuffer' in f);

/*
 * النوع يُقاس بأصله لا بمعاملاته: مسجّل المتصفّح يُخرج
 * «audio/webm;codecs=opus»
 * والقائمةُ تعرف «audio/webm» وحدها، فكانت الرسالةُ الصوتية تُرفض عند من
 * سجّلها بترميزٍ مذكور. والمعاملات لا تغيّر نوع الملف فتُقصّ قبل المطابقة.
 */
const baseMime = (t) => String(t || '').split(';')[0].trim().toLowerCase();

router.post('/', h(async (req) => {
  const app = req.app;
  const files = asFiles(req.body?.files);
  if (!files.length) throw badRequest('لم يتم إرفاق أي ملف');
  if (files.length > 10) throw badRequest('يمكن رفع ١٠ ملفات كحد أقصى في المرة الواحدة');
  const context = String(req.body?.context || 'general');
  const maxBytes = app.cfg.uploadMaxMb * 1024 * 1024;

  /* حدّ مساحة التخزين في خطة الاشتراك يُفحص قبل الكتابة لا بعدها */
  const incomingMb = files.reduce((sum, f) => sum + (f.size || 0), 0) / 1048576;
  await assertQuota(app, req.ctx.tenantId, 'storage_mb', incomingMb);

  const out = [];

  for (const f of files) {
    const mime = baseMime(f.type);
    if (!ALLOWED.has(mime)) throw badRequest(`نوع الملف غير مسموح: ${f.name}`);
    if (f.size > maxBytes) throw badRequest(`حجم الملف يتجاوز الحد المسموح (${app.cfg.uploadMaxMb} ميجابايت)`);
    const data = new Uint8Array(await f.arrayBuffer());
    const key = buildKey(req.ctx.tenantId, context, f.name);
    await app.storage.put(key, data, { contentType: mime });
    const r = await app.db.run(
      `INSERT INTO files(tenant_id,branch_id,storage_key,original_name,mime,size,context,uploaded_by)
       VALUES(?,?,?,?,?,?,?,?)`,
      req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId, key,
      f.name, mime, data.length, context, req.ctx.userId);
    out.push({ id: r.lastId, name: f.name, mime, size: data.length, url: `/api/files/${r.lastId}` });
  }
  await audit(req, { action: 'create', entity: 'file', entityId: out.map(o => o.id).join(','),
    summary: `رفع ${out.length} ملف (${context})` });
  return created({ files: out });
}));

/** معاينة الملف داخل النظام دون تحميله (قارئ الفواتير — البند ٦) */
router.get('/:id', h(async (req, c) => {
  const app = req.app;
  const f = await findScoped(app, req.ctx, 'files', req.params.id);
  if (!f) throw notFound('الملف غير موجود');
  const download = req.query.download === '1';
  const headers = {
    'Content-Type': f.mime || 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`
  };

  if (app.storage.getStream) {
    const s = await app.storage.getStream(f.storage_key);
    if (!s) throw notFound('تعذّر العثور على الملف في وحدة التخزين');
    return new Response(s.body, { headers: { ...headers, 'Content-Length': String(s.size) } });
  }
  const buf = await app.storage.get(f.storage_key);
  if (!buf) throw notFound('تعذّر العثور على الملف في وحدة التخزين');
  return new Response(buf, { headers: { ...headers, 'Content-Length': String(buf.length) } });
}));

router.delete('/:id', h(async (req) => {
  const app = req.app;
  const f = await findScoped(app, req.ctx, 'files', req.params.id);
  if (!f) throw notFound('الملف غير موجود');
  if (f.uploaded_by !== req.ctx.userId && !req.ctx.perms.includes('settings.manage')) throw forbidden();
  await app.storage.remove(f.storage_key);
  await app.db.run('DELETE FROM files WHERE id=? AND tenant_id=?', f.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'file', entityId: f.id, summary: `حذف الملف: ${f.original_name}` });
  return { ok: true };
}));

export default router;
