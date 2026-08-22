import { forbidden } from './errors.js';

/**
 * طبقة العزل المنطقي (Global Query Scopes) — المقدمة الاستراتيجية §١
 * كل استعلام يمرّ عبر هذه الطبقة يُفلتر إلزامياً بـ tenant_id،
 * ثم بـ branch_id بحسب الفروع المصرّح بها للمستخدم (جدول التقاطعات).
 */
export function scoped(ctx, { table = '', alias = '', branchColumn = 'branch_id', respectBranch = true } = {}) {
  const p = alias ? `${alias}.` : (table ? `${table}.` : '');
  const clauses = [`${p}tenant_id = ?`];
  const params = [ctx.tenantId];

  if (respectBranch && !ctx.allBranches) {
    const ids = ctx.branchIds || [];
    if (ids.length === 0) clauses.push('1 = 0');
    else {
      clauses.push(`(${p}${branchColumn} IS NULL OR ${p}${branchColumn} IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
  }
  return { where: clauses.join(' AND '), params };
}

/** تحقق أن المستخدم مصرّح له بالفرع المطلوب */
export async function assertBranch(app, ctx, branchId) {
  if (branchId === null || branchId === undefined || branchId === '') return null;
  const id = Number(branchId);
  if (!Number.isFinite(id)) throw forbidden('معرّف الفرع غير صالح');
  if (ctx.allBranches) {
    const okRow = await app.db.get('SELECT 1 AS ok FROM branches WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!okRow) throw forbidden('الفرع غير موجود ضمن نطاق جهتك');
    return id;
  }
  if (!(ctx.branchIds || []).includes(id)) throw forbidden('ليست لديك صلاحية على هذا الفرع');
  return id;
}

/**
 * قارئ آمن لسجل واحد — يمنع تسريب البيانات بين الجهات نهائياً.
 * أي محاولة قراءة سجل من مستأجر آخر تُعامل كـ «غير موجود».
 */
export async function findScoped(app, ctx, table, id, { branchCheck = false } = {}) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('اسم جدول غير صالح');
  const row = await app.db.get(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`, id, ctx.tenantId);
  if (!row) return null;
  if (branchCheck && row.branch_id != null && !ctx.allBranches && !(ctx.branchIds || []).includes(row.branch_id)) return null;
  return row;
}

/** الفصل الحالي للجهة */
export async function currentTerm(app, tenantId) {
  return (await app.db.get('SELECT * FROM terms WHERE tenant_id=? AND is_current=1', tenantId))
    || (await app.db.get(`SELECT * FROM terms WHERE tenant_id=? AND status='open' ORDER BY start_date DESC LIMIT 1`, tenantId))
    || null;
}

/** هل الفصل مغلق؟ (تجميد البند ٣) */
export async function termIsClosed(app, tenantId, termId) {
  if (!termId) return false;
  const t = await app.db.get('SELECT status FROM terms WHERE id=? AND tenant_id=?', termId, tenantId);
  return !!t && ['closed', 'archived'].includes(t.status);
}

/** ترقيم تسلسلي لكل جهة */
export async function nextNumber(app, tenantId, table, prefix) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('اسم جدول غير صالح');
  const row = await app.db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id=?`, tenantId);
  return `${prefix}-${String(1000 + (row?.c || 0) + 1)}`;
}
