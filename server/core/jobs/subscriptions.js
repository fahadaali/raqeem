import { nowUTC } from '../sql.js';
import { notifyByPermission } from '../notify.js';
import {
  platformSettings, issueInvoice, tenantSubscription, planPrice, periodEnd, addDays
} from '../billing.js';

/**
 * دورة حياة الاشتراكات (المرحلة الثانية) — تعمل يومياً من مؤقّت Cron:
 *   ١) الفترة التجريبية المنتهية  → فاتورة أولى وتحوّل إلى «متأخر السداد» بمهلة
 *   ٢) الفترة المدفوعة المنتهية   → تجديد وإصدار فاتورة الفترة التالية
 *   ٣) إيقاف التجديد المطلوب      → إنهاء الاشتراك في نهاية فترته
 *   ٤) الفواتير المتأخرة          → تذكير، ثم إيقاف الكتابة بعد انتهاء المهلة
 * كل تحوّل يُشعر أصحاب صلاحية الاشتراك في الجهة، ويُسجَّل في سجل المنصة.
 */

async function plog(app, { tenantId, action, entity, entityId, summary, meta = null }) {
  try {
    await app.db.run(
      `INSERT INTO platform_logs(actor_id,actor_name,tenant_id,action,entity,entity_id,summary,meta,ip,created_at)
       VALUES(NULL,'النظام',?,?,?,?,?,?,'system',?)`,
      tenantId, action, entity, entityId === null ? null : String(entityId), summary,
      meta ? JSON.stringify(meta) : null, nowUTC());
  } catch (e) { console.error('[platform-log]', e.message); }
}

const notify = (app, tenantId, n) =>
  notifyByPermission(app, tenantId, 'billing.view', { category: 'system', ...n }).catch(() => ({ created: 0 }));

/** ينهي الفترات التجريبية المنقضية ويصدر أول فاتورة */
export async function expireTrials(app) {
  const settings = await platformSettings(app);
  const due = await app.db.all(
    `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_monthly, p.price_yearly, t.name AS tenant_name
     FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN tenants t ON t.id=s.tenant_id
     WHERE s.status='trialing' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= ?`, nowUTC());

  let converted = 0, expired = 0;
  for (const row of due) {
    const sub = await tenantSubscription(app, row.tenant_id);
    if (!sub) continue;
    const price = planPrice(sub.plan, sub.cycle);

    if (price === 0) {
      await app.db.run(
        `UPDATE subscriptions SET status='active', current_period_start=?, current_period_end=?, updated_at=? WHERE id=?`,
        nowUTC(), periodEnd(nowUTC(), sub.cycle), nowUTC(), sub.id);
      converted++;
      continue;
    }

    if (sub.cancel_at_period_end) {
      await app.db.run(`UPDATE subscriptions SET status='expired', updated_at=? WHERE id=?`, nowUTC(), sub.id);
      await notify(app, row.tenant_id, {
        type: 'billing.expired', title: 'انتهت الفترة التجريبية',
        body: 'انتهت فترتك التجريبية ولم يُفعَّل التجديد — المنصة الآن للقراءة فقط.', url: '/billing', urgency: 'high'
      });
      await plog(app, { tenantId: row.tenant_id, action: 'update', entity: 'subscription', entityId: sub.id,
        summary: `انتهت الفترة التجريبية لجهة «${row.tenant_name}» دون تجديد` });
      expired++;
      continue;
    }

    const start = nowUTC();
    const end = periodEnd(start, sub.cycle);
    await app.db.run(
      `UPDATE subscriptions SET status='past_due', current_period_start=?, current_period_end=?,
        grace_until=?, updated_at=? WHERE id=?`,
      start, end, addDays(start, settings.grace_days), nowUTC(), sub.id);

    const inv = await issueInvoice(app, row.tenant_id, { ...sub, current_period_start: start, current_period_end: end },
      { note: 'أول فاتورة بعد الفترة التجريبية' });

    await notify(app, row.tenant_id, {
      type: 'billing.invoice', title: `فاتورة اشتراك جديدة ${inv.number}`,
      body: `انتهت فترتك التجريبية. المستحق ${inv.total} ${inv.currency} خلال ${settings.grace_days} أيام.`,
      url: '/billing', urgency: 'high'
    });
    await plog(app, { tenantId: row.tenant_id, action: 'create', entity: 'subscription_invoice', entityId: inv.id,
      summary: `انتهت الفترة التجريبية لجهة «${row.tenant_name}» وصدرت الفاتورة ${inv.number}`,
      meta: { total: inv.total } });
    converted++;
  }
  return { converted, expired, checked: due.length };
}

/** يجدّد الفترات المنقضية ويصدر فواتيرها */
export async function renewSubscriptions(app) {
  const settings = await platformSettings(app);
  const due = await app.db.all(
    `SELECT s.id, s.tenant_id, t.name AS tenant_name FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
     WHERE s.status IN ('active','past_due') AND s.current_period_end <= ?`, nowUTC());

  let renewed = 0, ended = 0;
  for (const row of due) {
    const sub = await tenantSubscription(app, row.tenant_id);
    if (!sub) continue;

    if (sub.cancel_at_period_end) {
      await app.db.run(`UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?`, nowUTC(), sub.id);
      await notify(app, row.tenant_id, {
        type: 'billing.canceled', title: 'انتهى اشتراك الجهة',
        body: 'انتهت فترة الاشتراك بناءً على طلب إيقاف التجديد — المنصة الآن للقراءة فقط.',
        url: '/billing', urgency: 'high'
      });
      await plog(app, { tenantId: row.tenant_id, action: 'update', entity: 'subscription', entityId: sub.id,
        summary: `انتهى اشتراك «${row.tenant_name}» بعد إيقاف التجديد` });
      ended++;
      continue;
    }

    const start = sub.current_period_end;
    const end = periodEnd(start, sub.cycle);
    const price = planPrice(sub.plan, sub.cycle);

    await app.db.run(
      `UPDATE subscriptions SET status=?, current_period_start=?, current_period_end=?, grace_until=?, updated_at=? WHERE id=?`,
      price > 0 ? 'past_due' : 'active', start, end,
      price > 0 ? addDays(nowUTC(), settings.grace_days) : null, nowUTC(), sub.id);

    if (price > 0) {
      const inv = await issueInvoice(app, row.tenant_id,
        { ...sub, current_period_start: start, current_period_end: end },
        { note: 'تجديد دوري' });
      await notify(app, row.tenant_id, {
        type: 'billing.invoice', title: `فاتورة تجديد ${inv.number}`,
        body: `المستحق ${inv.total} ${inv.currency} عن الفترة الجديدة.`, url: '/billing', urgency: 'high'
      });
      await plog(app, { tenantId: row.tenant_id, action: 'create', entity: 'subscription_invoice', entityId: inv.id,
        summary: `تجديد اشتراك «${row.tenant_name}» وإصدار الفاتورة ${inv.number}` });
    }
    renewed++;
  }
  return { renewed, ended, checked: due.length };
}

/** يذكّر بالفواتير المتأخرة قبل انتهاء المهلة، ويصعّد بعدها */
export async function dunning(app) {
  const now = nowUTC();
  const overdue = await app.db.all(
    `SELECT i.*, t.name AS tenant_name, s.grace_until, s.status AS sub_status
     FROM subscription_invoices i
     JOIN tenants t ON t.id=i.tenant_id
     LEFT JOIN subscriptions s ON s.tenant_id=i.tenant_id
     WHERE i.status='open' AND i.due_at IS NOT NULL AND i.due_at <= ?`, now);

  let reminded = 0, blocked = 0;
  for (const inv of overdue) {
    const graceOver = !inv.grace_until || inv.grace_until <= now;
    if (graceOver && inv.sub_status === 'past_due') {
      await notify(app, inv.tenant_id, {
        type: 'billing.blocked', title: 'توقّف الاشتراك عن الكتابة',
        body: `الفاتورة ${inv.number} (${inv.total} ${inv.currency}) لم تُسدَّد — المنصة الآن للقراءة فقط حتى السداد.`,
        url: '/billing', urgency: 'high'
      });
      await plog(app, { tenantId: inv.tenant_id, action: 'update', entity: 'subscription_invoice', entityId: inv.id,
        summary: `انتهت مهلة سداد الفاتورة ${inv.number} لجهة «${inv.tenant_name}» — تعطّلت الكتابة` });
      blocked++;
    } else {
      await notify(app, inv.tenant_id, {
        type: 'billing.reminder', title: `تذكير: الفاتورة ${inv.number} مستحقة`,
        body: `المبلغ ${inv.total} ${inv.currency}. يرجى السداد قبل انتهاء المهلة.`, url: '/billing'
      });
      reminded++;
    }
  }
  return { reminded, blocked, overdue: overdue.length };
}

/** الوظيفة اليومية الجامعة */
export async function runSubscriptionCycle(app) {
  const trials = await expireTrials(app);
  const renewals = await renewSubscriptions(app);
  const reminders = await dunning(app);
  return { trials, renewals, reminders };
}
