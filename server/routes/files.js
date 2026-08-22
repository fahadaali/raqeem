import express from 'express';
import multer from 'multer';
import db from '../db/index.js';
import { ah, badRequest, notFound, forbidden } from '../lib/errors.js';
import { audit } from '../middleware/audit.js';
import { findScoped } from '../lib/scope.js';
import * as storage from '../lib/storage.js';
import config from '../config.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 10 }
});

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/svg+xml',
  'application/pdf', 'text/csv', 'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

router.post('/', upload.array('files', 10), ah(async (req, res) => {
  if (!req.files?.length) throw badRequest('لم يتم إرفاق أي ملف');
  const context = req.body?.context || 'general';
  const out = [];
  for (const f of req.files) {
    if (!ALLOWED.has(f.mimetype)) throw badRequest(`نوع الملف غير مسموح: ${f.originalname}`);
    const key = storage.buildKey(req.ctx.tenantId, context, f.originalname);
    await storage.put(key, f.buffer);
    const r = db.prepare(`INSERT INTO files(tenant_id,branch_id,storage_key,original_name,mime,size,context,uploaded_by)
      VALUES(?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId,
      key, Buffer.from(f.originalname, 'latin1').toString('utf8'), f.mimetype, f.size, context, req.ctx.userId);
    out.push({ id: r.lastInsertRowid, name: f.originalname, mime: f.mimetype, size: f.size, url: `/api/files/${r.lastInsertRowid}` });
  }
  audit(req, { action: 'create', entity: 'file', entityId: out.map(o => o.id).join(','), summary: `رفع ${out.length} ملف (${context})` });
  res.status(201).json({ files: out });
}));

/** معاينة الملف داخل النظام دون تحميله (قارئ الفواتير — البند ٦) */
router.get('/:id', ah(async (req, res) => {
  const f = findScoped(req.ctx, 'files', req.params.id);
  if (!f) throw notFound('الملف غير موجود');
  const buf = await storage.get(f.storage_key);
  if (!buf) throw notFound('تعذّر العثور على الملف في وحدة التخزين');
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const dl = req.query.download === '1';
  res.setHeader('Content-Disposition',
    `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.send(buf);
}));

router.delete('/:id', ah(async (req, res) => {
  const f = findScoped(req.ctx, 'files', req.params.id);
  if (!f) throw notFound('الملف غير موجود');
  if (f.uploaded_by !== req.ctx.userId && !req.ctx.perms.includes('settings.manage')) throw forbidden();
  await storage.remove(f.storage_key);
  db.prepare('DELETE FROM files WHERE id=? AND tenant_id=?').run(f.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'file', entityId: f.id, summary: `حذف الملف: ${f.original_name}` });
  res.json({ ok: true });
}));

export default router;
