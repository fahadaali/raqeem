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

  /* ── بطاقة تجهيز الجهة الجديدة ── */
  ['tenants', 'setup_dismissed_at', 'TEXT'],

  /* ── تخصيص الميزانية على مستوى اللجنة كما على مستوى الفرع ── */
  ['budgets', 'committee_id',    'INTEGER'],

  /* ── إغلاق العهد المالية ── */
  ['finance_requests', 'settle_status',  'TEXT'],
  ['finance_requests', 'settled_amount', 'REAL NOT NULL DEFAULT 0'],
  ['finance_requests', 'settle_note',    'TEXT'],
  ['finance_requests', 'settled_by',     'INTEGER'],
  ['finance_requests', 'settled_at',     'TEXT'],
  ['invoices',         'description',    'TEXT'],

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
  ['platform_settings', 'upsell_threshold',   'INTEGER NOT NULL DEFAULT 80'],
  ['platform_settings', 'landing',            "TEXT NOT NULL DEFAULT '{}'"]
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
    'CREATE INDEX IF NOT EXISTS ix_subinv_doctype ON subscription_invoices(doc_type, tenant_id)',
    'CREATE INDEX IF NOT EXISTS ix_budgets_scope ON budgets(tenant_id, branch_id, committee_id, term_id)'
  ];
  for (const sql of stmts) { try { await app.db.run(sql); } catch { /* موجود مسبقاً */ } }
}

/**
 * ترحيل مالكي المنصة من users إلى جدول الهويّة المستقل.
 *
 * تُنسخ تجزئة كلمة المرور كما هي فلا ينقطع دخول أحد، ثم يُصفَّر العلَم في users
 * فلا يبقى للمستأجر مستخدمٌ يحمل صلاحية منصة. العملية آمنة التكرار: تعتمد على
 * فهرس البريد الفريد، وتتخطّى ما نُقل سابقاً.
 */
export async function migratePlatformAdmins(app) {
  let legacy;
  try {
    legacy = await app.db.all(
      `SELECT id, name, email, password_hash, totp_secret, totp_enabled, totp_backup, last_login_at
       FROM users WHERE is_platform_admin = 1`);
  } catch { return { moved: 0 }; }
  if (!legacy?.length) return { moved: 0 };

  let moved = 0;
  for (const u of legacy) {
    const exists = await app.db.get(
      'SELECT id FROM platform_admins WHERE lower(email) = lower(?)', u.email);
    if (!exists) {
      await app.db.run(
        `INSERT INTO platform_admins(name,email,password_hash,status,
           totp_secret,totp_enabled,totp_backup,last_login_at)
         VALUES(?,?,?,'active',?,?,?,?)`,
        u.name, String(u.email).toLowerCase(), u.password_hash,
        u.totp_secret, u.totp_enabled || 0, u.totp_backup, u.last_login_at);
      moved++;
    }
    await app.db.run('UPDATE users SET is_platform_admin = 0 WHERE id = ?', u.id);
  }
  return { moved };
}

export async function upgradeSchema(app) {
  const added = await reconcileColumns(app);
  await reconcileIndexes(app);
  const admins = await migratePlatformAdmins(app).catch(() => ({ moved: 0 }));
  return admins.moved ? [...added, `platform_admins:+${admins.moved}`] : added;
}
