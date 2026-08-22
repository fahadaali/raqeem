import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, findScoped, nextNumber } from '../scope.js';
import { notifyUsers, notifyByPermission } from '../notify.js';
import { requireFeature } from '../features.js';

const router = new Hono();

/* ═══════ مربع المحادثة السياقي (البند ٨) ═══════ */
const CONTEXTS = ['task', 'finance_request', 'invoice', 'ticket', 'committee'];

/** من يحق له رؤية محادثة سياق معيّن — المرتبطون بهذا العنصر فقط */
async function contextMembers(app, ctx, type, id) {
  const set = new Set();
  if (type === 'task') {
    const t = await app.db.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!t) return null;
    [t.assignee_id, t.created_by].forEach(x => x && set.add(x));
    if (t.committee_id) {
      (await app.db.all('SELECT user_id FROM committee_members WHERE committee_id=?', t.committee_id))
        .forEach(m => set.add(m.user_id));
    }
    return { members: set, title: t.title, branchId: t.branch_id };
  }
  if (type === 'finance_request') {
    const r = await app.db.get('SELECT * FROM finance_requests WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!r) return null;
    set.add(r.requester_id);
    (await app.db.all('SELECT approver_id FROM finance_approvals WHERE request_id=?', r.id))
      .forEach(a => a.approver_id && set.add(a.approver_id));
    (await app.db.all(`SELECT DISTINCT u.id FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id
       WHERE u.tenant_id=? AND rp.permission_key IN ('finance.approve_supervisor','finance.approve_finance','finance.manage')`,
      ctx.tenantId)).forEach(u => set.add(u.id));
    return { members: set, title: `${r.number} — ${r.title}`, branchId: r.branch_id };
  }
  if (type === 'invoice') {
    const i = await app.db.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!i) return null;
    if (i.created_by) set.add(i.created_by);
    (await app.db.all(`SELECT DISTINCT u.id FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id
       WHERE u.tenant_id=? AND rp.permission_key='invoices.manage'`, ctx.tenantId)).forEach(u => set.add(u.id));
    return { members: set, title: `فاتورة ${i.number}`, branchId: i.branch_id };
  }
  if (type === 'ticket') {
    const t = await app.db.get('SELECT * FROM tickets WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!t) return null;
    [t.requester_id, t.assignee_id].forEach(x => x && set.add(x));
    return { members: set, title: `${t.number} — ${t.subject}`, branchId: t.branch_id };
  }
  if (type === 'committee') {
    const c = await app.db.get('SELECT * FROM committees WHERE id=? AND tenant_id=?', id, ctx.tenantId);
    if (!c) return null;
    (await app.db.all('SELECT user_id FROM committee_members WHERE committee_id=?', c.id)).forEach(m => set.add(m.user_id));
    if (c.lead_user_id) set.add(c.lead_user_id);
    return { members: set, title: c.name, branchId: c.branch_id };
  }
  return null;
}

async function ensureConversation(app, ctx, type, id) {
  const info = await contextMembers(app, ctx, type, id);
  if (!info) throw notFound('السياق المرتبط بالمحادثة غير موجود');
  let conv = await app.db.get('SELECT * FROM conversations WHERE tenant_id=? AND context_type=? AND context_id=?',
    ctx.tenantId, type, id);
  if (!conv) {
    const r = await app.db.run('INSERT INTO conversations(tenant_id,branch_id,context_type,context_id,title) VALUES(?,?,?,?,?)',
      ctx.tenantId, info.branchId || null, type, id, info.title);
    conv = await app.db.get('SELECT * FROM conversations WHERE id=?', r.lastId);
  }
  const members = [...info.members];
  if (members.length) await app.db.batch(members.map(m =>
    ['INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id) VALUES(?,?,?)', [ctx.tenantId, conv.id, m]]));
  return { conv, members };
}

/*
 * البوابة على مستوى المسار لا على مستوى الوحدة كلها:
 * خطة قد تمنح مركز التذاكر دون المحادثات السياقية — والعكس.
 */
router.use('/tickets', requireFeature('tickets'));
router.use('/tickets/*', requireFeature('tickets'));
router.use('/conversations', requireFeature('chat'));
router.use('/conversations/*', requireFeature('chat'));

router.get('/conversations', can('chat.use'), h(async (req) =>
  req.app.db.all(`SELECT c.*,
      (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS messages_count,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id
         AND m.created_at > COALESCE(cm.last_read_at,'1970-01-01') AND m.user_id<>?) AS unread
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
    WHERE c.tenant_id=? ORDER BY last_at DESC LIMIT 100`,
    req.ctx.userId, req.ctx.userId, req.ctx.tenantId)));

router.get('/conversations/:type/:id/messages', can('chat.use'), h(async (req) => {
  const app = req.app;
  const { type, id } = req.params;
  if (!CONTEXTS.includes(type)) throw badRequest('نوع سياق غير مدعوم');
  const { conv, members } = await ensureConversation(app, req.ctx, type, Number(id));
  if (!members.includes(req.ctx.userId) && !['owner', 'auditor'].includes(req.ctx.roleKey))
    throw forbidden('هذه المحادثة مقصورة على المرتبطين بهذا العنصر');
  const rows = await app.db.all(`SELECT m.*, u.name AS user_name, u.avatar_url FROM messages m
    JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? ORDER BY m.id ASC LIMIT 500`, conv.id);
  await app.db.run('UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?',
    nowUTC(), conv.id, req.ctx.userId);
  return { conversation: conv, members,
    messages: rows.map(m => ({ ...m, attachments: j(m.attachments, []), mine: m.user_id === req.ctx.userId })) };
}));

router.post('/conversations/:type/:id/messages', can('chat.use'), h(async (req) => {
  const app = req.app;
  const { type, id } = req.params;
  if (!CONTEXTS.includes(type)) throw badRequest('نوع سياق غير مدعوم');
  const body = String(req.body?.body || '').trim();
  if (!body) throw badRequest('لا يمكن إرسال رسالة فارغة');
  if (body.length > 4000) throw badRequest('الرسالة طويلة جداً');

  const { conv, members } = await ensureConversation(app, req.ctx, type, Number(id));
  if (!members.includes(req.ctx.userId) && req.ctx.roleKey !== 'owner')
    throw forbidden('لا يمكنك المشاركة في هذه المحادثة');

  const r = await app.db.run('INSERT INTO messages(tenant_id,conversation_id,user_id,body,attachments) VALUES(?,?,?,?,?)',
    req.ctx.tenantId, conv.id, req.ctx.userId, body, JSON.stringify(req.body?.attachments || []));
  const msg = await app.db.get(
    'SELECT m.*, u.name AS user_name FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?', r.lastId);

  const others = members.filter(m => m !== req.ctx.userId);
  app.realtime?.emitToUsers?.(req.ctx.tenantId, others, { type: 'chat.message', conversationId: conv.id, message: msg });
  await notifyUsers(app, req.ctx.tenantId, others, {
    type: 'chat.message', category: 'chat', title: `رسالة جديدة — ${conv.title || 'محادثة'}`,
    body: `${req.ctx.userName}: ${body.slice(0, 90)}`,
    url: `/${type === 'finance_request' ? 'finance' : type === 'ticket' ? 'tickets' : 'tasks'}?id=${id}&chat=1`,
    data: { conversationId: conv.id, contextType: type, contextId: Number(id) }
  });
  return created({ ...msg, attachments: j(msg.attachments, []), mine: true });
}));

/* ═══════ مركز التذاكر واتفاقيات مستوى الخدمة ═══════ */
const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];

router.get('/tickets', can('tickets.create', 'tickets.view_all'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 't' });
  let sql = `SELECT t.*, u.name AS requester_name, a.name AS assignee_name, b.name AS branch_name,
      (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id=t.id) AS replies_count,
      CASE WHEN t.status IN ('open','in_progress') AND t.sla_due_at < ? THEN 1 ELSE 0 END AS sla_breached
    FROM tickets t JOIN users u ON u.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id
    LEFT JOIN branches b ON b.id=t.branch_id WHERE ${sc.where}`;
  const params = [nowUTC(), ...sc.params];
  if (!has(req.ctx, 'tickets.view_all')) { sql += ' AND t.requester_id=?'; params.push(req.ctx.userId); }
  if (req.query.status) { const parts = String(req.query.status).split(','); sql += ` AND t.status IN (${parts.map(() => '?').join(',')})`; params.push(...parts); }
  if (req.query.priority) { sql += ' AND t.priority=?'; params.push(req.query.priority); }
  if (req.query.assignee_id) { sql += ' AND t.assignee_id=?'; params.push(Number(req.query.assignee_id)); }
  sql += ` ORDER BY t.escalated DESC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at DESC LIMIT 300`;
  return req.app.db.all(sql, ...params);
}));

router.get('/tickets/:id', can('tickets.create', 'tickets.view_all'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tickets', req.params.id, { branchCheck: true });
  if (!t) throw notFound('التذكرة غير موجودة');
  if (!has(req.ctx, 'tickets.view_all') && t.requester_id !== req.ctx.userId) throw forbidden();
  const replies = await app.db.all(`SELECT r.*, u.name AS user_name FROM ticket_replies r JOIN users u ON u.id=r.user_id
    WHERE r.ticket_id=? ${has(req.ctx, 'tickets.manage') ? '' : 'AND r.is_internal=0'} ORDER BY r.id`, t.id);
  return { ...t, replies, vendor: t.vendor_escalated ? {
    escalated_at: t.vendor_escalated_at, status: t.vendor_status,
    reply: t.vendor_reply, replied_at: t.vendor_replied_at
  } : null };
}));

/** تصعيد تذكرة إلى مزوّد المنصة — تظهر في صندوق الدعم الموحّد لديه */
router.post('/tickets/:id/escalate-vendor', can('tickets.manage'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tickets', req.params.id);
  if (!t) throw notFound('التذكرة غير موجودة');
  if (t.vendor_escalated) return { ok: true, already: true, status: t.vendor_status };
  await app.db.run(
    `UPDATE tickets SET vendor_escalated=1, vendor_escalated_at=?, vendor_status='open' WHERE id=?`,
    nowUTC(), t.id);
  await audit(req, { action: 'update', entity: 'ticket', entityId: t.id,
    summary: `${req.ctx.userName} صعّد التذكرة (${t.subject}) إلى دعم المنصة` });
  return { ok: true, status: 'open' };
}));

router.post('/tickets', can('tickets.create'), h(async (req) => {
  const app = req.app;
  const { subject, body, category, priority } = req.body || {};
  if (!subject) throw badRequest('عنوان التذكرة إلزامي');
  const slaHours = Number(req.ctx.tenantSettings?.ticket_sla_hours ?? 24);
  const due = new Date(Date.now() + slaHours * 3600000).toISOString();
  const number = await nextNumber(app, req.ctx.tenantId, 'tickets', 'TK');
  const r = await app.db.run(
    `INSERT INTO tickets(tenant_id,branch_id,number,subject,body,category,priority,requester_id,sla_hours,sla_due_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId, number, String(subject).trim(),
    body || null, category || 'general', priority || 'medium', req.ctx.userId, slaHours, due);
  await audit(req, { action: 'create', entity: 'ticket', entityId: r.lastId, summary: `رفع تذكرة دعم ${number}: ${subject}` });
  await notifyByPermission(app, req.ctx.tenantId, 'tickets.manage', {
    type: 'ticket.created', category: 'tickets', title: `تذكرة دعم جديدة (${number})`,
    body: `${subject} — الأهمية: ${priority || 'medium'}`, url: `/tickets?id=${r.lastId}`,
    data: { id: r.lastId }, urgency: priority === 'urgent' ? 'high' : 'normal'
  });
  return created({ id: r.lastId, number, sla_due_at: due });
}));

router.post('/tickets/:id/reply', can('tickets.create', 'tickets.manage'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tickets', req.params.id, { branchCheck: true });
  if (!t) throw notFound('التذكرة غير موجودة');
  const isSupport = has(req.ctx, 'tickets.manage');
  if (!isSupport && t.requester_id !== req.ctx.userId) throw forbidden();
  const body = String(req.body?.body || '').trim();
  if (!body) throw badRequest('نص الرد مطلوب');
  const internal = isSupport && req.body?.is_internal ? 1 : 0;

  const stmts = [['INSERT INTO ticket_replies(tenant_id,ticket_id,user_id,body,is_internal) VALUES(?,?,?,?,?)',
    [req.ctx.tenantId, t.id, req.ctx.userId, body, internal]]];
  if (isSupport && !t.first_response_at) {
    stmts.push([`UPDATE tickets SET first_response_at=?, status=CASE WHEN status='open' THEN 'in_progress' ELSE status END,
      assignee_id=COALESCE(assignee_id,?), updated_at=? WHERE id=?`, [nowUTC(), req.ctx.userId, nowUTC(), t.id]]);
  } else {
    stmts.push(['UPDATE tickets SET updated_at=? WHERE id=?', [nowUTC(), t.id]]);
  }
  await app.db.batch(stmts);
  await audit(req, { action: 'update', entity: 'ticket', entityId: t.id, summary: `رد على التذكرة ${t.number}` });

  if (!internal) {
    const target = isSupport ? [t.requester_id] : [t.assignee_id].filter(Boolean);
    await notifyUsers(app, req.ctx.tenantId, target, {
      type: 'ticket.reply', category: 'tickets', title: `رد جديد على التذكرة ${t.number}`,
      body: body.slice(0, 100), url: `/tickets?id=${t.id}`, data: { id: t.id }
    });
    if (!isSupport && !t.assignee_id) await notifyByPermission(app, req.ctx.tenantId, 'tickets.manage', {
      type: 'ticket.reply', category: 'tickets', title: `تحديث على التذكرة ${t.number}`,
      body: body.slice(0, 100), url: `/tickets?id=${t.id}`, data: { id: t.id }
    });
  }
  return created({ ok: true });
}));

router.patch('/tickets/:id', can('tickets.manage'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'tickets', req.params.id, { branchCheck: true });
  if (!t) throw notFound('التذكرة غير موجودة');
  const p = req.body || {};
  const st = TICKET_STATUS.includes(p.status) ? p.status : t.status;
  await app.db.run(
    `UPDATE tickets SET status=?, priority=?, assignee_id=?, category=?, closed_at=?, updated_at=? WHERE id=? AND tenant_id=?`,
    st, p.priority ?? t.priority, p.assignee_id !== undefined ? p.assignee_id : t.assignee_id,
    p.category ?? t.category, ['resolved', 'closed'].includes(st) ? (t.closed_at || nowUTC()) : null,
    nowUTC(), t.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'ticket', entityId: t.id,
    summary: `تحديث التذكرة ${t.number} — الحالة: ${st}`, before: { status: t.status }, after: { status: st } });
  if (st !== t.status) await notifyUsers(app, req.ctx.tenantId, [t.requester_id], {
    type: 'ticket.status', category: 'tickets', title: `تحديث حالة التذكرة ${t.number}`,
    body: { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم حلها', closed: 'مغلقة' }[st],
    url: `/tickets?id=${t.id}`, data: { id: t.id }
  });
  return { ok: true, status: st };
}));

export default router;
