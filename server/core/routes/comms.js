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
router.use('/chats', requireFeature('chat'));
router.use('/chats/*', requireFeature('chat'));
router.use('/directory', requireFeature('chat'));
router.use('/unread', requireFeature('chat'));

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

/* ═══════ المحادثات المستقلة: خاصّة ومجموعات (شاشة «المحادثات») ═══════
 *
 * المحادثة السياقية أعلاه تولد مع عنصرها وتموت به، وأعضاؤها من يرتبط بذلك
 * العنصر. وهذه غيرها: يُنشئها المنسوبون لأنفسهم — اثنان يتحادثان، أو مجموعةٌ
 * لها اسمٌ ووصفٌ وصورة.
 *
 * ومن يُضاف إليها محكومٌ بالصلاحية المتدرّجة لا بالرغبة:
 *
 *   مدير المجمّع  →  كلُّ منسوبي المجمّع (صلاحيته على الفروع كلّها)
 *   مدير الفرع    →  كلُّ من يعمل في فروعه — ولو كان يعمل في غيرها أيضاً،
 *                     فالعبرة بجدول `user_branches` لا بالفرع الرئيس وحده
 *   مدير اللجنة   →  أعضاء لجانه أينما كانوا
 *   المنسوب       →  زملاء فرعه وأعضاء لجانه
 *
 * وهذا كلُّه في `reachableUsers` — مصدرٌ واحدٌ يقرؤه دليلُ المنسوبين وتُحرَس به
 * إضافةُ الأعضاء معاً، فلا تُعرض قائمةٌ لا تُقبل إضافتُها.
 */

const CHAT_KINDS = ['direct', 'group'];
const MSG_KINDS = ['text', 'voice', 'file'];
const MAX_BODY = 4000;

/**
 * من يبلغهم هذا المستخدم — مصفوفةُ منسوبين، لكلٍّ منهم سببُ بلوغه.
 * والسبب يُعرض في المنتقي مجموعةً («فرع النرجس»، «لجنة التقنية»)، فيعرف
 * المضيفُ من أين جاء هذا الاسم.
 */
async function reachableUsers(app, ctx) {
  const rows = [];
  const seen = new Map();
  const add = (u, group) => {
    if (u.id === ctx.userId) return;
    if (seen.has(u.id)) return;
    seen.set(u.id, true);
    rows.push({ ...u, group });
  };

  const SELECT = `SELECT DISTINCT u.id, u.name, u.avatar_url, r.name AS role_name,
      b.name AS branch_name, e.job_title
    FROM users u JOIN roles r ON r.id=u.role_id
    LEFT JOIN branches b ON b.id=u.primary_branch_id
    LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id`;

  if (ctx.allBranches) {
    const all = await app.db.all(
      `${SELECT} WHERE u.tenant_id=? AND u.status='active' ORDER BY u.name`, ctx.tenantId);
    for (const u of all) add(u, 'كل المنسوبين');
    return { scope: 'all', users: rows };
  }

  /* زملاء الفروع — بالتعيين لا بالفرع الرئيس وحده */
  const ids = ctx.branchIds || [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const mates = await app.db.all(
      `${SELECT}
        WHERE u.tenant_id=? AND u.status='active'
          AND (u.primary_branch_id IN (${marks})
               OR EXISTS (SELECT 1 FROM user_branches ub
                          WHERE ub.user_id=u.id AND ub.tenant_id=u.tenant_id AND ub.branch_id IN (${marks})))
        ORDER BY u.name`,
      ctx.tenantId, ...ids, ...ids);
    for (const u of mates) add(u, 'زملاء فروعي');
  }

  /* أعضاء اللجان التي أقودها أو أنتمي إليها */
  const mates2 = await app.db.all(
    `${SELECT}
       JOIN committee_members cm ON cm.user_id=u.id AND cm.tenant_id=u.tenant_id
      WHERE u.tenant_id=? AND u.status='active' AND cm.committee_id IN (
        SELECT c.id FROM committees c WHERE c.tenant_id=? AND c.lead_user_id=?
        UNION SELECT cm2.committee_id FROM committee_members cm2 WHERE cm2.tenant_id=? AND cm2.user_id=?)
      ORDER BY u.name`,
    ctx.tenantId, ctx.tenantId, ctx.userId, ctx.tenantId, ctx.userId);
  for (const u of mates2) add(u, 'أعضاء لجاني');

  /* ورؤساء اللجان التي أنتمي إليها — قد لا يكونون أعضاءً مسجَّلين فيها */
  const leads = await app.db.all(
    `${SELECT}
      WHERE u.tenant_id=? AND u.status='active' AND u.id IN (
        SELECT c.lead_user_id FROM committees c
         WHERE c.tenant_id=? AND c.lead_user_id IS NOT NULL AND c.id IN (
           SELECT cm.committee_id FROM committee_members cm WHERE cm.tenant_id=? AND cm.user_id=?))
      ORDER BY u.name`,
    ctx.tenantId, ctx.tenantId, ctx.tenantId, ctx.userId);
  for (const u of leads) add(u, 'رؤساء لجاني');

  return { scope: ids.length ? 'branch' : 'committee', users: rows };
}

/** هل يبلغ هذا المستخدمَ من يريد إضافته؟ — الحارس الذي تمرّ به كلُّ إضافة */
async function assertReachable(app, ctx, userIds) {
  const wanted = [...new Set((userIds || []).map(Number).filter(n => n && n !== ctx.userId))];
  if (!wanted.length) return [];
  const { users } = await reachableUsers(app, ctx);
  const pool = new Set(users.map(u => u.id));
  const out = wanted.filter(id => pool.has(id));
  if (out.length !== wanted.length) {
    const blocked = wanted.filter(id => !pool.has(id));
    const names = await app.db.all(
      `SELECT name FROM users WHERE tenant_id=? AND id IN (${blocked.map(() => '?').join(',')})`,
      ctx.tenantId, ...blocked);
    throw forbidden(names.length
      ? `لا تملك صلاحية إضافة: ${names.map(n => n.name).join('، ')} — أضف من يعمل في فروعك أو لجانك`
      : 'لا تملك صلاحية إضافة هؤلاء المنسوبين');
  }
  return out;
}

/** عضويةُ المستخدم في محادثة — بابُ كل قراءةٍ وكتابةٍ فيها */
const membership = (app, ctx, convId) => app.db.get(
  'SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?', convId, ctx.userId);

/** محادثةٌ يملك المستخدم دخولها، وإلا فهي «غير موجودة» عنده */
async function openChat(app, ctx, id, { admin = false } = {}) {
  const conv = await app.db.get('SELECT * FROM conversations WHERE id=? AND tenant_id=?',
    Number(id) || 0, ctx.tenantId);
  if (!conv) throw notFound('المحادثة غير موجودة');
  const me = await membership(app, ctx, conv.id);
  if (!me) throw forbidden('لست عضواً في هذه المحادثة');
  if (admin && me.role_in !== 'admin') throw forbidden('هذا الإجراء لمشرفي المجموعة');
  return { conv, me };
}

/**
 * المرفقات تُبنى من معرّفات ملفاتٍ في مخزن الجهة لا مما يرسله المتصفّح.
 * فلو أُرسل رابطٌ ملفَّقٌ لم يُخزَّن، والرسالة تشير دائماً إلى ملفٍّ حقيقيٍّ
 * تملكه الجهة نفسها.
 */
async function resolveAttachments(app, tenantId, input) {
  const ids = Array.isArray(input?.attachment_ids)
    ? input.attachment_ids
    : (Array.isArray(input?.attachments) ? input.attachments.map(a => a?.id) : []);
  const list = [...new Set(ids.map(Number).filter(Boolean))].slice(0, 10);
  if (!list.length) return [];
  const files = await app.db.all(
    `SELECT id, original_name, mime, size FROM files WHERE tenant_id=? AND id IN (${list.map(() => '?').join(',')})`,
    tenantId, ...list);
  return files.map(f => ({
    id: f.id, name: f.original_name, mime: f.mime, size: f.size, url: `/api/files/${f.id}`
  }));
}

/** صورةُ المجموعة ملفٌّ في مخزن الجهة — لا رابطٌ خارجيٌّ يُكتب باليد */
async function resolveAvatar(app, tenantId, fileId) {
  if (fileId === null || fileId === '') return null;
  const f = await app.db.get('SELECT id, mime FROM files WHERE id=? AND tenant_id=?', Number(fileId) || 0, tenantId);
  if (!f) throw badRequest('الصورة غير موجودة — ارفعها أولاً');
  if (!String(f.mime || '').startsWith('image/')) throw badRequest('صورة العرض يجب أن تكون صورة');
  return `/api/files/${f.id}`;
}

/** رسالةٌ نظاميّةٌ تُثبِّت ما جرى في الخيط: من أُضيف، ومن غادر، ومن غيّر الاسم */
const systemMessage = (app, ctx, convId, text) => app.db.batch([
  ['INSERT INTO messages(tenant_id,conversation_id,user_id,body,kind) VALUES(?,?,?,?,\'system\')',
    [ctx.tenantId, convId, ctx.userId, text]],
  ['UPDATE conversations SET last_at=? WHERE id=?', [nowUTC(), convId]]
]);

const shapeMessage = (m, userId) => ({
  ...m,
  attachments: j(m.attachments, []),
  body: m.deleted_at ? '' : m.body,
  deleted: !!m.deleted_at,
  mine: m.user_id === userId
});

/** عنوان المحادثة كما يراه هذا العضو — الخاصّة تُسمّى باسم الطرف الآخر */
const titleFor = (row, userId) => (row.context_type === 'direct'
  ? (row.other_name || 'محادثة خاصة')
  : (row.title || 'مجموعة'));

router.get('/chats', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const rows = await app.db.all(
    `SELECT c.*, cm.last_read_at, cm.role_in, cm.muted,
        (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id) AS members_count,
        (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT kind FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
        (SELECT u.name FROM messages m JOIN users u ON u.id=m.user_id
          WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_by,
        (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id
           AND m.created_at > COALESCE(cm.last_read_at,'1970-01-01') AND m.user_id<>?) AS unread,
        (SELECT u.name FROM conversation_members o JOIN users u ON u.id=o.user_id
          WHERE o.conversation_id=c.id AND o.user_id<>? LIMIT 1) AS other_name,
        (SELECT u.id FROM conversation_members o JOIN users u ON u.id=o.user_id
          WHERE o.conversation_id=c.id AND o.user_id<>? LIMIT 1) AS other_id,
        (SELECT u.avatar_url FROM conversation_members o JOIN users u ON u.id=o.user_id
          WHERE o.conversation_id=c.id AND o.user_id<>? LIMIT 1) AS other_avatar
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
     WHERE c.tenant_id=?
     ORDER BY COALESCE(last_message_at, c.last_at, c.created_at) DESC LIMIT 200`,
    ctx.userId, ctx.userId, ctx.userId, ctx.userId, ctx.userId, ctx.tenantId);

  return rows.map(r => ({
    id: r.id,
    kind: CHAT_KINDS.includes(r.context_type) ? r.context_type : 'context',
    context_type: r.context_type, context_id: r.context_id,
    title: titleFor(r, ctx.userId),
    description: r.description || null,
    avatar_url: r.context_type === 'direct' ? (r.other_avatar || null) : (r.avatar_url || null),
    other_id: r.context_type === 'direct' ? r.other_id : null,
    members_count: r.members_count, role_in: r.role_in || 'member', muted: !!r.muted,
    unread: r.unread || 0,
    last_message: r.last_kind === 'voice' ? 'رسالة صوتية'
      : r.last_kind === 'file' ? 'مرفق'
        : (r.last_body || null),
    last_by: r.last_by || null,
    last_at: r.last_message_at || r.last_at || r.created_at
  }));
}));

/** عدّاد المحادثات غير المقروءة — يُعلَّق شارةً على أيقونة الشاشة */
router.get('/unread', can('chat.use'), h(async (req) => {
  const row = await req.app.db.get(
    `SELECT COUNT(*) AS threads, COALESCE(SUM(n),0) AS messages FROM (
        SELECT (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id
                  AND m.created_at > COALESCE(cm.last_read_at,'1970-01-01') AND m.user_id<>?) AS n
          FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
         WHERE c.tenant_id=?) t WHERE n > 0`,
    req.ctx.userId, req.ctx.userId, req.ctx.tenantId);
  return { threads: row?.threads || 0, messages: row?.messages || 0 };
}));

/** دليل من يبلغهم المستخدم — قائمةُ من يصحّ محادثتُهم وإضافتُهم */
router.get('/directory', can('chat.use'), h(async (req) => {
  const { scope, users } = await reachableUsers(req.app, req.ctx);
  return {
    scope,
    scope_label: { all: 'كل منسوبي المجمّع', branch: 'منسوبو فروعك ولجانك', committee: 'أعضاء لجانك' }[scope],
    users
  };
}));

router.post('/chats', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const p = req.body || {};
  const kind = CHAT_KINDS.includes(p.kind) ? p.kind : 'direct';

  if (kind === 'direct') {
    const [other] = await assertReachable(app, ctx, [p.user_id]);
    if (!other) throw badRequest('اختر المنسوب الذي تريد محادثته');
    const found = await app.db.get(
      `SELECT c.id FROM conversations c
         JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
         JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
        WHERE c.tenant_id=? AND c.context_type='direct' LIMIT 1`,
      ctx.userId, other, ctx.tenantId);
    if (found) return { id: found.id, existing: true };

    const r = await app.db.run(
      `INSERT INTO conversations(tenant_id,branch_id,context_type,context_id,created_by,last_at)
       VALUES(?,?,'direct',(SELECT COALESCE(MAX(id),0)+1 FROM conversations),?,?)`,
      ctx.tenantId, ctx.activeBranchId || ctx.primaryBranchId || null, ctx.userId, nowUTC());
    await app.db.batch([
      ['UPDATE conversations SET context_id=id WHERE id=?', [r.lastId]],
      [`INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id,role_in,joined_at)
        VALUES(?,?,?,'member',?)`, [ctx.tenantId, r.lastId, ctx.userId, nowUTC()]],
      [`INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id,role_in,joined_at)
        VALUES(?,?,?,'member',?)`, [ctx.tenantId, r.lastId, other, nowUTC()]]
    ]);
    app.realtime?.emitToUsers?.(ctx.tenantId, [other], { type: 'chat.updated', conversationId: r.lastId });
    return created({ id: r.lastId, existing: false });
  }

  const title = String(p.title || '').trim();
  if (!title) throw badRequest('اسم المجموعة إلزامي');
  if (title.length > 80) throw badRequest('اسم المجموعة طويل جداً');
  const members = await assertReachable(app, ctx, p.member_ids);
  const avatar = p.avatar_file_id ? await resolveAvatar(app, ctx.tenantId, p.avatar_file_id) : null;

  const r = await app.db.run(
    `INSERT INTO conversations(tenant_id,branch_id,context_type,context_id,title,description,avatar_url,created_by,last_at)
     VALUES(?,?,'group',(SELECT COALESCE(MAX(id),0)+1 FROM conversations),?,?,?,?,?)`,
    ctx.tenantId, ctx.activeBranchId || ctx.primaryBranchId || null, title,
    String(p.description || '').trim().slice(0, 400) || null, avatar, ctx.userId, nowUTC());
  await app.db.batch([
    ['UPDATE conversations SET context_id=id WHERE id=?', [r.lastId]],
    [`INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id,role_in,joined_at)
      VALUES(?,?,?,'admin',?)`, [ctx.tenantId, r.lastId, ctx.userId, nowUTC()]],
    ...members.map(uid => [
      `INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id,role_in,joined_at)
       VALUES(?,?,?,'member',?)`, [ctx.tenantId, r.lastId, uid, nowUTC()]])
  ]);
  await systemMessage(app, ctx, r.lastId, `${ctx.userName} أنشأ المجموعة «${title}»`);
  await audit(req, { action: 'create', entity: 'conversation', entityId: r.lastId,
    summary: `${ctx.userName} أنشأ مجموعة محادثة «${title}» بعدد ${members.length + 1} عضواً` });
  if (members.length) {
    app.realtime?.emitToUsers?.(ctx.tenantId, members, { type: 'chat.updated', conversationId: r.lastId });
    await notifyUsers(app, ctx.tenantId, members, {
      type: 'chat.group', category: 'chat', title: `أُضفت إلى مجموعة «${title}»`,
      body: `${ctx.userName} أضافك إلى المجموعة`, url: `/chat?id=${r.lastId}`,
      data: { conversationId: r.lastId }
    });
  }
  return created({ id: r.lastId });
}));

router.get('/chats/:id', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv, me } = await openChat(app, ctx, req.params.id);
  const members = await app.db.all(
    `SELECT cm.user_id, cm.role_in, cm.joined_at, cm.last_read_at,
            u.name, u.avatar_url, r.name AS role_name, b.name AS branch_name
       FROM conversation_members cm JOIN users u ON u.id=cm.user_id
       LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN branches b ON b.id=u.primary_branch_id
      WHERE cm.conversation_id=? ORDER BY cm.role_in DESC, u.name`, conv.id);
  const other = conv.context_type === 'direct' ? members.find(m => m.user_id !== ctx.userId) : null;
  const kind = CHAT_KINDS.includes(conv.context_type) ? conv.context_type : 'context';
  return {
    id: conv.id, kind, context_type: conv.context_type, context_id: conv.context_id,
    title: kind === 'direct' ? (other?.name || 'محادثة خاصة') : (conv.title || 'محادثة'),
    description: conv.description || null,
    avatar_url: kind === 'direct' ? (other?.avatar_url || null) : (conv.avatar_url || null),
    created_by: conv.created_by, created_at: conv.created_at,
    members, my_role: me.role_in || 'member', muted: !!me.muted,
    /* المحادثة السياقية لا تُدار من هنا: أعضاؤها من يرتبط بعنصرها لا من يُضاف */
    can_manage: kind === 'group' && me.role_in === 'admin',
    can_leave: kind === 'group'
  };
}));

router.get('/chats/:id/messages', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
  const before = Number(req.query.before) || 0;
  const rows = await app.db.all(
    `SELECT m.*, u.name AS user_name, u.avatar_url,
        (SELECT r.body FROM messages r WHERE r.id=m.reply_to_id) AS reply_body,
        (SELECT ru.name FROM messages r JOIN users ru ON ru.id=r.user_id WHERE r.id=m.reply_to_id) AS reply_name
       FROM messages m JOIN users u ON u.id=m.user_id
      WHERE m.conversation_id=? ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.id DESC LIMIT ?`,
    ...(before ? [conv.id, before, limit] : [conv.id, limit]));
  await app.db.run('UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?',
    nowUTC(), conv.id, ctx.userId);
  return {
    messages: rows.reverse().map(m => shapeMessage(m, ctx.userId)),
    has_more: rows.length === limit
  };
}));

router.post('/chats/:id/messages', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id);
  const p = req.body || {};
  const kind = MSG_KINDS.includes(p.kind) ? p.kind : 'text';
  const attachments = await resolveAttachments(app, ctx.tenantId, p);
  const body = String(p.body || '').trim();
  if (kind === 'text' && !body) throw badRequest('لا يمكن إرسال رسالة فارغة');
  if (kind !== 'text' && !attachments.length) throw badRequest('لم يصل المرفق — أعد المحاولة');
  if (body.length > MAX_BODY) throw badRequest('الرسالة طويلة جداً');

  /* الردّ لا يخرج عن خيطه: معرّفٌ من محادثةٍ أخرى لا يُقبل */
  let replyTo = null;
  if (p.reply_to_id) {
    const r = await app.db.get('SELECT id FROM messages WHERE id=? AND conversation_id=?',
      Number(p.reply_to_id) || 0, conv.id);
    replyTo = r?.id || null;
  }

  const ins = await app.db.run(
    `INSERT INTO messages(tenant_id,conversation_id,user_id,body,attachments,kind,reply_to_id,duration_ms)
     VALUES(?,?,?,?,?,?,?,?)`,
    ctx.tenantId, conv.id, ctx.userId, body, JSON.stringify(attachments), kind, replyTo,
    Math.max(0, Math.min(600000, Number(p.duration_ms) || 0)));
  await app.db.run('UPDATE conversations SET last_at=? WHERE id=?', nowUTC(), conv.id);

  const msg = await app.db.get(
    `SELECT m.*, u.name AS user_name, u.avatar_url,
        (SELECT r.body FROM messages r WHERE r.id=m.reply_to_id) AS reply_body,
        (SELECT ru.name FROM messages r JOIN users ru ON ru.id=r.user_id WHERE r.id=m.reply_to_id) AS reply_name
       FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, ins.lastId);

  const rows = await app.db.all(
    'SELECT user_id, muted FROM conversation_members WHERE conversation_id=? AND user_id<>?', conv.id, ctx.userId);
  const others = rows.map(r => r.user_id);
  app.realtime?.emitToUsers?.(ctx.tenantId, others,
    { type: 'chat.message', conversationId: conv.id, message: shapeMessage(msg, -1) });

  const heading = conv.context_type === 'group'
    ? (conv.title || 'مجموعة')
    : conv.context_type === 'direct' ? ctx.userName : (conv.title || 'محادثة');
  const preview = kind === 'voice' ? 'رسالة صوتية' : kind === 'file' ? 'مرفق' : body.slice(0, 90);
  /* من كتم المجموعة لا يُدفع إليه إشعارٌ — والرسالة تصله في الشاشة كما هي */
  const loud = rows.filter(r => !r.muted).map(r => r.user_id);
  if (loud.length) await notifyUsers(app, ctx.tenantId, loud, {
    type: 'chat.message', category: 'chat',
    title: conv.context_type === 'direct' ? `رسالة من ${ctx.userName}` : `رسالة جديدة — ${heading}`,
    body: conv.context_type === 'direct' ? preview : `${ctx.userName}: ${preview}`,
    url: `/chat?id=${conv.id}`, data: { conversationId: conv.id }
  });
  return created(shapeMessage(msg, ctx.userId));
}));

router.patch('/chats/:id/messages/:mid', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id);
  const m = await app.db.get('SELECT * FROM messages WHERE id=? AND conversation_id=?',
    Number(req.params.mid) || 0, conv.id);
  if (!m) throw notFound('الرسالة غير موجودة');
  if (m.user_id !== ctx.userId) throw forbidden('لا تُعدَّل إلا رسالتك أنت');
  if (m.deleted_at) throw badRequest('الرسالة محذوفة');
  /* النصُّ وحده يُعدَّل — في الرسالة النصّية وفي تعليق المرفق. أما الصوت
     فلا نصَّ فيه يُصحَّح، والرسالة النظامية سجلٌّ لا يُعاد كتابته. */
  if (!['text', 'file'].includes(m.kind)) throw badRequest('لا يُعدَّل إلا نصُّ الرسالة');
  const body = String(req.body?.body || '').trim();
  if (!body) throw badRequest('لا يمكن ترك الرسالة فارغة');
  if (body.length > MAX_BODY) throw badRequest('الرسالة طويلة جداً');
  await app.db.run('UPDATE messages SET body=?, edited_at=? WHERE id=?', body, nowUTC(), m.id);
  app.realtime?.emitToUsers?.(ctx.tenantId,
    (await app.db.all('SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>?', conv.id, ctx.userId))
      .map(r => r.user_id),
    { type: 'chat.updated', conversationId: conv.id });
  return { ok: true, id: m.id, body, edited_at: nowUTC() };
}));

router.delete('/chats/:id/messages/:mid', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv, me } = await openChat(app, ctx, req.params.id);
  const m = await app.db.get('SELECT * FROM messages WHERE id=? AND conversation_id=?',
    Number(req.params.mid) || 0, conv.id);
  if (!m) throw notFound('الرسالة غير موجودة');
  if (m.user_id !== ctx.userId && me.role_in !== 'admin') throw forbidden('لا تُحذف إلا رسالتك، أو رسالةٌ في مجموعةٍ تشرف عليها');
  /* تُفرَّغ ويبقى موضعها: خيطٌ تختفي منه رسالةٌ يُربك من ردَّ عليها */
  await app.db.run(`UPDATE messages SET deleted_at=?, body='', attachments='[]' WHERE id=?`, nowUTC(), m.id);
  return { ok: true };
}));

router.post('/chats/:id/read', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id);
  await app.db.run('UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?',
    nowUTC(), conv.id, ctx.userId);
  return { ok: true };
}));

/** الكتم تفضيلٌ شخصيّ: يوقف الإشعار لا الرسائل */
router.post('/chats/:id/mute', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id);
  const on = req.body?.muted ? 1 : 0;
  await app.db.run('UPDATE conversation_members SET muted=? WHERE conversation_id=? AND user_id=?',
    on, conv.id, ctx.userId);
  return { ok: true, muted: !!on };
}));

router.patch('/chats/:id', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id, { admin: true });
  if (conv.context_type !== 'group') throw badRequest('لا يُعدَّل إلا وصفُ المجموعات');
  const p = req.body || {};
  const title = p.title !== undefined ? String(p.title).trim() : conv.title;
  if (!title) throw badRequest('اسم المجموعة إلزامي');
  if (title.length > 80) throw badRequest('اسم المجموعة طويل جداً');
  const description = p.description !== undefined
    ? (String(p.description).trim().slice(0, 400) || null) : conv.description;
  const avatar = p.avatar_file_id !== undefined
    ? await resolveAvatar(app, ctx.tenantId, p.avatar_file_id)
    : conv.avatar_url;

  await app.db.run('UPDATE conversations SET title=?, description=?, avatar_url=? WHERE id=? AND tenant_id=?',
    title, description, avatar, conv.id, ctx.tenantId);

  const changes = [];
  if (title !== conv.title) changes.push(`غيّر الاسم إلى «${title}»`);
  if (description !== conv.description) changes.push('حدّث الوصف');
  if (avatar !== conv.avatar_url) changes.push('غيّر صورة العرض');
  if (changes.length) await systemMessage(app, ctx, conv.id, `${ctx.userName} ${changes.join(' و')}`);
  await audit(req, { action: 'update', entity: 'conversation', entityId: conv.id,
    summary: `${ctx.userName} عدّل بيانات مجموعة «${title}»`, before: { title: conv.title }, after: { title } });

  app.realtime?.emitToUsers?.(ctx.tenantId,
    (await app.db.all('SELECT user_id FROM conversation_members WHERE conversation_id=?', conv.id)).map(r => r.user_id),
    { type: 'chat.updated', conversationId: conv.id });
  return { ok: true, title, description, avatar_url: avatar };
}));

router.post('/chats/:id/members', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id, { admin: true });
  if (conv.context_type !== 'group') throw badRequest('لا يُضاف الأعضاء إلا في المجموعات');
  const wanted = await assertReachable(app, ctx, req.body?.user_ids);
  if (!wanted.length) throw badRequest('اختر من تريد إضافته');

  const already = (await app.db.all('SELECT user_id FROM conversation_members WHERE conversation_id=?', conv.id))
    .map(r => r.user_id);
  const fresh = wanted.filter(id => !already.includes(id));
  if (!fresh.length) return { ok: true, added: 0 };

  await app.db.batch(fresh.map(uid => [
    `INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id,role_in,joined_at)
     VALUES(?,?,?,'member',?)`, [ctx.tenantId, conv.id, uid, nowUTC()]]));
  const names = await app.db.all(
    `SELECT name FROM users WHERE tenant_id=? AND id IN (${fresh.map(() => '?').join(',')})`, ctx.tenantId, ...fresh);
  await systemMessage(app, ctx, conv.id, `${ctx.userName} أضاف ${names.map(n => n.name).join('، ')}`);
  await audit(req, { action: 'update', entity: 'conversation', entityId: conv.id,
    summary: `${ctx.userName} أضاف ${fresh.length} عضواً إلى مجموعة «${conv.title || ''}»` });

  app.realtime?.emitToUsers?.(ctx.tenantId, fresh, { type: 'chat.updated', conversationId: conv.id });
  await notifyUsers(app, ctx.tenantId, fresh, {
    type: 'chat.group', category: 'chat', title: `أُضفت إلى مجموعة «${conv.title || ''}»`,
    body: `${ctx.userName} أضافك إلى المجموعة`, url: `/chat?id=${conv.id}`, data: { conversationId: conv.id }
  });
  return created({ ok: true, added: fresh.length });
}));

router.patch('/chats/:id/members/:uid', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv } = await openChat(app, ctx, req.params.id, { admin: true });
  if (conv.context_type !== 'group') throw badRequest('الأدوار للمجموعات وحدها');
  const uid = Number(req.params.uid) || 0;
  const role = req.body?.role_in === 'admin' ? 'admin' : 'member';
  const row = await app.db.get('SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, uid);
  if (!row) throw notFound('العضو غير موجود في المجموعة');
  /* لا تبقى مجموعةٌ بلا مشرف — من نزع عن نفسه الإشراف وهو آخرهم يُردّ */
  if (role === 'member' && row.role_in === 'admin') {
    const admins = await app.db.get(
      `SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id=? AND role_in='admin'`, conv.id);
    if ((admins?.c || 0) <= 1) throw badRequest('لا بدّ من مشرفٍ واحدٍ على الأقل للمجموعة');
  }
  await app.db.run('UPDATE conversation_members SET role_in=? WHERE conversation_id=? AND user_id=?',
    role, conv.id, uid);
  return { ok: true, role_in: role };
}));

router.delete('/chats/:id/members/:uid', can('chat.use'), h(async (req) => {
  const { app, ctx } = req;
  const { conv, me } = await openChat(app, ctx, req.params.id);
  if (conv.context_type !== 'group') throw badRequest('لا يُغادَر إلا المجموعات');
  const uid = Number(req.params.uid) || 0;
  const self = uid === ctx.userId;
  if (!self && me.role_in !== 'admin') throw forbidden('إخراج الأعضاء لمشرفي المجموعة');

  const row = await app.db.get('SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, uid);
  if (!row) throw notFound('العضو غير موجود في المجموعة');
  const admins = await app.db.get(
    `SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id=? AND role_in='admin'`, conv.id);
  const total = await app.db.get('SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id=?', conv.id);
  if (row.role_in === 'admin' && (admins?.c || 0) <= 1 && (total?.c || 0) > 1)
    throw badRequest('عيّن مشرفاً آخر قبل مغادرتك — لا تبقى المجموعة بلا مشرف');

  const who = (await app.db.get('SELECT name FROM users WHERE id=?', uid))?.name || '';
  await app.db.run('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, uid);
  await systemMessage(app, ctx, conv.id, self ? `${ctx.userName} غادر المجموعة` : `${ctx.userName} أخرج ${who}`);
  await audit(req, { action: 'update', entity: 'conversation', entityId: conv.id,
    summary: self ? `${ctx.userName} غادر مجموعة «${conv.title || ''}»`
      : `${ctx.userName} أخرج ${who} من مجموعة «${conv.title || ''}»` });
  app.realtime?.emitToUsers?.(ctx.tenantId, [uid], { type: 'chat.updated', conversationId: conv.id });
  return { ok: true };
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
