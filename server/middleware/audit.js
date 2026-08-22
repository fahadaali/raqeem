import db, { nowUTC } from '../db/index.js';

/**
 * التتبع الآلي (البند ١٤) — جدول append-only محمي بمُشغّلات قاعدة البيانات.
 * لا يمكن التعديل عليه أو مسحه حتى من داخل التطبيق نفسه.
 */
const stmt = db.prepare(`INSERT INTO audit_logs
  (tenant_id,branch_id,user_id,user_name,role_key,action,entity,entity_id,summary,before_json,after_json,ip,user_agent,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

export function audit(req, { action, entity, entityId = null, summary = '', before = null, after = null, branchId = null }) {
  const ctx = req?.ctx;
  if (!ctx) return;
  try {
    stmt.run(
      ctx.tenantId, branchId ?? ctx.activeBranchId ?? null, ctx.userId, ctx.userName, ctx.roleKey,
      action, entity, entityId === null ? null : String(entityId), summary,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      req.ip || '', (req.get?.('user-agent') || '').slice(0, 250), nowUTC()
    );
  } catch (e) {
    console.error('[audit] فشل تسجيل النشاط:', e.message);
  }
}

/** تسجيل مباشر دون كائن الطلب (للوظائف الخلفية) */
export function auditSystem({ tenantId, action, entity, entityId = null, summary = '', branchId = null }) {
  try {
    stmt.run(tenantId, branchId, null, 'النظام', 'system', action, entity,
      entityId === null ? null : String(entityId), summary, null, null, 'system', 'background-job', nowUTC());
  } catch (e) { console.error('[audit] ', e.message); }
}
