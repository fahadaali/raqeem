import { nowUTC, j } from '../sql.js';
import { auditSystem } from '../middleware/audit.js';
import { notifyUsers, broadcast } from '../notify.js';

/**
 * الترحيل الآلي (البند ٣): سكربتات خلفية تنسخ السجلات المحددة من الفصل القديم
 * وتنشئها كمدخلات جديدة برقم الفصل الجديد، ثم تُغلق الفصل القديم فتعمل
 * مُشغّلات التجميد في قاعدة البيانات ويصبح مؤرشفاً للقراءة فقط.
 */
export async function runRollover(app, { rolloverId, tenantId, userId }) {
  const roll = await app.db.get('SELECT * FROM term_rollovers WHERE id=? AND tenant_id=?', rolloverId, tenantId);
  if (!roll) throw new Error('عملية الترحيل غير موجودة');
  const opts = j(roll.options, {}) || {};
  await app.db.run(`UPDATE term_rollovers SET status='running' WHERE id=?`, rolloverId);

  const from = await app.db.get('SELECT * FROM terms WHERE id=?', roll.from_term_id);
  const to = await app.db.get('SELECT * FROM terms WHERE id=?', roll.to_term_id);
  const summary = { committees: 0, tasks: 0, custody: 0, budgets: 0, staff: 0 };
  const committeeMap = {};

  try {
    /* ١) ترحيل اللجان المحددة */
    const keepStaff = new Set(opts.staff_ids || []);
    for (const cid of opts.committee_ids || []) {
      const c = await app.db.get('SELECT * FROM committees WHERE id=? AND tenant_id=?', cid, tenantId);
      if (!c) continue;
      const r = await app.db.run(
        `INSERT INTO committees(tenant_id,branch_id,term_id,name,description,lead_user_id,color) VALUES(?,?,?,?,?,?,?)`,
        tenantId, c.branch_id, to.id, c.name, c.description, c.lead_user_id, c.color);
      committeeMap[c.id] = r.lastId;
      const members = await app.db.all('SELECT * FROM committee_members WHERE committee_id=?', c.id);
      const rows = members
        .filter(m => !keepStaff.size || keepStaff.has(m.user_id) || m.user_id === c.lead_user_id)
        .map(m => ['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)',
          [tenantId, r.lastId, m.user_id, m.role_in]]);
      if (rows.length) await app.db.batch(rows);
      summary.committees++;
    }

    /* ٢) ترحيل المهام غير المكتملة المحددة */
    const shift = Math.max(0, Math.round((new Date(to.start_date) - new Date(from.start_date)) / 86400000));
    const shiftDate = (d) => d ? new Date(new Date(d).getTime() + shift * 86400000).toISOString().slice(0, 10) : null;
    const taskStmts = [];
    for (const tid of opts.task_ids || []) {
      const t = await app.db.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', tid, tenantId);
      if (!t) continue;
      const assignee = t.assignee_id && (!keepStaff.size || keepStaff.has(t.assignee_id)) ? t.assignee_id : null;
      taskStmts.push([`INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,progress,weight,order_index)
        VALUES(?,?,?,?,?,?,'todo',?,?,?,?,?,0,?,?)`,
        [tenantId, t.branch_id, to.id, committeeMap[t.committee_id] || null, t.title,
         t.description ? `${t.description}\n\n(مُرحّلة من ${from.name})` : `مُرحّلة من ${from.name}`,
         t.priority, assignee, userId, shiftDate(t.start_date), shiftDate(t.due_date), t.weight, t.order_index]]);
      summary.tasks++;
    }
    for (let i = 0; i < taskStmts.length; i += 50) await app.db.batch(taskStmts.slice(i, i + 50));

    /* ٣) ترحيل العهد المالية القائمة */
    if (opts.carry_custody) {
      const custody = await app.db.all(
        `SELECT * FROM finance_requests WHERE tenant_id=? AND term_id=? AND type='custody' AND status='approved'`,
        tenantId, from.id);
      const rows = custody.map(c => [
        `INSERT INTO finance_requests(tenant_id,branch_id,term_id,number,type,title,description,amount,requester_id,workflow_id,current_step,status)
         VALUES(?,?,?,?,'custody',?,?,?,?,?,?,'approved')`,
        [tenantId, c.branch_id, to.id, `${c.number}-R`, `${c.title} (عهدة مُرحّلة)`,
         `عهدة مُرحّلة من ${from.name}`, c.amount, c.requester_id, c.workflow_id, c.current_step]]);
      if (rows.length) await app.db.batch(rows);
      summary.custody = rows.length;
    }

    /* ٤) ترحيل بنود الميزانية بأرصدة جديدة */
    if (opts.carry_budgets) {
      const budgets = await app.db.all('SELECT * FROM budgets WHERE tenant_id=? AND term_id=?', tenantId, from.id);
      const rows = budgets.map(b => ['INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount,spent) VALUES(?,?,?,?,?,?,0)',
        [tenantId, b.branch_id, to.id, b.name, b.category, b.amount]]);
      if (rows.length) await app.db.batch(rows);
      summary.budgets = rows.length;
    }

    summary.staff = (opts.staff_ids || []).length;

    /* ٥) إغلاق الفصل المصدر — بعده تعمل مُشغّلات التجميد في قاعدة البيانات */
    const finish = [];
    if (opts.close_source !== false) {
      finish.push([`UPDATE terms SET status='closed', closed_at=?, closed_by=? WHERE id=?`, [nowUTC(), userId, from.id]]);
    }
    finish.push([`UPDATE term_rollovers SET status='done', summary=?, finished_at=? WHERE id=?`,
      [JSON.stringify(summary), nowUTC(), rolloverId]]);
    await app.db.batch(finish);
  } catch (e) {
    await app.db.run(`UPDATE term_rollovers SET status='failed', summary=?, finished_at=? WHERE id=?`,
      JSON.stringify({ error: e.message }), nowUTC(), rolloverId);
    throw e;
  }

  await auditSystem(app, {
    tenantId, action: 'update', entity: 'term', entityId: from.id,
    summary: `اكتمل ترحيل الفصل (${from.name}) إلى (${to.name}): ${summary.tasks} مهمة، ${summary.committees} لجنة، ${summary.custody} عهدة، ${summary.budgets} بند ميزانية`
  });
  await notifyUsers(app, tenantId, [userId], {
    type: 'term.rollover.done', category: 'system', title: '✅ اكتمل ترحيل الفصل الدراسي',
    body: `${to.name}: ${summary.tasks} مهمة و${summary.committees} لجنة. الفصل السابق أصبح مؤرشفاً للقراءة فقط.`,
    url: '/terms', urgency: 'high'
  });
  await broadcast(app, tenantId, {
    type: 'term.started', category: 'system', title: `بدأ الفصل الدراسي: ${to.name}`,
    body: 'تم ترحيل المهام والبيانات المعتمدة. يمكنك الاطلاع على مهامك الجديدة.', url: '/tasks'
  });

  return summary;
}
