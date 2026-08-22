import { nowUTC } from './sql.js';

/**
 * سجل عمليات المنصة — مقفل ضد التعديل والحذف بمُشغّلات قاعدة البيانات.
 *
 * يُستدعى من مسارات لوحة المنصة ومن مسار دخولها، وسياق الادمن فيهما مسطّح
 * (`adminId`/`adminName`) بلا جهة. ويقبل أيضاً سياق مستأجر (`userId`/`userName`)
 * كي تبقى المواضع التي تُسجّل باسم مستخدم جهة عاملةً كما هي.
 */
export async function plog(req, {
  action, entity, entityId = null, tenantId = null, summary = '', meta = null
} = {}) {
  const ctx = req.ctx || {};
  try {
    await req.app.db.run(
      `INSERT INTO platform_logs(actor_id,actor_name,tenant_id,action,entity,entity_id,summary,meta,ip,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ctx.adminId ?? ctx.userId ?? null,
      ctx.adminName ?? ctx.userName ?? 'النظام',
      tenantId, action, entity,
      entityId === null ? null : String(entityId), summary,
      meta ? JSON.stringify(meta) : null, req.ip || '', nowUTC());
  } catch (e) {
    /* السجل مساعد لا حرج: فشله لا يُسقط العملية التي يوثّقها */
    console.error('[platform-log]', e.message);
  }
}
