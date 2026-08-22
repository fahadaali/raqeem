import { nowUTC } from './sql.js';
import { platformSettings, startSubscription } from './billing.js';

/**
 * تعبئة طبقة الـ SaaS (المرحلة الثانية): خطط الأسعار وإعدادات المنصة.
 * تعمل مستقلةً عن بيانات الجهة رقم ١ حتى يمكن تشغيلها على قاعدة قائمة.
 *
 * ملاحظة مقصودة: تبقى `saas_enabled = 0` افتراضياً، فالمنصة تُشغَّل بواجهات
 * أحادية المستأجر كما تشترط المرحلة الأولى، ولا تظهر صفحات الأسعار والتسجيل
 * إلا عندما يفتحها مالك المنصة من لوحته.
 */

export const DEFAULT_PLANS = [
  {
    code: 'starter', name: 'الأساسية', name_en: 'Starter',
    tagline: 'لحلقة أو مجمّع صغير يبدأ رحلته الرقمية',
    description: 'كل الأساسيات: المهام والحضور والتقارير لفرع واحد.',
    price_monthly: 0, price_yearly: 0, trial_days: 0,
    max_branches: 1, max_users: 15, max_storage_mb: 512,
    features: ['tasks', 'attendance', 'reports', 'notifications'],
    perks: ['فرع واحد', 'حتى ١٥ مستخدماً', '٥١٢ ميجابايت تخزين',
      'المهام واللجان', 'التحضير الذكي بالموقع', 'التقارير والتصدير', 'مجانية دائماً'],
    is_public: 1, highlight: 0, sort: 1
  },
  {
    code: 'growth', name: 'النمو', name_en: 'Growth',
    tagline: 'الخيار الأنسب لمجمّع متعدد الفروع واللجان',
    description: 'كل مزايا المنصة مع الدورة المالية والتقييم ومركز الدعم.',
    price_monthly: 499, price_yearly: 4990, trial_days: 14,
    max_branches: 8, max_users: 120, max_storage_mb: 10240,
    features: ['tasks', 'attendance', 'reports', 'notifications', 'finance', 'forms', 'kpi', 'tickets', 'imports'],
    perks: ['حتى ٨ فروع', 'حتى ١٢٠ مستخدماً', '١٠ جيجابايت تخزين',
      'الدورة المالية والاعتمادات', 'منشئ النماذج ومؤشرات الأداء', 'مركز التذاكر واتفاقية مستوى الخدمة',
      'الاستيراد الجماعي', 'شهران مجاناً في الاشتراك السنوي'],
    is_public: 1, highlight: 1, sort: 2
  },
  {
    code: 'enterprise', name: 'المؤسسية', name_en: 'Enterprise',
    tagline: 'للجهات الكبرى والأوقاف متعددة المجمعات',
    description: 'بلا حدود، مع الواجهات البرمجية والنطاق المخصّص والدعم المخصّص.',
    price_monthly: 1499, price_yearly: 14990, trial_days: 14,
    max_branches: null, max_users: null, max_storage_mb: null,
    features: [],
    perks: ['فروع ومستخدمون بلا حدود', 'تخزين بلا حدود', 'الواجهات البرمجية ومفاتيح الربط',
      'نطاق مخصّص وهوية بصرية كاملة', 'سجل تدقيق وامتثال موسّع', 'دعم مخصّص وأولوية استجابة'],
    is_public: 1, highlight: 0, sort: 3
  }
];

const PLAN_COLS = ['code', 'name', 'name_en', 'tagline', 'description', 'price_monthly', 'price_yearly',
  'currency', 'trial_days', 'max_branches', 'max_users', 'max_storage_mb', 'features', 'perks',
  'is_public', 'is_active', 'highlight', 'sort'];

export async function seedSaaS(app, { tenantOneOwnerEmail = 'admin@riyadh-qu.sa' } = {}) {
  const db = app.db;

  /* ── الخطط ── */
  await db.batch(DEFAULT_PLANS.map(p => [
    `INSERT INTO plans(${PLAN_COLS.join(',')}) VALUES(${PLAN_COLS.map(() => '?').join(',')})
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name, name_en=excluded.name_en, tagline=excluded.tagline,
       description=excluded.description, price_monthly=excluded.price_monthly,
       price_yearly=excluded.price_yearly, trial_days=excluded.trial_days,
       max_branches=excluded.max_branches, max_users=excluded.max_users,
       max_storage_mb=excluded.max_storage_mb, features=excluded.features, perks=excluded.perks,
       is_public=excluded.is_public, highlight=excluded.highlight, sort=excluded.sort`,
    [p.code, p.name, p.name_en, p.tagline, p.description, p.price_monthly, p.price_yearly,
      'SAR', p.trial_days, p.max_branches, p.max_users, p.max_storage_mb,
      JSON.stringify(p.features), JSON.stringify(p.perks), p.is_public, 1, p.highlight, p.sort]
  ]));

  /* ── إعدادات المنصة (تُنشأ بقيمها الافتراضية) ── */
  const settings = await platformSettings(app);
  await db.run(
    `UPDATE platform_settings SET bank_details=?, vat_number=?, cr_number=?, updated_at=? WHERE id=1`,
    JSON.stringify({
      bank: 'مصرف الراجحي', beneficiary: 'شركة نور لتقنية المعلومات',
      iban: 'SA0000000000000000000000', note: 'يرجى كتابة رقم الفاتورة في خانة الوصف'
    }),
    settings.vat_number || '300000000000003', settings.cr_number || '1010000000', nowUTC());

  /* ── الجهة رقم ١: مديرها هو مالك المنصة في هذه المرحلة ── */
  const owner = await db.get('SELECT id, tenant_id FROM users WHERE lower(email)=lower(?)', tenantOneOwnerEmail);
  if (owner) await db.run('UPDATE users SET is_platform_admin=1 WHERE id=?', owner.id);

  /* ── الجهة رقم ١ على الخطة المؤسسية بلا حدود ولا فوترة ── */
  const t1 = await db.get('SELECT id FROM tenants WHERE id=1');
  if (t1) {
    const existing = await db.get('SELECT id FROM subscriptions WHERE tenant_id=1');
    if (!existing) {
      await startSubscription(app, 1, { planCode: 'enterprise', cycle: 'yearly', status: 'active' });
      await db.run(
        `UPDATE subscriptions SET notes='جهة التشغيل الأساسية — اشتراك داخلي بلا فوترة' WHERE tenant_id=1`);
    }
    await db.run('UPDATE tenants SET plan=?, owner_email=COALESCE(owner_email,?) WHERE id=1',
      'enterprise', tenantOneOwnerEmail);
  }

  return {
    plans: DEFAULT_PLANS.length,
    platform_admin: owner?.id || null,
    saas_enabled: !!(await platformSettings(app)).saas_enabled
  };
}
