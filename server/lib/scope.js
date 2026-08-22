import db from '../db/index.js';
import { forbidden } from './errors.js';

/**
 * طبقة العزل المنطقي (Global Query Scopes) — البند ١ من المقدمة الاستراتيجية.
 * كل استعلام يمر عبر هذه الطبقة يُفلتر إلزامياً بـ tenant_id، ثم بـ branch_id
 * بحسب الفروع المصرّح بها للمستخدم (جدول التقاطعات user_branches).
 */

/** يبني شرط WHERE مع فلترة إلزامية للمستأجر ثم الفرع */
export function scoped(ctx, { table = '', alias = '', branchColumn = 'branch_id', respectBranch = true } = {}) {
  const p = alias ? `${alias}.` : (table ? `${table}.` : '');
  const clauses = [`${p}tenant_id = ?`];
  const params = [ctx.tenantId];

  if (respectBranch && !ctx.allBranches) {
    const ids = ctx.branchIds || [];
    if (ids.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`(${p}${branchColumn} IS NULL OR ${p}${branchColumn} IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
  }
  return { where: clauses.join(' AND '), params };
}

/** تحقق أن المستخدم مصرّح له بالفرع المطلوب */
export function assertBranch(ctx, branchId) {
  if (branchId === null || branchId === undefined || branchId === '') return null;
  const id = Number(branchId);
  if (!Number.isFinite(id)) throw forbidden('معرّف الفرع غير صالح');
  if (ctx.allBranches) {
    const ok = db.prepare('SELECT 1 FROM branches WHERE id=? AND tenant_id=?').get(id, ctx.tenantId);
    if (!ok) throw forbidden('الفرع غير موجود ضمن نطاق جهتك');
    return id;
  }
  if (!(ctx.branchIds || []).includes(id)) throw forbidden('ليست لديك صلاحية على هذا الفرع');
  return id;
}

/**
 * قارئ آمن لسجل واحد: يمنع تسريب البيانات بين الجهات نهائياً.
 * أي محاولة قراءة سجل من مستأجر آخر تُعامل كـ "غير موجود".
 */
export function findScoped(ctx, table, id, { branchCheck = false } = {}) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(id, ctx.tenantId);
  if (!row) return null;
  if (branchCheck && row.branch_id != null && !ctx.allBranches && !(ctx.branchIds || []).includes(row.branch_id)) return null;
  return row;
}

/** الفصل الحالي للجهة */
export function currentTerm(tenantId) {
  return db.prepare(`SELECT * FROM terms WHERE tenant_id=? AND is_current=1`).get(tenantId)
    || db.prepare(`SELECT * FROM terms WHERE tenant_id=? AND status='open' ORDER BY start_date DESC LIMIT 1`).get(tenantId)
    || null;
}

/** هل الفصل مغلق؟ (تجميد البند ٣) */
export function termIsClosed(tenantId, termId) {
  if (!termId) return false;
  const t = db.prepare('SELECT status FROM terms WHERE id=? AND tenant_id=?').get(termId, tenantId);
  return !!t && ['closed', 'archived'].includes(t.status);
}

/** ترقيم تسلسلي لكل جهة */
export function nextNumber(tenantId, table, prefix, column = 'number') {
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id=?`).get(tenantId);
  return `${prefix}-${String(1000 + row.c + 1)}`;
}
