import { j } from './sql.js';
import { forbidden } from './errors.js';

/**
 * تفعيل مزايا الخطط (المستوى ١).
 *
 * كانت قائمة `plans.features` تُعرض في صفحة الأسعار ولا تُفحص في أي مسار،
 * فتَعِد الخطة بما لا تمنعه. هذه الوحدة تجعل الوعد نافذاً: كل ميزة لها حارس
 * يُركّب على مسارات وحدتها، ويحترم تجاوزات الجهة الخاصة (صفقات مخصّصة).
 *
 * قاعدة مقصودة: خطة بلا قائمة مزايا = كل شيء متاح (الخطة المؤسسية)،
 * حتى لا يكسر تشغيل الطبقة أيَّ جهة قائمة.
 */

export const FEATURES = [
  { key: 'tasks',         label: 'المهام واللجان',        module: 'العمل التشغيلي' },
  { key: 'attendance',    label: 'الحضور والتحضير الذكي', module: 'الموارد البشرية' },
  { key: 'payroll',       label: 'مسير الرواتب',           module: 'الموارد البشرية' },
  { key: 'finance',       label: 'الدورة المالية والاعتمادات', module: 'المالية' },
  { key: 'forms',         label: 'منشئ النماذج والتقييم',  module: 'الجودة' },
  { key: 'kpi',           label: 'مؤشرات الأداء',          module: 'الجودة' },
  { key: 'tickets',       label: 'مركز التذاكر والدعم',    module: 'التواصل' },
  { key: 'chat',          label: 'المحادثات السياقية',     module: 'التواصل' },
  { key: 'imports',       label: 'الاستيراد الجماعي',      module: 'البيانات' },
  { key: 'reports',       label: 'التقارير والتصدير',      module: 'البيانات' },
  { key: 'api',           label: 'الواجهات البرمجية ومفاتيح الربط', module: 'التكامل' },
  { key: 'notifications', label: 'الإشعارات ودفع الجوال',  module: 'التواصل' },
  { key: 'branding',      label: 'النطاق المخصّص والهوية الكاملة', module: 'التكامل' }
];

export const FEATURE_LABEL = Object.fromEntries(FEATURES.map(f => [f.key, f.label]));
const KNOWN = new Set(FEATURES.map(f => f.key));

/**
 * المزايا النافذة فعلياً لجهة = مزايا خطتها، معدَّلة بتجاوزاتها.
 * التجاوزات كائن {ميزة: true|false} يضبطه مالك المنصة لكل جهة على حدة.
 */
export function effectiveFeatures(plan, tenant) {
  const listed = j(plan?.features, []) || [];
  const base = listed.length ? new Set(listed) : new Set(KNOWN);   // قائمة فارغة = بلا حدود
  const overrides = j(tenant?.feature_overrides, {}) || {};
  for (const [key, on] of Object.entries(overrides)) {
    if (!KNOWN.has(key)) continue;
    if (on) base.add(key); else base.delete(key);
  }
  return [...base];
}

export const hasFeature = (features, key) => !key || features.includes(key);

/**
 * حارس مسار: يمنع الوحدات غير المشمولة بخطة الجهة.
 * يُركَّب على مستوى الوحدة في app.js فلا يتكرر في كل مسار.
 */
export const requireFeature = (key) => async (c, next) => {
  const ctx = c.get('ctx');
  if (!ctx || ctx.isPlatformAdmin) return next();
  /* الجهات بلا اشتراك (وضع المستأجر الواحد) لا تُقيَّد */
  if (!ctx.features) return next();
  if (hasFeature(ctx.features, key)) return next();
  throw forbidden(
    `«${FEATURE_LABEL[key] || key}» غير مشمولة في خطة «${ctx.planName || 'الحالية'}» — رقِّ الخطة لتفعيلها`,
    { code: 'FEATURE_LOCKED', feature: key, plan: ctx.planCode });
};
