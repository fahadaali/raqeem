import { j } from './sql.js';
import { platformSettings, planPrice, effectiveLimits } from './billing.js';

/**
 * صحة الجهات وفرص النمو (المستوى ٢).
 *
 * الاشتراك يُلغى قبل إلغائه بأسابيع: تقلّ الاستخدامات، يغيب المدير، تُهجر الوحدات.
 * هذه الوحدة تقرأ ما هو موجود أصلاً (آخر دخول، سجل النشاطات، الاستهلاك) وتحوّله
 * إلى مؤشّر صحة وقائمة مخاطر — فيُعالَج التسرّب قبل وقوعه لا بعده.
 *
 * الدرجة من ١٠٠ وتتألف من أربعة أرباع متساوية الوزن:
 *   النشاط الحديث · تبنّي المستخدمين · اتساع الاستخدام · انتظام السداد
 */

const DAY = 86400000;
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);

export const RISK_AR = { healthy: 'سليمة', watch: 'تحت المراقبة', at_risk: 'معرّضة للتسرّب', critical: 'حرجة' };

/** يجمع الإشارات الخام لكل جهة في استعلامات قليلة بدل استعلام لكل جهة */
async function collectSignals(app, { tenantId = null } = {}) {
  const where = tenantId ? 'WHERE t.id = ?' : '';
  const p = tenantId ? [tenantId] : [];
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();

  return app.db.all(
    `SELECT t.id, t.name, t.code, t.status, t.created_at, t.owner_email, t.crm_stage,
            t.limit_overrides, t.feature_overrides,
            s.status AS sub_status, s.cycle, s.trial_ends_at, s.current_period_end,
            s.cancel_at_period_end, s.credit_balance,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
            p.price_monthly, p.price_yearly, p.features AS plan_features,
            p.max_branches, p.max_users, p.max_storage_mb,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.status='active') AS users,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.status='active'
               AND u.last_login_at >= '${since30}') AS users_active_30d,
            (SELECT COUNT(*) FROM branches b WHERE b.tenant_id=t.id AND b.is_active=1) AS branches,
            (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.tenant_id=t.id) AS storage_bytes,
            (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.tenant_id=t.id) AS last_activity,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.tenant_id=t.id AND a.created_at >= '${since7}') AS events_7d,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.tenant_id=t.id AND a.created_at >= '${since30}') AS events_30d,
            (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id=t.id) AS last_login,
            (SELECT COUNT(*) FROM tasks k WHERE k.tenant_id=t.id) AS tasks,
            (SELECT COUNT(*) FROM finance_requests fr WHERE fr.tenant_id=t.id) AS finance_requests,
            (SELECT COUNT(*) FROM forms ft WHERE ft.tenant_id=t.id) AS forms,
            (SELECT COUNT(*) FROM tickets tk WHERE tk.tenant_id=t.id) AS tickets,
            (SELECT COUNT(*) FROM attendance at2 WHERE at2.tenant_id=t.id) AS attendance,
            (SELECT COUNT(*) FROM subscription_invoices i WHERE i.tenant_id=t.id AND i.status='open') AS open_invoices,
            (SELECT COALESCE(SUM(i.total),0) FROM subscription_invoices i WHERE i.tenant_id=t.id AND i.status='open') AS due,
            (SELECT COUNT(*) FROM subscription_invoices i WHERE i.tenant_id=t.id AND i.status='paid') AS paid_invoices
     FROM tenants t
     LEFT JOIN subscriptions s ON s.tenant_id = t.id
     LEFT JOIN plans p ON p.id = s.plan_id
     ${where} ORDER BY t.id`, ...p);
}

/* الوحدات التي يُقاس تبنّيها */
const ADOPTION = [
  { key: 'tasks', field: 'tasks', label: 'المهام' },
  { key: 'attendance', field: 'attendance', label: 'الحضور' },
  { key: 'finance', field: 'finance_requests', label: 'المالية' },
  { key: 'forms', field: 'forms', label: 'النماذج' },
  { key: 'tickets', field: 'tickets', label: 'الدعم' }
];

/** يحوّل إشارات جهة إلى درجة صحة مفصّلة */
export function scoreTenant(row, settings) {
  const idleDays = settings?.health_idle_days ?? 14;
  const lastActivityDays = daysSince(row.last_activity);
  const lastLoginDays = daysSince(row.last_login);
  const ageDays = daysSince(row.created_at) ?? 0;

  /* ① النشاط الحديث */
  let activity = 0;
  if (lastActivityDays === null) activity = 0;
  else if (lastActivityDays <= 1) activity = 100;
  else if (lastActivityDays <= 3) activity = 88;
  else if (lastActivityDays <= 7) activity = 72;
  else if (lastActivityDays <= idleDays) activity = 48;
  else if (lastActivityDays <= idleDays * 2) activity = 22;
  else activity = 5;

  /* ② تبنّي المستخدمين: نسبة من دخل خلال ٣٠ يوماً */
  const adoption = row.users ? clamp(Math.round((row.users_active_30d / row.users) * 100)) : 0;

  /* ③ اتساع الاستخدام: كم وحدة تعمل فعلاً من المتاحة في الخطة */
  const available = ADOPTION.filter(m => {
    const listed = j(row.plan_features, []) || [];
    return !listed.length || listed.includes(m.key);
  });
  const used = available.filter(m => Number(row[m.field] || 0) > 0);
  const breadth = available.length ? clamp(Math.round((used.length / available.length) * 100)) : 100;

  /* ④ انتظام السداد */
  let billing = 100;
  if (row.sub_status === 'past_due') billing = 40;
  if (row.sub_status === 'canceled' || row.sub_status === 'expired') billing = 10;
  if (row.cancel_at_period_end) billing = Math.min(billing, 35);
  if (Number(row.open_invoices || 0) > 1) billing = Math.min(billing, 25);
  if (row.status === 'suspended') billing = 0;

  const score = Math.round(activity * 0.35 + adoption * 0.25 + breadth * 0.2 + billing * 0.2);

  /* أسباب مقروءة تشرح الدرجة */
  const reasons = [];
  if (lastActivityDays === null) reasons.push('لا يوجد أي نشاط منذ الإنشاء');
  else if (lastActivityDays > idleDays) reasons.push(`آخر نشاط قبل ${lastActivityDays} يوماً`);
  if (row.users > 1 && adoption < 40) reasons.push(`${row.users_active_30d} من ${row.users} مستخدماً فقط دخلوا خلال شهر`);
  if (breadth < 40) reasons.push(`تستخدم ${used.length} وحدة من ${available.length} متاحة في خطتها`);
  if (row.cancel_at_period_end) reasons.push('أوقفت التجديد التلقائي');
  if (row.sub_status === 'past_due') reasons.push(`فاتورة مستحقة (${Number(row.due || 0)})`);
  if (row.status === 'suspended') reasons.push('الجهة موقوفة إدارياً');
  if (row.sub_status === 'trialing' && row.trial_ends_at) {
    const left = Math.ceil((new Date(row.trial_ends_at) - Date.now()) / DAY);
    if (left <= 3) reasons.push(`الفترة التجريبية تنتهي خلال ${Math.max(0, left)} أيام`);
  }
  if (ageDays <= 7 && Number(row.events_7d || 0) < 5) reasons.push('جهة جديدة لم تُكمل التهيئة بعد');

  const risk = score >= 70 ? 'healthy' : score >= 50 ? 'watch' : score >= 30 ? 'at_risk' : 'critical';

  return {
    score, risk, risk_label: RISK_AR[risk],
    parts: { activity, adoption, breadth, billing },
    reasons,
    last_activity_days: lastActivityDays,
    last_login_days: lastLoginDays,
    age_days: ageDays,
    modules_used: used.map(m => m.label),
    modules_available: available.map(m => m.label)
  };
}

/** فرصة ترقية إن اقترب الاستهلاك من حدود الخطة */
export function upsellFor(row, settings) {
  const threshold = settings?.upsell_threshold ?? 80;
  const limits = effectiveLimits(
    { max_branches: row.max_branches, max_users: row.max_users, max_storage_mb: row.max_storage_mb },
    { limit_overrides: row.limit_overrides });

  const usage = {
    branches: Number(row.branches || 0),
    users: Number(row.users || 0),
    storage_mb: Math.round((Number(row.storage_bytes || 0) / 1048576) * 100) / 100
  };
  const AR = { branches: 'الفروع', users: 'المستخدمون', storage_mb: 'التخزين' };

  const pressure = Object.entries(limits)
    .filter(([, limit]) => limit !== null && limit !== undefined && limit > 0)
    .map(([key, limit]) => ({
      resource: key, label: AR[key], limit, used: usage[key],
      percent: Math.round((usage[key] / limit) * 100)
    }))
    .filter(x => x.percent >= threshold)
    .sort((a, b) => b.percent - a.percent);

  if (!pressure.length) return null;
  return {
    threshold,
    at: pressure[0].percent,
    resources: pressure,
    plan: row.plan_code,
    monthly_value: planPrice(
      { price_monthly: row.price_monthly, price_yearly: row.price_yearly }, row.cycle || 'monthly')
  };
}

/** لوحة صحة كل الجهات: الدرجات، قائمة الخطر، وفرص الترقية */
export async function tenantsHealth(app, { tenantId = null } = {}) {
  const settings = await platformSettings(app);
  const rows = await collectSignals(app, { tenantId });

  const items = rows.map(row => {
    const health = scoreTenant(row, settings);
    const upsell = upsellFor(row, settings);
    return {
      id: row.id, name: row.name, code: row.code, status: row.status,
      plan_code: row.plan_code, plan_name: row.plan_name,
      sub_status: row.sub_status, cancel_at_period_end: !!row.cancel_at_period_end,
      trial_ends_at: row.trial_ends_at, current_period_end: row.current_period_end,
      owner_email: row.owner_email, crm_stage: row.crm_stage,
      users: row.users, users_active_30d: row.users_active_30d,
      branches: row.branches,
      storage_mb: Math.round((Number(row.storage_bytes || 0) / 1048576) * 100) / 100,
      events_7d: row.events_7d, events_30d: row.events_30d,
      last_activity: row.last_activity, last_login: row.last_login,
      due: Number(row.due || 0), open_invoices: row.open_invoices,
      health, upsell
    };
  });

  const byRisk = { healthy: 0, watch: 0, at_risk: 0, critical: 0 };
  for (const t of items) byRisk[t.health.risk]++;

  const upsells = items.filter(t => t.upsell)
    .sort((a, b) => b.upsell.at - a.upsell.at);

  return {
    settings: { idle_days: settings.health_idle_days, upsell_threshold: settings.upsell_threshold },
    summary: {
      total: items.length,
      by_risk: byRisk,
      average_score: items.length ? Math.round(items.reduce((s, t) => s + t.health.score, 0) / items.length) : 0,
      upsell_opportunities: upsells.length,
      upsell_value: Math.round(upsells.reduce((s, t) => s + (t.upsell.monthly_value || 0), 0) * 100) / 100
    },
    items: items.sort((a, b) => a.health.score - b.health.score),
    at_risk: items.filter(t => ['at_risk', 'critical'].includes(t.health.risk)),
    upsells
  };
}

/** صحة جهة واحدة — تُدمج في شاشة تفاصيل الجهة */
export async function tenantHealth(app, tenantId) {
  const out = await tenantsHealth(app, { tenantId });
  return out.items[0] || null;
}
