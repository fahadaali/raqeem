import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, locked, forbidden } from '../lib/errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed } from '../lib/scope.js';
import { notifyUsers } from '../lib/notify.js';
import { emitToUsers } from '../lib/realtime.js';

const router = express.Router();
const STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked'];
const STATUS_AR = { todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', review: 'قيد المراجعة', done: 'مكتملة', blocked: 'متوقفة' };

/* ─────────────────────────── اللجان ─────────────────────────────────────── */
router.get('/committees', can('committees.view', 'tasks.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'c' });
  const termId = req.query.term_id || req.ctx.activeTermId || currentTerm(req.ctx.tenantId)?.id;
  let sql = `SELECT c.*, u.name lead_name, b.name branch_name,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) members_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id) tasks_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id AND t.status='done') tasks_done
    FROM committees c LEFT JOIN users u ON u.id=c.lead_user_id LEFT JOIN branches b ON b.id=c.branch_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (termId) { sql += ' AND (c.term_id=? OR c.term_id IS NULL)'; params.push(Number(termId)); }
  if (req.ctx.activeBranchId) { sql += ' AND (c.branch_id=? OR c.branch_id IS NULL)'; params.push(req.ctx.activeBranchId); }
  sql += ' ORDER BY c.name';
  const rows = db.prepare(sql).all(...params);
  const members = db.prepare(`SELECT m.committee_id, m.user_id, m.role_in, u.name
    FROM committee_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=?`).all(req.ctx.tenantId);
  res.json(rows.map(c => ({ ...c, members: members.filter(m => m.committee_id === c.id) })));
}));

router.post('/committees', can('committees.manage'), ah(async (req, res) => {
  const { name, description, branch_id, term_id, lead_user_id, color, member_ids } = req.body || {};
  if (!name) throw badRequest('اسم اللجنة إلزامي');
  const bid = branch_id ? assertBranch(req.ctx, branch_id) : null;
  const tid = term_id || currentTerm(req.ctx.tenantId)?.id || null;
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO committees(tenant_id,branch_id,term_id,name,description,lead_user_id,color)
      VALUES(?,?,?,?,?,?,?)`).run(req.ctx.tenantId, bid, tid, name.trim(), description || null,
      lead_user_id || null, color || '#0F5132');
    const ins = db.prepare('INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)');
    if (lead_user_id) ins.run(req.ctx.tenantId, r.lastInsertRowid, lead_user_id, 'رئيس اللجنة');
    for (const m of member_ids || []) ins.run(req.ctx.tenantId, r.lastInsertRowid, m, 'عضو');
    return r.lastInsertRowid;
  })();
  audit(req, { action: 'create', entity: 'committee', entityId: id, summary: `إنشاء لجنة: ${name}` });
  if (member_ids?.length) await notifyUsers(req.ctx.tenantId, member_ids, {
    type: 'committee.added', category: 'tasks', title: 'تمت إضافتك إلى لجنة',
    body: `أصبحت عضواً في "${name}"`, url: '/committees'
  });
  res.status(201).json({ id });
}));

router.patch('/committees/:id', can('committees.manage'), ah(async (req, res) => {
  const c = findScoped(req.ctx, 'committees', req.params.id, { branchCheck: true });
  if (!c) throw notFound('اللجنة غير موجودة');
  const p = req.body || {};
  db.prepare('UPDATE committees SET name=?,description=?,lead_user_id=?,color=?,is_active=? WHERE id=? AND tenant_id=?')
    .run(p.name ?? c.name, p.description ?? c.description, p.lead_user_id ?? c.lead_user_id,
      p.color ?? c.color, p.is_active ?? c.is_active, c.id, req.ctx.tenantId);
  if (Array.isArray(p.member_ids)) {
    db.prepare('DELETE FROM committee_members WHERE committee_id=?').run(c.id);
    const ins = db.prepare('INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)');
    for (const m of p.member_ids) ins.run(req.ctx.tenantId, c.id, m, m === (p.lead_user_id ?? c.lead_user_id) ? 'رئيس اللجنة' : 'عضو');
  }
  audit(req, { action: 'update', entity: 'committee', entityId: c.id, summary: `تعديل اللجنة: ${c.name}` });
  res.json({ ok: true });
}));

/* ─────────────────────────── قوالب المهام (مكتبة النماذج) ───────────────── */
router.get('/templates', can('templates.view', 'tasks.create'), ah(async (req, res) => {
  const rows = db.prepare('SELECT * FROM task_templates WHERE tenant_id=? ORDER BY category, name').all(req.ctx.tenantId);
  res.json(rows.map(r => ({ ...r, items: j(r.items, []) })));
}));

router.post('/templates', can('templates.manage'), ah(async (req, res) => {
  const { name, description, category, items } = req.body || {};
  if (!name || !Array.isArray(items) || !items.length) throw badRequest('اسم القالب وعناصره إلزامية');
  const r = db.prepare('INSERT INTO task_templates(tenant_id,name,description,category,items,created_by) VALUES(?,?,?,?,?,?)')
    .run(req.ctx.tenantId, name.trim(), description || null, category || 'عام', JSON.stringify(items), req.ctx.userId);
  audit(req, { action: 'create', entity: 'task_template', entityId: r.lastInsertRowid, summary: `إنشاء قالب مهام: ${name}` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.patch('/templates/:id', can('templates.manage'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'task_templates', req.params.id);
  if (!t) throw notFound('القالب غير موجود');
  const p = req.body || {};
  db.prepare('UPDATE task_templates SET name=?,description=?,category=?,items=? WHERE id=? AND tenant_id=?')
    .run(p.name ?? t.name, p.description ?? t.description, p.category ?? t.category,
      p.items ? JSON.stringify(p.items) : t.items, t.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'task_template', entityId: t.id, summary: `تعديل القالب: ${t.name}` });
  res.json({ ok: true });
}));

router.delete('/templates/:id', can('templates.manage'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'task_templates', req.params.id);
  if (!t) throw notFound('القالب غير موجود');
  db.prepare('DELETE FROM task_templates WHERE id=? AND tenant_id=?').run(t.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'task_template', entityId: t.id, summary: `حذف القالب: ${t.name}` });
  res.json({ ok: true });
}));

/** محرك القوالب: استنساخ القالب إلى مهام فعلية في الفصل الحالي (البند ٤) */
router.post('/templates/:id/apply', can('tasks.create'), ah(async (req, res) => {
  const tpl = findScoped(req.ctx, 'task_templates', req.params.id);
  if (!tpl) throw notFound('القالب غير موجود');
  const { committee_id, branch_id, term_id, start_date, assignee_map = {}, items: overrideItems } = req.body || {};
  const term = term_id ? findScoped(req.ctx, 'terms', term_id) : currentTerm(req.ctx.tenantId);
  if (!term) throw badRequest('لا يوجد فصل دراسي نشط');
  if (['closed', 'archived'].includes(term.status)) throw locked();
  const bid = branch_id ? assertBranch(req.ctx, branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const items = Array.isArray(overrideItems) && overrideItems.length ? overrideItems : j(tpl.items, []);
  const base = start_date ? new Date(start_date) : new Date();
  const created = [];

  db.transaction(() => {
    const ins = db.prepare(`INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,weight,order_index)
      VALUES(?,?,?,?,?,?, 'todo',?,?,?,?,?,?,?)`);
    items.forEach((it, i) => {
      const s = new Date(base.getTime() + (Number(it.offset_days) || 0) * 86400000);
      const d = new Date(s.getTime() + (Number(it.duration_days) || 3) * 86400000);
      const r = ins.run(req.ctx.tenantId, bid, term.id, committee_id || null, it.title,
        it.description || `مُنشأة من القالب: ${tpl.name}`, it.priority || 'medium',
        assignee_map[it.title] || it.assignee_id || null, req.ctx.userId,
        s.toISOString().slice(0, 10), d.toISOString().slice(0, 10), Number(it.weight) || 1, i);
      created.push(r.lastInsertRowid);
    });
  })();

  audit(req, { action: 'create', entity: 'task', entityId: created.join(','), summary: `استنساخ القالب (${tpl.name}) إلى ${created.length} مهمة في ${term.name}` });
  const assignees = Object.values(assignee_map).filter(Boolean);
  if (assignees.length) await notifyUsers(req.ctx.tenantId, assignees, {
    type: 'task.assigned', category: 'tasks', title: 'مهام جديدة من قالب',
    body: `أُسندت إليك مهام ضمن "${tpl.name}"`, url: '/tasks'
  });
  res.status(201).json({ created: created.length, ids: created });
}));

/* ─────────────────────────── المهام ─────────────────────────────────────── */
function taskQuery(req) {
  const sc = scoped(req.ctx, { alias: 't' });
  let sql = `SELECT t.*, u.name assignee_name, u.avatar_url assignee_avatar, c.name committee_name,
      c.color committee_color, b.name branch_name, cu.name creator_name,
      tm.status term_status, tm.name term_name,
      (SELECT COUNT(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
        WHERE cv.context_type='task' AND cv.context_id=t.id) comments_count
    FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN users cu ON cu.id=t.created_by
    LEFT JOIN committees c ON c.id=t.committee_id
    LEFT JOIN branches b ON b.id=t.branch_id
    LEFT JOIN terms tm ON tm.id=t.term_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  const q = req.query;

  if (!has(req.ctx, 'tasks.view_all')) { sql += ' AND (t.assignee_id=? OR t.created_by=?)'; params.push(req.ctx.userId, req.ctx.userId); }
  const termId = q.term_id || req.ctx.activeTermId;
  if (termId && termId !== 'all') { sql += ' AND t.term_id=?'; params.push(Number(termId)); }
  const branchId = q.branch_id || req.ctx.activeBranchId;
  if (branchId && branchId !== 'all') { sql += ' AND t.branch_id=?'; params.push(Number(branchId)); }
  if (q.committee_id) { sql += ' AND t.committee_id=?'; params.push(Number(q.committee_id)); }
  if (q.assignee_id) { sql += ' AND t.assignee_id=?'; params.push(Number(q.assignee_id)); }
  if (q.status) { sql += ` AND t.status IN (${String(q.status).split(',').map(() => '?').join(',')})`; params.push(...String(q.status).split(',')); }
  if (q.priority) { sql += ' AND t.priority=?'; params.push(q.priority); }
  if (q.mine === '1') { sql += ' AND t.assignee_id=?'; params.push(req.ctx.userId); }
  if (q.overdue === '1') { sql += " AND t.status<>'done' AND t.due_date < date('now')"; }
  if (q.q) { sql += ' AND (t.title LIKE ? OR t.description LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  sql += ' ORDER BY t.order_index, t.due_date, t.id DESC';
  return { sql, params };
}

router.get('/', can('tasks.view', 'tasks.view_all'), ah(async (req, res) => {
  const { sql, params } = taskQuery(req);
  const rows = db.prepare(sql).all(...params);
  const deps = db.prepare('SELECT task_id, depends_on_id, type FROM task_dependencies WHERE tenant_id=?').all(req.ctx.tenantId);
  res.json(rows.map(t => ({
    ...t,
    status_ar: STATUS_AR[t.status] || t.status,
    is_locked: ['closed', 'archived'].includes(t.term_status),
    is_overdue: t.status !== 'done' && t.due_date && t.due_date < new Date().toISOString().slice(0, 10),
    depends_on: deps.filter(d => d.task_id === t.id).map(d => d.depends_on_id)
  })));
}));

router.get('/:id', can('tasks.view', 'tasks.view_all'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (!has(req.ctx, 'tasks.view_all') && t.assignee_id !== req.ctx.userId && t.created_by !== req.ctx.userId)
    throw forbidden('لا تملك صلاحية عرض هذه المهمة');
  const deps = db.prepare(`SELECT d.depends_on_id, t2.title FROM task_dependencies d
    JOIN tasks t2 ON t2.id=d.depends_on_id WHERE d.task_id=?`).all(t.id);
  res.json({ ...t, status_ar: STATUS_AR[t.status], depends_on: deps });
}));

router.post('/', can('tasks.create'), ah(async (req, res) => {
  const p = req.body || {};
  if (!p.title) throw badRequest('عنوان المهمة إلزامي');
  const term = p.term_id ? findScoped(req.ctx, 'terms', p.term_id) : currentTerm(req.ctx.tenantId);
  if (term && ['closed', 'archived'].includes(term.status)) throw locked();
  const bid = p.branch_id ? assertBranch(req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const r = db.prepare(`INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,weight,order_index)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.ctx.tenantId, bid, term?.id || null, p.committee_id || null, p.title.trim(), p.description || null,
    STATUSES.includes(p.status) ? p.status : 'todo', p.priority || 'medium',
    p.assignee_id || null, req.ctx.userId, p.start_date || null, p.due_date || null,
    Number(p.weight) || 1, Number(p.order_index) || 0);

  if (Array.isArray(p.depends_on)) {
    const ins = db.prepare('INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)');
    for (const d of p.depends_on) ins.run(req.ctx.tenantId, r.lastInsertRowid, d, 'FS');
  }

  audit(req, { action: 'create', entity: 'task', entityId: r.lastInsertRowid, summary: `${req.ctx.userName} أنشأ المهمة (${p.title})`, branchId: bid });
  if (p.assignee_id) await notifyUsers(req.ctx.tenantId, [p.assignee_id], {
    type: 'task.assigned', category: 'tasks', title: 'أُسندت إليك مهمة جديدة',
    body: `${p.title}${p.due_date ? ' — تستحق بتاريخ ' + p.due_date : ''}`,
    url: `/tasks?id=${r.lastInsertRowid}`, data: { id: r.lastInsertRowid }, urgency: 'high'
  });
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid));
}));

router.patch('/:id', can('tasks.update'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (termIsClosed(req.ctx.tenantId, t.term_id)) throw locked();
  const mine = t.assignee_id === req.ctx.userId || t.created_by === req.ctx.userId;
  if (!mine && !has(req.ctx, 'tasks.view_all')) throw forbidden('لا تملك صلاحية تعديل هذه المهمة');

  const p = req.body || {};
  if (p.assignee_id !== undefined && p.assignee_id !== t.assignee_id && !has(req.ctx, 'tasks.assign'))
    throw forbidden('تحتاج صلاحية إسناد المهام');

  const status = STATUSES.includes(p.status) ? p.status : t.status;
  const progress = p.progress !== undefined ? Math.max(0, Math.min(100, Number(p.progress)))
    : (status === 'done' ? 100 : t.progress);

  db.prepare(`UPDATE tasks SET title=?,description=?,status=?,priority=?,assignee_id=?,committee_id=?,
      start_date=?,due_date=?,progress=?,weight=?,order_index=?,completed_at=?,updated_at=? WHERE id=? AND tenant_id=?`).run(
    p.title ?? t.title, p.description ?? t.description, status, p.priority ?? t.priority,
    p.assignee_id !== undefined ? p.assignee_id : t.assignee_id,
    p.committee_id !== undefined ? p.committee_id : t.committee_id,
    p.start_date ?? t.start_date, p.due_date ?? t.due_date, progress,
    Number(p.weight) || t.weight, p.order_index ?? t.order_index,
    status === 'done' ? (t.completed_at || nowUTC()) : null, nowUTC(), t.id, req.ctx.tenantId);

  if (Array.isArray(p.depends_on)) {
    db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(t.id);
    const ins = db.prepare('INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)');
    for (const d of p.depends_on) if (Number(d) !== t.id) ins.run(req.ctx.tenantId, t.id, d, 'FS');
  }

  const changed = status !== t.status;
  audit(req, {
    action: 'update', entity: 'task', entityId: t.id, branchId: t.branch_id,
    summary: changed
      ? `${req.ctx.userName} غيّر حالة المهمة (${t.title}) من "${STATUS_AR[t.status]}" إلى "${STATUS_AR[status]}"`
      : `${req.ctx.userName} عدّل المهمة (${t.title})`,
    before: { status: t.status, progress: t.progress, assignee_id: t.assignee_id },
    after: { status, progress, assignee_id: p.assignee_id ?? t.assignee_id }
  });

  const watchers = new Set([t.created_by, t.assignee_id, p.assignee_id].filter(x => x && x !== req.ctx.userId));
  if (changed && watchers.size) await notifyUsers(req.ctx.tenantId, [...watchers], {
    type: 'task.status', category: 'tasks', title: 'تحديث حالة مهمة',
    body: `${t.title} → ${STATUS_AR[status]}`, url: `/tasks?id=${t.id}`, data: { id: t.id }
  });
  if (p.assignee_id && p.assignee_id !== t.assignee_id) await notifyUsers(req.ctx.tenantId, [p.assignee_id], {
    type: 'task.assigned', category: 'tasks', title: 'أُسندت إليك مهمة',
    body: t.title, url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
  });
  emitToUsers(req.ctx.tenantId, [...watchers], { type: 'task.updated', taskId: t.id });

  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id));
}));

/** إعادة ترتيب بطاقات كانبان */
router.post('/reorder', can('tasks.update'), ah(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const upd = db.prepare('UPDATE tasks SET order_index=?, status=?, updated_at=? WHERE id=? AND tenant_id=?');
  db.transaction(() => {
    items.forEach((it, i) => {
      if (!STATUSES.includes(it.status)) return;
      const t = findScoped(req.ctx, 'tasks', it.id, { branchCheck: true });
      if (!t || termIsClosed(req.ctx.tenantId, t.term_id)) return;
      upd.run(it.order_index ?? i, it.status, nowUTC(), it.id, req.ctx.tenantId);
    });
  })();
  res.json({ ok: true, updated: items.length });
}));

router.delete('/:id', can('tasks.delete'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (termIsClosed(req.ctx.tenantId, t.term_id)) throw locked();
  db.prepare('DELETE FROM tasks WHERE id=? AND tenant_id=?').run(t.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'task', entityId: t.id, summary: `${req.ctx.userName} حذف المهمة (${t.title})`, before: t });
  res.json({ ok: true });
}));

/** بيانات مخطط جانت جاهزة للرسم مع الاعتماديات */
router.get('/view/gantt', can('tasks.view', 'tasks.view_all'), ah(async (req, res) => {
  const { sql, params } = taskQuery(req);
  const rows = db.prepare(sql).all(...params);
  const deps = db.prepare('SELECT task_id, depends_on_id FROM task_dependencies WHERE tenant_id=?').all(req.ctx.tenantId);
  const items = rows.filter(t => t.start_date || t.due_date).map(t => ({
    id: t.id, title: t.title, status: t.status, progress: t.progress,
    color: t.committee_color || '#0F5132', assignee: t.assignee_name,
    start: t.start_date || t.due_date, end: t.due_date || t.start_date,
    depends_on: deps.filter(d => d.task_id === t.id).map(d => d.depends_on_id)
  }));
  res.json({ items, total: rows.length });
}));

export default router;
