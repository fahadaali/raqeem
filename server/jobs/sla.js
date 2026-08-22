import db, { nowUTC } from '../db/index.js';
import { auditSystem } from '../middleware/audit.js';
import { notifyUsers, notifyByPermission } from '../lib/notify.js';

/**
 * اتفاقيات مستوى الخدمة (البند ٨): مؤقتات زمنية للتذاكر؛
 * إذا تأخر الدعم عن الرد خلال المدة المحددة يُصعّد النظام التذكرة
 * للمدير الأعلى ويغيّر لونها للأحمر.
 */
export async function checkSLA() {
  const now = nowUTC();
  const breached = db.prepare(`SELECT t.*, u.name requester_name FROM tickets t
    JOIN users u ON u.id=t.requester_id
    WHERE t.status IN ('open','in_progress') AND t.escalated=0
      AND t.first_response_at IS NULL AND t.sla_due_at < ?`).all(now);

  for (const t of breached) {
    db.prepare('UPDATE tickets SET escalated=1, escalated_at=?, priority=?, updated_at=? WHERE id=?')
      .run(now, t.priority === 'urgent' ? 'urgent' : 'high', now, t.id);

    auditSystem({
      tenantId: t.tenant_id, action: 'update', entity: 'ticket', entityId: t.id, branchId: t.branch_id,
      summary: `تصعيد آلي للتذكرة ${t.number} — تجاوز مدة الاستجابة (${t.sla_hours} ساعة) دون رد من الدعم`
    });

    await notifyByPermission(t.tenant_id, 'settings.manage', {
      type: 'ticket.escalated', category: 'tickets', title: `⚠️ تصعيد تذكرة — ${t.number}`,
      body: `لم يرد فريق الدعم خلال ${t.sla_hours} ساعة على: ${t.subject}`,
      url: `/tickets?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
    await notifyUsers(t.tenant_id, [t.requester_id], {
      type: 'ticket.escalated', category: 'tickets', title: `تم تصعيد تذكرتك ${t.number}`,
      body: 'أُحيلت تذكرتك للإدارة العليا لتأخر الاستجابة.', url: `/tickets?id=${t.id}`, data: { id: t.id }
    });
  }
  return breached.length;
}

/** تنبيه المهام المستحقة والمتأخرة */
export async function checkTaskDeadlines() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const due = db.prepare(`SELECT t.*, tm.status term_status FROM tasks t
    LEFT JOIN terms tm ON tm.id=t.term_id
    WHERE t.status<>'done' AND t.assignee_id IS NOT NULL AND t.due_date IN (?,?)
      AND (tm.status IS NULL OR tm.status='open')`).all(today, tomorrow);

  for (const t of due) {
    const already = db.prepare(`SELECT 1 FROM notifications WHERE tenant_id=? AND user_id=? AND type='task.due'
      AND json_extract(data,'$.id')=? AND date(created_at)=date('now')`).get(t.tenant_id, t.assignee_id, t.id);
    if (already) continue;
    await notifyUsers(t.tenant_id, [t.assignee_id], {
      type: 'task.due', category: 'tasks',
      title: t.due_date === today ? '⏰ مهمة تستحق اليوم' : 'مهمة تستحق غداً',
      body: t.title, url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
  }

  const overdue = db.prepare(`SELECT t.*, tm.status term_status FROM tasks t
    LEFT JOIN terms tm ON tm.id=t.term_id
    WHERE t.status<>'done' AND t.assignee_id IS NOT NULL AND t.due_date < ?
      AND (tm.status IS NULL OR tm.status='open')`).all(today);

  for (const t of overdue) {
    const already = db.prepare(`SELECT 1 FROM notifications WHERE tenant_id=? AND user_id=? AND type='task.overdue'
      AND json_extract(data,'$.id')=? AND created_at > datetime('now','-3 days')`).get(t.tenant_id, t.assignee_id, t.id);
    if (already) continue;
    await notifyUsers(t.tenant_id, [t.assignee_id], {
      type: 'task.overdue', category: 'tasks', title: '🔴 مهمة متأخرة',
      body: `${t.title} — تجاوزت تاريخ الاستحقاق ${t.due_date}`,
      url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
    });
  }
  return { due: due.length, overdue: overdue.length };
}
