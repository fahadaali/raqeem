import { nowUTC } from '../sql.js';
import { forbidden, subscriptionInactive } from '../errors.js';
import { tenantSubscription, subscriptionWritable, subscriptionBlockReason } from '../billing.js';

/**
 * حرّاس طبقة الـ SaaS (المرحلة الثانية).
 *
 * القاعدة الحاكمة: المنصة لا تحجب بيانات جهة ولا تمحوها بسبب الاشتراك —
 * توقف الكتابة فقط. القراءة والتصدير وشاشة السداد تبقى مفتوحة في كل الحالات
 * (إيقاف إداري، انتهاء تجربة، تأخر سداد)، والمحو لا يقع إلا بأمر صريح
 * من مالك المنصة مع تأكيد رمز الجهة.
 */

/** لوحة تحكم مالك المنصة — لا تكفي فيها صلاحية «مدير الجهة» */
export const platformAdmin = () => async (c, next) => {
  const ctx = c.get('ctx');
  if (!ctx?.isPlatformAdmin) {
    throw forbidden('هذه اللوحة مخصّصة لمالك المنصة فقط');
  }
  return next();
};

/* المسارات التي تبقى مفتوحة حتى مع توقف الاشتراك (السداد والخروج والقراءة) */
const ALWAYS_OPEN = [
  /^\/api\/auth\//,
  /^\/api\/billing\//,
  /^\/api\/notifications\/read$/,
  /^\/api\/platform\//
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * بوابة الاشتراك: تمنع الكتابة عند توقف الاشتراك وتترك القراءة والسداد يعملان.
 * لا تُطبَّق على مالك المنصة حتى يستطيع الإصلاح والمساندة.
 */
export const subscriptionGate = () => async (c, next) => {
  const app = c.get('app');
  const ctx = c.get('ctx');
  const req = c.get('request');
  if (!ctx || ctx.isPlatformAdmin) return next();

  /* القراءة والسداد مفتوحان دائماً — لا تُحجب بيانات جهة بسبب اشتراكها */
  if (READ_METHODS.has(req.method)) return next();
  if (ALWAYS_OPEN.some(re => re.test(req.path))) return next();

  /* الجهة الموقوفة إدارياً: تصبح للقراءة فقط */
  if (ctx.tenantStatus === 'suspended') {
    throw subscriptionInactive(ctx.tenantSuspendReason
      ? `حساب الجهة موقوف: ${ctx.tenantSuspendReason} — المنصة للقراءة فقط حتى إعادة التفعيل`
      : 'حساب الجهة موقوف — المنصة للقراءة فقط، يرجى التواصل مع إدارة المنصة');
  }

  const sub = await tenantSubscription(app, ctx.tenantId);
  if (subscriptionWritable(sub)) {
    ctx.subscription = sub;
    return next();
  }
  throw subscriptionInactive(subscriptionBlockReason(sub), {
    status: sub?.status, plan: sub?.plan?.code,
    period_end: sub?.current_period_end, checked_at: nowUTC()
  });
};
