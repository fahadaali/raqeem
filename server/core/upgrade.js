/**
 * مُوفِّق المخطط — يضيف الأعمدة المستجدّة إلى قواعد البيانات القائمة.
 *
 * جُمَل CREATE TABLE في المخطط تُنشئ الجداول الجديدة فقط ولا تمسّ جدولاً موجوداً،
 * فالقواعد التي أُنشئت قبل هذه التوسعات تحتاج ALTER صريحاً. هذه الدالة تقرأ الأعمدة
 * الفعلية وتضيف الناقص منها فقط — فتعمل على SQLite و D1 معاً، وتُستدعى مع كل ترحيل
 * فتكون آمنة التكرار.
 */
const ADDITIONS = [
  /* ── طبقة الـ SaaS ── */
  ['tenants', 'custom_domain',      'TEXT'],
  ['tenants', 'owner_email',        'TEXT'],
  ['tenants', 'suspended_at',       'TEXT'],
  ['tenants', 'suspend_reason',     'TEXT'],
  ['users',   'is_platform_admin',  'INTEGER NOT NULL DEFAULT 0'],

  /* ── متابعة تجارية وتجاوزات وحدود خاصة ── */
  ['tenants', 'contact_name',       'TEXT'],
  ['tenants', 'contact_phone',      'TEXT'],
  ['tenants', 'crm_stage',          'TEXT'],
  ['tenants', 'crm_source',         'TEXT'],
  ['tenants', 'limit_overrides',    "TEXT NOT NULL DEFAULT '{}'"],
  ['tenants', 'feature_overrides',  "TEXT NOT NULL DEFAULT '{}'"],
  ['tenants', 'billing_entity',     "TEXT NOT NULL DEFAULT '{}'"],

  /* ── تحقّق بخطوتين ── */
  ['users',   'totp_secret',        'TEXT'],
  ['users',   'totp_enabled',       'INTEGER NOT NULL DEFAULT 0'],
  ['users',   'totp_backup',        'TEXT'],

  /* ── الاشتراك: رصيد التناسب والكوبون ── */
  ['subscriptions', 'credit_balance', 'REAL NOT NULL DEFAULT 0'],
  ['subscriptions', 'coupon_id',      'INTEGER'],
  ['subscriptions', 'coupon_until',   'TEXT'],

  /* ── الفواتير: إشعار دائن، تناسب، كوبون، أمر شراء، ZATCA ── */
  ['subscription_invoices', 'doc_type',        "TEXT NOT NULL DEFAULT 'invoice'"],
  ['subscription_invoices', 'parent_id',       'INTEGER'],
  ['subscription_invoices', 'credit_applied',  'REAL NOT NULL DEFAULT 0'],
  ['subscription_invoices', 'proration',       'TEXT'],
  ['subscription_invoices', 'coupon_code',     'TEXT'],
  ['subscription_invoices', 'po_number',       'TEXT'],
  ['subscription_invoices', 'buyer',           "TEXT NOT NULL DEFAULT '{}'"],
  ['subscription_invoices', 'zatca_uuid',      'TEXT'],
  ['subscription_invoices', 'zatca_qr',        'TEXT'],
  ['subscription_invoices', 'zatca_hash',      'TEXT'],
  ['subscription_invoices', 'zatca_prev_hash', 'TEXT'],
  ['subscription_invoices', 'zatca_xml_key',   'TEXT'],

  /* ── المدفوعات: بوابة الدفع ── */
  ['subscription_payments', 'gateway',        'TEXT'],
  ['subscription_payments', 'gateway_ref',    'TEXT'],
  ['subscription_payments', 'gateway_status', 'TEXT'],

  /* ── التذاكر: تصعيد إلى مزوّد المنصة ── */
  ['tickets', 'vendor_escalated',    'INTEGER NOT NULL DEFAULT 0'],
  ['tickets', 'vendor_escalated_at', 'TEXT'],
  ['tickets', 'vendor_status',       'TEXT'],
  ['tickets', 'vendor_reply',        'TEXT'],
  ['tickets', 'vendor_replied_at',   'TEXT'],

  /* ── إعدادات المنصة ── */
  ['platform_settings', 'seller_address',     "TEXT NOT NULL DEFAULT '{}'"],
  ['platform_settings', 'zatca_enabled',      'INTEGER NOT NULL DEFAULT 0'],
  ['platform_settings', 'payment_gateway',    "TEXT NOT NULL DEFAULT 'manual'"],
  ['platform_settings', 'gateway_config',     "TEXT NOT NULL DEFAULT '{}'"],
  ['platform_settings', 'require_2fa_admins', 'INTEGER NOT NULL DEFAULT 0'],
  ['platform_settings', 'health_idle_days',   'INTEGER NOT NULL DEFAULT 14'],
  ['platform_settings', 'upsell_threshold',   'INTEGER NOT NULL DEFAULT 80']
];

export async function reconcileColumns(app) {
  const added = [];
  for (const [table, column, type] of ADDITIONS) {
    let cols;
    try { cols = await app.db.all(`PRAGMA table_info(${table})`); } catch { continue; }
    if (!cols.length || cols.some(c => c.name === column)) continue;
    try {
      await app.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      added.push(`${table}.${column}`);
    } catch (e) {
      /* عمود أضافه ترحيل متزامن آخر — نتجاهله */
      if (!String(e.message).includes('duplicate column')) throw e;
    }
  }
  return added;
}

/** فهارس تُنشأ بعد إضافة الأعمدة (لا يمكن إنشاؤها داخل جملة ALTER) */
export async function reconcileIndexes(app) {
  const stmts = [
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_domain ON tenants(custom_domain)',
    'CREATE INDEX IF NOT EXISTS ix_users_platform ON users(is_platform_admin)',
    'CREATE INDEX IF NOT EXISTS ix_tickets_vendor ON tickets(vendor_escalated, vendor_status)',
    'CREATE INDEX IF NOT EXISTS ix_subinv_doctype ON subscription_invoices(doc_type, tenant_id)'
  ];
  for (const sql of stmts) { try { await app.db.run(sql); } catch { /* موجود مسبقاً */ } }
}

export async function upgradeSchema(app) {
  const added = await reconcileColumns(app);
  await reconcileIndexes(app);
  return added;
}
