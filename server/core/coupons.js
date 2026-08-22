import { nowUTC, j } from './sql.js';
import { badRequest } from './errors.js';

/**
 * الكوبونات والخصومات الترويجية (المستوى ٤).
 *
 * الخصم يُطبَّق على المبلغ قبل الضريبة، والضريبة تُحسب على الصافي — كما يقتضي
 * نظام ضريبة القيمة المضافة. والكوبون قد يكون لمرة واحدة، أو لعدد شهور محدّد،
 * أو دائماً ما بقي الاشتراك.
 */

export const COUPON_TYPE_AR = { percent: 'نسبة مئوية', fixed: 'مبلغ ثابت' };
export const DURATION_AR = { once: 'مرة واحدة', months: 'عدة شهور', forever: 'دائم' };

export const normalizeCode = (raw) =>
  String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);

/** يتحقّق من صلاحية الكوبون لجهة وخطة معيّنتين */
export async function validateCoupon(app, code, { tenantId = null, planCode = null } = {}) {
  const c = await app.db.get('SELECT * FROM coupons WHERE code=?', normalizeCode(code));
  if (!c) return { valid: false, reason: 'الكوبون غير موجود' };
  if (!c.is_active) return { valid: false, reason: 'الكوبون معطّل' };

  const now = nowUTC();
  if (c.valid_from && c.valid_from > now) return { valid: false, reason: 'الكوبون لم يبدأ بعد' };
  if (c.valid_until && c.valid_until < now) return { valid: false, reason: 'انتهت صلاحية الكوبون' };
  if (c.max_redemptions && c.redemptions >= c.max_redemptions)
    return { valid: false, reason: 'استُنفد عدد مرات استخدام الكوبون' };

  const plans = j(c.applies_to, []) || [];
  if (plans.length && planCode && !plans.includes(planCode))
    return { valid: false, reason: 'الكوبون لا ينطبق على هذه الخطة' };

  if (tenantId) {
    const used = await app.db.get(
      'SELECT COUNT(*) AS c FROM coupon_redemptions WHERE coupon_id=? AND tenant_id=?', c.id, tenantId);
    if (c.duration === 'once' && used.c > 0)
      return { valid: false, reason: 'استخدمت الجهة هذا الكوبون مسبقاً' };
  }

  return { valid: true, coupon: { ...c, applies_to: plans } };
}

/** يربط كوبوناً باشتراك — يحدّد إلى متى يبقى ساري المفعول */
export async function attachCoupon(app, tenantId, coupon) {
  const sub = await app.db.get('SELECT * FROM subscriptions WHERE tenant_id=?', tenantId);
  if (!sub) throw badRequest('لا يوجد اشتراك لربط الكوبون به');

  let until = null;
  if (coupon.duration === 'months' && coupon.duration_months > 0) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + Number(coupon.duration_months));
    until = d.toISOString();
  } else if (coupon.duration === 'once') {
    until = sub.current_period_end;
  }
  await app.db.run('UPDATE subscriptions SET coupon_id=?, coupon_until=?, updated_at=? WHERE id=?',
    coupon.id, until, nowUTC(), sub.id);
  return { coupon_id: coupon.id, until };
}

export async function detachCoupon(app, tenantId) {
  await app.db.run('UPDATE subscriptions SET coupon_id=NULL, coupon_until=NULL, updated_at=? WHERE tenant_id=?',
    nowUTC(), tenantId);
  return { ok: true };
}

/** الكوبون الساري على اشتراك الآن (يراعي انتهاء المدة) */
export async function activeCoupon(app, sub) {
  if (!sub?.coupon_id) return null;
  if (sub.coupon_until && sub.coupon_until < nowUTC()) return null;
  const c = await app.db.get('SELECT * FROM coupons WHERE id=? AND is_active=1', sub.coupon_id);
  return c ? { ...c, applies_to: j(c.applies_to, []) || [] } : null;
}

/** تقرير أداء الكوبونات — كم استُخدم وكم كلّف */
export async function couponsReport(app) {
  return app.db.all(
    `SELECT c.*,
      (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id=c.id) AS uses,
      (SELECT COALESCE(SUM(r.amount_off),0) FROM coupon_redemptions r WHERE r.coupon_id=c.id) AS total_discount,
      (SELECT COUNT(DISTINCT r.tenant_id) FROM coupon_redemptions r WHERE r.coupon_id=c.id) AS tenants
     FROM coupons c ORDER BY c.id DESC`);
}
