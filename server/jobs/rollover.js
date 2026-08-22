import db, { nowUTC, j } from '../db/index.js';
import { auditSystem } from '../middleware/audit.js';
import { notifyUsers, broadcast } from '../lib/notify.js';

/**
 * الترحيل الآلي (البند ٣): سكربتات خلفية تنسخ السجلات المحددة من الفصل
 * القديم وتنشئها كمدخلات جديدة برقم الفصل الجديد، ثم تُغلق الفصل القديم.
 */
export async function runRollover({ rolloverId, tenantId, userId }) {
  const roll = db.prepare('SELECT * FROM term_rollovers WHERE id=? AND tenant_id=?').get(rolloverId, tenantId);
  if (!roll) throw new Error('عملية الترحيل غير موجودة');
  const opts = j(roll.options, {});
  db.prepare("UPDATE term_rollovers SET status='running' WHERE id=?").run(rolloverId);

  const from = db.prepare('SELECT * FROM terms WHERE id=?').get(roll.from_term_id);
  const to = db.prepare('SELECT * FROM terms WHERE id=?').get(roll.to_term_id);
  const summary = { committees: 0, tasks: 0, custody: 0, budgets: 0, staff: 0, users_notified: 0 };
  const committeeMap = {};

  const work = db.transaction(() => {
    // ١) ترحيل اللجان المحددة
    for (const cid of opts.committee_ids || []) {
      const c = db.prepare('SELECT * FROM committees WHERE id=? AND tenant_id=?').get(cid, tenantId);
      if (!c) continue;
      const r = db.prepare(`INSERT INTO committees(tenant_id,branch_id,term_id,name,description,lead_user_id,color)
        VALUES(?,?,?,?,?,?,?)`).run(tenantId, c.branch_id, to.id, c.name, c.description, c.lead_user_id, c.color);
      committeeMap[c.id] = r.lastInsertRowid;
      const members = db.prepare('SELECT * FROM committee_members WHERE committee_id=?').all(c.id);
      const ins = db.prepare('INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)');
      const keep = new Set(opts.staff_ids || []);
      for (const m of members) {
        if (keep.size && !keep.has(m.user_id) && m.user_id !== c.lead_user_id) continue;
        ins.run(tenantId, r.lastInsertRowid, m.user_id, m.role_in);
      }
      summary.committees++;
    }

    // ٢) ترحيل المهام غير المكتملة المحددة
    const keepStaff = new Set(opts.staff_ids || []);
    for (const tid of opts.task_ids || []) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=? AND tenant_id=?').get(tid, tenantId);
      if (!t) continue;
      const assignee = t.assignee_id && (!keepStaff.size || keepStaff.has(t.assignee_id)) ? t.assignee_id : null;
      const shift = Math.max(0, Math.round((new Date(to.start_date) - new Date(from.start_date)) / 86400000));
      const shiftDate = (d) => d ? new Date(new Date(d).getTime() + shift * 86400000).toISOString().slice(0, 10) : null;
      db.prepare(`INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,progress,weight,order_index)
        VALUES(?,?,?,?,?,?, 'todo',?,?,?,?,?,0,?,?)`).run(
        tenantId, t.branch_id, to.id, committeeMap[t.committee_id] || null,
        t.title, t.description ? `${t.description}\n\n(مُرحّلة من ${from.name})` : `مُرحّلة من ${from.name}`,
        t.priority, assignee, userId, shiftDate(t.start_date), shiftDate(t.due_date), t.weight, t.order_index);
      summary.tasks++;
    }

    // ٣) ترحيل العهد المالية القائمة
    if (opts.carry_custody) {
      const custody = db.prepare(`SELECT * FROM finance_requests WHERE tenant_id=? AND term_id=? AND type='custody' AND status='approved'`)
        .all(tenantId, from.id);
      for (const c of custody) {
        db.prepare(`INSERT INTO finance_requests(tenant_id,branch_id,term_id,number,type,title,description,amount,requester_id,workflow_id,current_step,status)
          VALUES(?,?,?,?, 'custody',?,?,?,?,?,?, 'approved')`).run(tenantId, c.branch_id, to.id,
          `${c.number}-R`, `${c.title} (عهدة مُرحّلة)`, `عهدة مُرحّلة من ${from.name}`, c.amount,
          c.requester_id, c.workflow_id, c.current_step);
        summary.custody++;
      }
    }

    // ٤) ترحيل بنود الميزانية بأرصدة جديدة
    if (opts.carry_budgets) {
      const budgets = db.prepare('SELECT * FROM budgets WHERE tenant_id=? AND term_id=?').all(tenantId, from.id);
      for (const b of budgets) {
        db.prepare('INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount,spent) VALUES(?,?,?,?,?,?,0)')
          .run(tenantId, b.branch_id, to.id, b.name, b.category, b.amount);
        summary.budgets++;
      }
    }

    summary.staff = (opts.staff_ids || []).length;

    // ٥) إغلاق الفصل المصدر — بعده تعمل مُشغّلات التجميد في قاعدة البيانات
    if (opts.close_source !== false) {
      db.prepare("UPDATE terms SET status='closed', closed_at=?, closed_by=? WHERE id=?").run(nowUTC(), userId, from.id);
    }
    db.prepare("UPDATE term_rollovers SET status='done', summary=?, finished_at=? WHERE id=?")
      .run(JSON.stringify(summary), nowUTC(), rolloverId);
  });

  try {
    work();
  } catch (e) {
    db.prepare("UPDATE term_rollovers SET status='failed', summary=?, finished_at=? WHERE id=?")
      .run(JSON.stringify({ error: e.message }), nowUTC(), rolloverId);
    throw e;
  }

  auditSystem({
    tenantId, action: 'update', entity: 'term', entityId: from.id,
    summary: `اكتمل ترحيل الفصل (${from.name}) إلى (${to.name}): ${summary.tasks} مهمة، ${summary.committees} لجنة، ${summary.custody} عهدة، ${summary.budgets} بند ميزانية`
  });

  await notifyUsers(tenantId, [userId], {
    type: 'term.rollover.done', category: 'system', title: '✅ اكتمل ترحيل الفصل الدراسي',
    body: `${to.name}: ${summary.tasks} مهمة و${summary.committees} لجنة. الفصل السابق أصبح مؤرشفاً للقراءة فقط.`,
    url: '/terms', urgency: 'high'
  });
  await broadcast(tenantId, {
    type: 'term.started', category: 'system', title: `بدأ الفصل الدراسي: ${to.name}`,
    body: 'تم ترحيل المهام والبيانات المعتمدة. يمكنك الاطلاع على مهامك الجديدة.', url: '/tasks'
  });

  return summary;
}
