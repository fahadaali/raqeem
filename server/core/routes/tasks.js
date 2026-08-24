import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, locked, forbidden } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed } from '../scope.js';
import { notifyUsers } from '../notify.js';

const router = new Hono();
const STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked'];
const STATUS_AR = { todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', review: 'قيد المراجعة', done: 'مكتملة', blocked: 'متوقفة' };

/* ─────────────── اللجان ─────────────── */
router.get('/committees', can('committees.view', 'tasks.view'), h(async (req) => {
  const app = req.app;
  const sc = scoped(req.ctx, { alias: 'c' });
  const termId = req.query.term_id || req.ctx.activeTermId || (await currentTerm(app, req.ctx.tenantId))?.id;
  let sql = `SELECT c.*, u.name AS lead_name, b.name AS branch_name,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) AS members_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id) AS tasks_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id AND t.status='done') AS tasks_done
    FROM committees c LEFT JOIN users u ON u.id=c.lead_user_id LEFT JOIN branches b ON b.id=c.branch_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (termId) { sql += ' AND (c.term_id=? OR c.term_id IS NULL)'; params.push(Number(termId)); }
  if (req.ctx.activeBranchId) { sql += ' AND (c.branch_id=? OR c.branch_id IS NULL)'; params.push(req.ctx.activeBranchId); }
  sql += ' ORDER BY c.name';

  const rows = await app.db.all(sql, ...params);
  const members = await app.db.all(`SELECT m.committee_id, m.user_id, m.role_in, u.name
    FROM committee_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=?`, req.ctx.tenantId);
  return rows.map(c => ({ ...c, members: members.filter(m => m.committee_id === c.id) }));
}));

router.post('/committees', can('committees.manage'), h(async (req) => {
  const app = req.app;
  const { name, description, branch_id, term_id, lead_user_id, color, member_ids } = req.body || {};
  if (!name) throw badRequest('اسم اللجنة إلزامي');
  const bid = branch_id ? await assertBranch(app, req.ctx, branch_id) : null;
  const tid = term_id || (await currentTerm(app, req.ctx.tenantId))?.id || null;

  const r = await app.db.run(
    `INSERT INTO committees(tenant_id,branch_id,term_id,name,description,lead_user_id,color) VALUES(?,?,?,?,?,?,?)`,
    req.ctx.tenantId, bid, tid, String(name).trim(), description || null, lead_user_id || null, color || '#2F8A6F');

  const rows = [];
  if (lead_user_id) rows.push(['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)',
    [req.ctx.tenantId, r.lastId, lead_user_id, 'رئيس اللجنة']]);
  for (const m of member_ids || []) rows.push(['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)',
    [req.ctx.tenantId, r.lastId, m, 'عضو']]);
  if (rows.length) await app.db.batch(rows);

  await audit(req, { action: 'create', entity: 'committee', entityId: r.lastId, summary: `إنشاء لجنة: ${name}` });
  if (member_ids?.length) await notifyUsers(app, req.ctx.tenantId, member_ids, {
    type: 'committee.added', category: 'tasks', title: 'تمت إضافتك إلى لجنة',
    body: `أصبحت عضواً في "${name}"`, url: '/committees'
  });
  return created({ id: r.lastId });
}));

router.patch('/committees/:id', can('committees.manage'), h(async (req) => {
  const app = req.app;
  const c = await findScoped(app, req.ctx, 'committees', req.params.id, { branchCheck: true });
  if (!c) throw notFound('اللجنة غير موجودة');
  const p = req.body || {};
  await app.db.run('UPDATE committees SET name=?,description=?,lead_user_id=?,color=?,is_active=? WHERE id=? AND tenant_id=?',
    p.name ?? c.name, p.description ?? c.description, p.lead_user_id ?? c.lead_user_id,
    p.color ?? c.color, p.is_active ?? c.is_active, c.id, req.ctx.tenantId);
  if (Array.isArray(p.member_ids)) {
    const lead = p.lead_user_id ?? c.lead_user_id;
    await app.db.batch([
      ['DELETE FROM committee_members WHERE committee_id=?', [c.id]],
      ...p.member_ids.map(m => ['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)',
        [req.ctx.tenantId, c.id, m, m === lead ? 'رئيس اللجنة' : 'عضو']])
    ]);
  }
  await audit(req, { action: 'update', entity: 'committee', entityId: c.id, summary: `تعديل اللجنة: ${c.name}` });
  return { ok: true };
}));

/* ─────────────── قوالب المهام ─────────────── */
router.get('/templates', can('templates.view', 'tasks.create'), h(async (req) =>
  (await req.app.db.all('SELECT * FROM task_templates WHERE tenant_id=? ORDER BY category, name', req.ctx.tenantId))
    .map(r => ({ ...r, items: j(r.items, []) }))));

router.post('/templates', can('templates.manage'), h(async (req) => {
  const { name, description, category, items } = req.body || {};
  if (!name || !Array.isArray(items) || !items.length) throw badRequest('اسم القالب وعناصره إلزامية');
  const r = await req.app.db.run(
    'INSERT INTO task_templates(tenant_id,name,description,category,items,created_by) VALUES(?,?,?,?,?,?)',
    req.ctx.tenantId, String(name).trim(), description || null, category || 'عام', JSON.stringify(items), req.ctx.userId);
  await audit(req, { action: 'create', entity: 'task_template', entityId: r.lastId, summary: `إنشاء قالب مهام: ${name}` });
  return created({ id: r.lastId });
}));

router.patch('/templates/:id', can('templates.manage'), h(async (req) => {
  const t = await findScoped(req.app, req.ctx, 'task_templates', req.params.id);
  if (!t) throw notFound('القالب غير موجود');
  const p = req.body || {};
  await req.app.db.run('UPDATE task_templates SET name=?,description=?,category=?,items=? WHERE id=? AND tenant_id=?',
    p.name ?? t.name, p.description ?? t.description, p.category ?? t.category,
    p.items ? JSON.stringify(p.items) : t.items, t.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'task_template', entityId: t.id, summary: `تعديل القالب: ${t.name}` });
  return { ok: true };
}));

router.delete('/templates/:id', can('templates.manage'), h(async (req) => {
  const t = await findScoped(req.app, req.ctx, 'task_templates', req.params.id);
  if (!t) throw notFound('القالب غير موجود');
  await req.app.db.run('DELETE FROM task_templates WHERE id=? AND tenant_id=?', t.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'task_template', entityId: t.id, summary: `حذف القالب: ${t.name}` });
  return { ok: true };
}));

/** محرك القوالب: استنساخ القالب إلى مهام فعلية في الفصل الحالي (البند ٤) */
router.post('/templates/:id/apply', can('tasks.create'), h(async (req) => {
  const app = req.app;
  const tpl = await findScoped(app, req.ctx, 'task_templates', req.params.id);
  if (!tpl) throw notFound('القالب غير موجود');
  const { committee_id, branch_id, term_id, start_date, assignee_map = {}, items: overrideItems } = req.body || {};
  const term = term_id ? await findScoped(app, req.ctx, 'terms', term_id) : await currentTerm(app, req.ctx.tenantId);
  if (!term) throw badRequest('لا يوجد فصل دراسي نشط');
  if (['closed', 'archived'].includes(term.status)) throw locked();
  const bid = branch_id ? await assertBranch(app, req.ctx, branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const items = Array.isArray(overrideItems) && overrideItems.length ? overrideItems : j(tpl.items, []);
  const base = start_date ? new Date(start_date) : new Date();
  const SQL = `INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,weight,order_index)
    VALUES(?,?,?,?,?,?,'todo',?,?,?,?,?,?,?)`;

  const stmts = items.map((it, i) => {
    const s = new Date(base.getTime() + (Number(it.offset_days) || 0) * 86400000);
    const d = new Date(s.getTime() + (Number(it.duration_days) || 3) * 86400000);
    return [SQL, [req.ctx.tenantId, bid, term.id, committee_id || null, it.title,
      it.description || `مُنشأة من القالب: ${tpl.name}`, it.priority || 'medium',
      assignee_map[it.title] || it.assignee_id || null, req.ctx.userId,
      s.toISOString().slice(0, 10), d.toISOString().slice(0, 10), Number(it.weight) || 1, i]];
  });
  const res = await app.db.batch(stmts);
  const ids = res.map(r => r.lastId);

  await audit(req, { action: 'create', entity: 'task', entityId: ids.join(','),
    summary: `استنساخ القالب (${tpl.name}) إلى ${ids.length} مهمة في ${term.name}` });
  const assignees = Object.values(assignee_map).filter(Boolean);
  if (assignees.length) await notifyUsers(app, req.ctx.tenantId, assignees, {
    type: 'task.assigned', category: 'tasks', title: 'مهام جديدة من قالب',
    body: `أُسندت إليك مهام ضمن "${tpl.name}"`, url: '/tasks'
  });
  return created({ created: ids.length, ids });
}));

/* ─────────────── المهام ─────────────── */
function taskQuery(req) {
  const sc = scoped(req.ctx, { alias: 't' });
  let sql = `SELECT t.*, u.name AS assignee_name, u.avatar_url AS assignee_avatar, c.name AS committee_name,
      c.color AS committee_color, b.name AS branch_name, cu.name AS creator_name,
      tm.status AS term_status, tm.name AS term_name,
      (SELECT COUNT(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
        WHERE cv.context_type='task' AND cv.context_id=t.id) AS comments_count
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
  if (q.status) { const parts = String(q.status).split(','); sql += ` AND t.status IN (${parts.map(() => '?').join(',')})`; params.push(...parts); }
  if (q.priority) { sql += ' AND t.priority=?'; params.push(q.priority); }
  if (q.mine === '1') { sql += ' AND t.assignee_id=?'; params.push(req.ctx.userId); }
  if (q.overdue === '1') sql += ` AND t.status<>'done' AND t.due_date < date('now')`;
  if (q.q) { sql += ' AND (t.title LIKE ? OR t.description LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  sql += ' ORDER BY t.order_index, t.due_date, t.id DESC';
  return { sql, params };
}

router.get('/', can('tasks.view', 'tasks.view_all'), h(async (req) => {
  const { sql, params } = taskQuery(req);
  const rows = await req.app.db.all(sql, ...params);
  const deps = await req.app.db.all('SELECT task_id, depends_on_id, type FROM task_dependencies WHERE tenant_id=?', req.ctx.tenantId);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map(t => ({
    ...t,
    status_ar: STATUS_AR[t.status] || t.status,
    is_locked: ['closed', 'archived'].includes(t.term_status),
    is_overdue: t.status !== 'done' && !!t.due_date && t.due_date < today,
    depends_on: deps.filter(d => d.task_id === t.id).map(d => d.depends_on_id)
  }));
}));

/** بيانات مخطط جانت جاهزة للرسم مع الاعتماديات */
router.get('/view/gantt', can('tasks.view', 'tasks.view_all'), h(async (req) => {
  const { sql, params } = taskQuery(req);
  const rows = await req.app.db.all(sql, ...params);
  const deps = await req.app.db.all('SELECT task_id, depends_on_id FROM task_dependencies WHERE tenant_id=?', req.ctx.tenantId);
  const items = rows.filter(t => t.start_date || t.due_date).map(t => ({
    id: t.id, title: t.title, status: t.status, progress: t.progress,
    color: t.committee_color || '#2F8A6F', assignee: t.assignee_name,
    start: t.start_date || t.due_date, end: t.due_date || t.start_date,
    depends_on: deps.filter(d => d.task_id === t.id).map(d => d.depends_on_id)
  }));
  return { items, total: rows.length };
}));

/** إعادة ترتيب بطاقات كانبان */
router.post('/reorder', can('tasks.update'), h(async (req) => {
  const app = req.app;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const stmts = [];
  for (const [i, it] of items.entries()) {
    if (!STATUSES.includes(it.status)) continue;
    const t = await findScoped(app, req.ctx, 'tasks', it.id, { branchCheck: true });
    if (!t || await termIsClosed(app, req.ctx.tenantId, t.term_id)) continue;
    stmts.push(['UPDATE tasks SET order_index=?, status=?, updated_at=? WHERE id=? AND tenant_id=?',
      [it.order_index ?? i, it.status, nowUTC(), it.id, req.ctx.tenantId]]);
  }
  if (stmts.length) await app.db.batch(stmts);
  return { ok: true, updated: stmts.length };
}));

router.get('/:id', can('tasks.view', 'tasks.view_all'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (!has(req.ctx, 'tasks.view_all') && t.assignee_id !== req.ctx.userId && t.created_by !== req.ctx.userId)
    throw forbidden('لا تملك صلاحية عرض هذه المهمة');
  const deps = await app.db.all(`SELECT d.depends_on_id, t2.title FROM task_dependencies d
    JOIN tasks t2 ON t2.id=d.depends_on_id WHERE d.task_id=?`, t.id);
  const term = t.term_id ? await app.db.get('SELECT status FROM terms WHERE id=?', t.term_id) : null;
  const today = new Date().toISOString().slice(0, 10);
  return { ...t, status_ar: STATUS_AR[t.status], depends_on: deps,
    term_status: term?.status || null,
    is_locked: ['closed', 'archived'].includes(term?.status),
    is_overdue: t.status !== 'done' && !!t.due_date && t.due_date < today };
}));

router.post('/', can('tasks.create'), h(async (req) => {
  const app = req.app;
  const p = req.body || {};
  if (!p.title) throw badRequest('عنوان المهمة إلزامي');
  const term = p.term_id ? await findScoped(app, req.ctx, 'terms', p.term_id) : await currentTerm(app, req.ctx.tenantId);
  if (term && ['closed', 'archived'].includes(term.status)) throw locked();
  const bid = p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const r = await app.db.run(
    `INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,weight,order_index)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, bid, term?.id || null, p.committee_id || null, String(p.title).trim(), p.description || null,
    STATUSES.includes(p.status) ? p.status : 'todo', p.priority || 'medium',
    p.assignee_id || null, req.ctx.userId, p.start_date || null, p.due_date || null,
    Number(p.weight) || 1, Number(p.order_index) || 0);

  if (Array.isArray(p.depends_on) && p.depends_on.length) {
    await app.db.batch(p.depends_on.map(d =>
      ['INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)',
        [req.ctx.tenantId, r.lastId, d, 'FS']]));
  }

  await audit(req, { action: 'create', entity: 'task', entityId: r.lastId,
    summary: `${req.ctx.userName} أنشأ المهمة (${p.title})`, branchId: bid });
  if (p.assignee_id) await notifyUsers(app, req.ctx.tenantId, [p.assignee_id], {
    type: 'task.assigned', category: 'tasks', title: 'أُسندت إليك مهمة جديدة',
    body: `${p.title}${p.due_date ? ' — تستحق بتاريخ ' + p.due_date : ''}`,
    url: `/tasks?id=${r.lastId}`, data: { id: r.lastId }, urgency: 'high'
  });
  return created(await app.db.get('SELECT * FROM tasks WHERE id=?', r.lastId));
}));

router.patch('/:id', can('tasks.update'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (await termIsClosed(app, req.ctx.tenantId, t.term_id)) throw locked();
  const mine = t.assignee_id === req.ctx.userId || t.created_by === req.ctx.userId;
  if (!mine && !has(req.ctx, 'tasks.view_all')) throw forbidden('لا تملك صلاحية تعديل هذه المهمة');

  const p = req.body || {};
  if (p.assignee_id !== undefined && p.assignee_id !== t.assignee_id && !has(req.ctx, 'tasks.assign'))
    throw forbidden('تحتاج صلاحية إسناد المهام');

  const status = STATUSES.includes(p.status) ? p.status : t.status;
  const progress = p.progress !== undefined ? Math.max(0, Math.min(100, Number(p.progress)))
    : (status === 'done' ? 100 : t.progress);

  await app.db.run(
    `UPDATE tasks SET title=?,description=?,status=?,priority=?,assignee_id=?,committee_id=?,
      start_date=?,due_date=?,progress=?,weight=?,order_index=?,completed_at=?,updated_at=? WHERE id=? AND tenant_id=?`,
    p.title ?? t.title, p.description ?? t.description, status, p.priority ?? t.priority,
    p.assignee_id !== undefined ? p.assignee_id : t.assignee_id,
    p.committee_id !== undefined ? p.committee_id : t.committee_id,
    /*
     * التاريخان يُمحيان بإرسال `null` صريح — و`??` كانت تردّه إلى القيمة
     * القديمة فيتعذّر مسحُ تاريخٍ وُضع خطأً. والفارق بين «لم يُرسَل» و«أُرسل
     * فارغاً» هو `undefined` لا `null`.
     */
    p.start_date !== undefined ? (p.start_date || null) : t.start_date,
    p.due_date !== undefined ? (p.due_date || null) : t.due_date, progress,
    Number(p.weight) || t.weight, p.order_index ?? t.order_index,
    status === 'done' ? (t.completed_at || nowUTC()) : null, nowUTC(), t.id, req.ctx.tenantId);

  if (Array.isArray(p.depends_on)) {
    await app.db.batch([
      ['DELETE FROM task_dependencies WHERE task_id=?', [t.id]],
      ...p.depends_on.filter(d => Number(d) !== t.id).map(d =>
        ['INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)',
          [req.ctx.tenantId, t.id, d, 'FS']])
    ]);
  }

  const changed = status !== t.status;
  await audit(req, {
    action: 'update', entity: 'task', entityId: t.id, branchId: t.branch_id,
    summary: changed
      ? `${req.ctx.userName} غيّر حالة المهمة (${t.title}) من "${STATUS_AR[t.status]}" إلى "${STATUS_AR[status]}"`
      : `${req.ctx.userName} عدّل المهمة (${t.title})`,
    before: { status: t.status, progress: t.progress, assignee_id: t.assignee_id },
    after: { status, progress, assignee_id: p.assignee_id ?? t.assignee_id }
  });

  const watchers = [...new Set([t.created_by, t.assignee_id, p.assignee_id].filter(x => x && x !== req.ctx.userId))];
  if (changed && watchers.length) await notifyUsers(app, req.ctx.tenantId, watchers, {
    type: 'task.status', category: 'tasks', title: 'تحديث حالة مهمة',
    /* السهم في RTL يشير يساراً — «صارت الحالة» لا «رجعت» (دليل الهوية · البند ٨) */
    body: `${t.title} ← ${STATUS_AR[status]}`, url: `/tasks?id=${t.id}`, data: { id: t.id }
  });
  if (p.assignee_id && p.assignee_id !== t.assignee_id) await notifyUsers(app, req.ctx.tenantId, [p.assignee_id], {
    type: 'task.assigned', category: 'tasks', title: 'أُسندت إليك مهمة',
    body: t.title, url: `/tasks?id=${t.id}`, data: { id: t.id }, urgency: 'high'
  });
  app.realtime?.emitToUsers?.(req.ctx.tenantId, watchers, { type: 'task.updated', taskId: t.id });

  return app.db.get('SELECT * FROM tasks WHERE id=?', t.id);
}));

router.delete('/:id', can('tasks.delete'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tasks', req.params.id, { branchCheck: true });
  if (!t) throw notFound('المهمة غير موجودة');
  if (await termIsClosed(app, req.ctx.tenantId, t.term_id)) throw locked();
  await app.db.run('DELETE FROM tasks WHERE id=? AND tenant_id=?', t.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'task', entityId: t.id,
    summary: `${req.ctx.userName} حذف المهمة (${t.title})`, before: t });
  return { ok: true };
}));

export default router;
