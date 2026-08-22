import { nowUTC } from '../sql.js';
import { platformSettings } from '../billing.js';

/**
 * لقطة يومية لمؤشرات المنصة (المستوى ١).
 *
 * الإيراد المتكرر كان رقماً لحظياً يُحسب عند فتح الشاشة، فلا يُعرف منه نموّ ولا
 * تسرّب. هذه الوظيفة تحفظ لقطة كل يوم فتصير المؤشرات سلسلة زمنية قابلة للمقارنة.
 * تعمل بمبدأ «تحديث لقطة اليوم» فتكرارها في اليوم نفسه لا يُنشئ صفوفاً مكرّرة.
 */

const COLS = ['date', 'tenants_total', 'tenants_active', 'tenants_suspended',
  'subs_trialing', 'subs_active', 'subs_past_due', 'subs_canceled', 'subs_expired',
  'mrr', 'arr', 'arpu', 'users_total', 'branches_total', 'storage_mb',
  'revenue_collected', 'outstanding_due', 'new_tenants', 'churned_tenants',
  'trials_converted', 'active_tenants_7d'];

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** يحسب لقطة اللحظة الراهنة دون حفظها */
export async function computeMetrics(app, { date = null } = {}) {
  const db = app.db;
  const day = date || new Date().toISOString().slice(0, 10);
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = `${day}T23:59:59.999Z`;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const one = async (sql, ...p) => Number((await db.get(sql, ...p))?.c ?? 0);

  const byStatus = await db.all('SELECT status, COUNT(*) AS c FROM tenants GROUP BY status');
  const tenants = Object.fromEntries(byStatus.map(r => [r.status, r.c]));
  const subs = Object.fromEntries(
    (await db.all('SELECT status, COUNT(*) AS c FROM subscriptions GROUP BY status')).map(r => [r.status, r.c]));

  const active = await db.all(
    `SELECT s.cycle, p.price_monthly, p.price_yearly FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','trialing')`);
  const mrr = round2(active.reduce((sum, r) =>
    sum + (r.cycle === 'yearly' ? Number(r.price_yearly || 0) / 12 : Number(r.price_monthly || 0)), 0));

  const paying = active.filter(r =>
    (r.cycle === 'yearly' ? Number(r.price_yearly) : Number(r.price_monthly)) > 0).length;

  const storage = Number((await db.get('SELECT COALESCE(SUM(size),0) AS s FROM files'))?.s || 0);

  return {
    date: day,
    tenants_total: Object.values(tenants).reduce((a, b) => a + b, 0),
    tenants_active: tenants.active || 0,
    tenants_suspended: tenants.suspended || 0,
    subs_trialing: subs.trialing || 0,
    subs_active: subs.active || 0,
    subs_past_due: subs.past_due || 0,
    subs_canceled: subs.canceled || 0,
    subs_expired: subs.expired || 0,
    mrr,
    arr: round2(mrr * 12),
    arpu: paying ? round2(mrr / paying) : 0,
    users_total: await one(`SELECT COUNT(*) AS c FROM users WHERE status='active'`),
    branches_total: await one('SELECT COUNT(*) AS c FROM branches WHERE is_active=1'),
    storage_mb: round2(storage / 1048576),
    revenue_collected: round2((await db.get(
      `SELECT COALESCE(SUM(total),0) AS c FROM subscription_invoices WHERE status='paid' AND doc_type='invoice'`))?.c),
    outstanding_due: round2((await db.get(
      `SELECT COALESCE(SUM(total),0) AS c FROM subscription_invoices WHERE status='open'`))?.c),
    new_tenants: await one('SELECT COUNT(*) AS c FROM tenants WHERE created_at BETWEEN ? AND ?', dayStart, dayEnd),
    churned_tenants: await one(
      `SELECT COUNT(*) AS c FROM subscriptions WHERE status IN ('canceled','expired')
        AND updated_at BETWEEN ? AND ?`, dayStart, dayEnd),
    trials_converted: await one(
      `SELECT COUNT(*) AS c FROM subscription_invoices
       WHERE notes LIKE '%الفترة التجريبية%' AND issued_at BETWEEN ? AND ?`, dayStart, dayEnd),
    active_tenants_7d: await one(
      'SELECT COUNT(DISTINCT tenant_id) AS c FROM audit_logs WHERE created_at >= ?', weekAgo)
  };
}

/** يحفظ لقطة اليوم (أو يحدّثها إن وُجدت) */
export async function snapshotMetrics(app, { date = null } = {}) {
  const m = await computeMetrics(app, { date });
  const values = COLS.map(c => m[c]);
  await app.db.run(
    `INSERT INTO platform_metrics(${COLS.join(',')}) VALUES(${COLS.map(() => '?').join(',')})
     ON CONFLICT(date) DO UPDATE SET ${COLS.filter(c => c !== 'date').map(c => `${c}=excluded.${c}`).join(', ')}`,
    ...values);
  return m;
}

/** سلسلة زمنية جاهزة للرسم مع دلتا الفترة */
export async function metricsSeries(app, { days = 30 } = {}) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await app.db.all(
    'SELECT * FROM platform_metrics WHERE date >= ? ORDER BY date', from);

  /* اللقطة الحيّة تُلحق دائماً حتى لا تبدو الشاشة قديمة قبل تشغيل المؤقّت */
  const today = await computeMetrics(app);
  const series = rows.filter(r => r.date !== today.date).concat([today]);

  const first = series[0] || today;
  const last = series[series.length - 1] || today;
  const delta = (key) => round2(Number(last[key] || 0) - Number(first[key] || 0));
  const growth = (key) => {
    const a = Number(first[key] || 0), b = Number(last[key] || 0);
    return a ? Math.round(((b - a) / a) * 1000) / 10 : (b ? 100 : 0);
  };

  /* معدل التسرّب: الجهات التي ألغت خلال الفترة ÷ الجهات في بدايتها */
  const churned = series.reduce((s, r) => s + Number(r.churned_tenants || 0), 0);
  const added = series.reduce((s, r) => s + Number(r.new_tenants || 0), 0);
  const startTenants = Number(first.tenants_total || 0);

  return {
    days, points: series,
    current: last,
    change: {
      mrr: delta('mrr'), mrr_growth: growth('mrr'),
      tenants: delta('tenants_total'), tenants_growth: growth('tenants_total'),
      users: delta('users_total'), storage_mb: delta('storage_mb'),
      new_tenants: added, churned_tenants: churned,
      churn_rate: startTenants ? Math.round((churned / startTenants) * 1000) / 10 : 0,
      trials_converted: series.reduce((s, r) => s + Number(r.trials_converted || 0), 0)
    }
  };
}

/** نسبة تحوّل التجارب إلى مدفوع خلال فترة */
export async function trialConversion(app, { days = 90 } = {}) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const started = Number((await app.db.get(
    `SELECT COUNT(*) AS c FROM subscriptions WHERE trial_ends_at IS NOT NULL AND created_at >= ?`, from))?.c || 0);
  const converted = Number((await app.db.get(
    `SELECT COUNT(DISTINCT s.tenant_id) AS c FROM subscriptions s
     JOIN subscription_invoices i ON i.tenant_id = s.tenant_id AND i.status='paid'
     WHERE s.trial_ends_at IS NOT NULL AND s.created_at >= ?`, from))?.c || 0);
  return { days, started, converted, rate: started ? Math.round((converted / started) * 1000) / 10 : 0 };
}

/** تنبؤ إيراد الشهر القادم من التجديدات المستحقة */
export async function revenueForecast(app) {
  const settings = await platformSettings(app);
  const until = new Date(Date.now() + 30 * 86400000).toISOString();
  const rows = await app.db.all(
    `SELECT s.cycle, s.cancel_at_period_end, p.price_monthly, p.price_yearly
     FROM subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.status IN ('active','trialing','past_due') AND s.current_period_end <= ?`, until);

  let expected = 0, atRisk = 0;
  for (const r of rows) {
    const amount = r.cycle === 'yearly' ? Number(r.price_yearly || 0) : Number(r.price_monthly || 0);
    if (r.cancel_at_period_end) atRisk += amount; else expected += amount;
  }
  const vat = settings.vat_rate / 100;
  return {
    renewals: rows.length,
    expected: round2(expected), expected_with_vat: round2(expected * (1 + vat)),
    at_risk: round2(atRisk)
  };
}
