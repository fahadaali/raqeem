import { nowUTC } from '../sql.js';
import { auditSystem } from '../middleware/audit.js';
import { notifyUsers, notifyByPermission } from '../notify.js';

/**
 * اتفاقيات مستوى الخدمة (البند ٨): إذا تأخر الدعم عن الرد خلال المدة المحددة
 * يُصعّد النظام التذكرة للمدير الأعلى ويغيّر لونها للأحمر.
 */
export async function checkSLA(app) {
  const now = nowUTC();
  const breached = await app.db.all(`SELECT t.*, u.name AS requester_name FROM tickets t
    JOIN users u ON u.id=t.requester_id
    WHERE t.status IN ('open','in_progress') AND t.escalated=0
      AND t.first_response_at IS NULL AND t.sla_due_at < ?`, now);

  for (const t of breached) {
    await app.db.run('UPDATE tickets SET escalated=1, escalated_at=?, priority=?, updated_at=? WHERE id=?',
      now, t.priority === 'urgent' ? 'urgent' : 'high', now, t.id);

    await auditSystem(app, {
      tenantId: t.tenant_id, action: 'update', entity: 'ticket', entityId: t.id, branchId: t.branch_id,
      summary: `تصعيد آلي للتذكرة ${t.number} — تجاوز مدة الاستجابة (${t.sla_hours} ساعة) دون رد من الدعم`
    });
    await notifyByPermission(app, t.tenant_id, 'settings.manage', {
      type: 'ticket.escalated', category: 'tickets', title: `تصعيد تذكرة — ${t.number}`,
      body: `لم يرد فريق الدعم خلال ${t.sla_hours} ساعة على: ${t.subject}`,
      url: `/tickets?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
    await notifyUsers(app, t.tenant_id, [t.requester_id], {
      type: 'ticket.escalated', category: 'tickets', title: `تم تصعيد تذكرتك ${t.number}`,
      body: 'أُحيلت تذكرتك للإدارة العليا لتأخر الاستجابة.', url: `/tickets?id=${t.id}`, data: { id: t.id }
    });
  }
  return breached.length;
}

/** تنبيهات المهام المستحقة والمتأخرة */
export async function checkTaskDeadlines(app) {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const due = await app.db.all(`SELECT t.*, tm.status AS term_status FROM tasks t
    LEFT JOIN terms tm ON tm.id=t.term_id
    WHERE t.status<>'done' AND t.assignee_id IS NOT NULL AND t.due_date IN (?,?)
      AND (tm.status IS NULL OR tm.status='open')`, today, tomorrow);

  for (const t of due) {
    const already = await app.db.get(
      `SELECT 1 AS x FROM notifications WHERE tenant_id=? AND user_id=? AND type='task.due'
       AND json_extract(data,'$.id')=? AND date(created_at)=date('now')`, t.tenant_id, t.assignee_id, t.id);
    if (already) continue;
    await notifyUsers(app, t.tenant_id, [t.assignee_id], {
      type: 'task.due', category: 'tasks',
      title: t.due_date === today ? 'مهمة تستحق اليوم' : 'مهمة تستحق غداً',
      body: t.title, url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
  }

  const overdue = await app.db.all(`SELECT t.*, tm.status AS term_status FROM tasks t
    LEFT JOIN terms tm ON tm.id=t.term_id
    WHERE t.status<>'done' AND t.assignee_id IS NOT NULL AND t.due_date < ?
      AND (tm.status IS NULL OR tm.status='open')`, today);

  for (const t of overdue) {
    const already = await app.db.get(
      `SELECT 1 AS x FROM notifications WHERE tenant_id=? AND user_id=? AND type='task.overdue'
       AND json_extract(data,'$.id')=? AND created_at > datetime('now','-3 days')`, t.tenant_id, t.assignee_id, t.id);
    if (already) continue;
    await notifyUsers(app, t.tenant_id, [t.assignee_id], {
      type: 'task.overdue', category: 'tasks', title: 'مهمة متأخرة',
      body: `${t.title} — تجاوزت تاريخ الاستحقاق ${t.due_date}`,
      url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
  }
  return { due: due.length, overdue: overdue.length };
}
