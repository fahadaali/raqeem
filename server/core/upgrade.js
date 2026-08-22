/**
 * مُوفِّق المخطط — يضيف الأعمدة المستجدّة إلى قواعد البيانات القائمة.
 *
 * جُمَل CREATE TABLE في المخطط تُنشئ الجداول الجديدة فقط ولا تمسّ جدولاً موجوداً،
 * فالقواعد التي أُنشئت قبل إضافة طبقة الـ SaaS تحتاج ALTER صريحاً. هذه الدالة
 * تقرأ الأعمدة الفعلية وتضيف الناقص منها فقط — فتعمل على SQLite و D1 معاً،
 * وتُستدعى مع كل ترحيل فتكون آمنة التكرار.
 */
const ADDITIONS = [
  ['tenants', 'custom_domain',     'TEXT'],
  ['tenants', 'owner_email',       'TEXT'],
  ['tenants', 'suspended_at',      'TEXT'],
  ['tenants', 'suspend_reason',    'TEXT'],
  ['users',   'is_platform_admin', 'INTEGER NOT NULL DEFAULT 0']
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
    'CREATE INDEX IF NOT EXISTS ix_users_platform ON users(is_platform_admin)'
  ];
  for (const sql of stmts) { try { await app.db.run(sql); } catch { /* موجود مسبقاً */ } }
}

export async function upgradeSchema(app) {
  const added = await reconcileColumns(app);
  await reconcileIndexes(app);
  return added;
}
