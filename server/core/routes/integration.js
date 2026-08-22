import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, unauthorized, forbidden } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { findScoped, currentTerm } from '../scope.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { randomToken, sha256Hex, timingSafeEqual } from '../crypto.js';

/* ═════ لوحة إعدادات المطورين — إدارة مفاتيح الربط (البند ٩) ═════ */
export const keysRouter = new Hono();

const SCOPES = [
  { key: 'teachers.read', label: 'قراءة بيانات المعلمين' },
  { key: 'branches.read', label: 'قراءة بيانات الفروع' },
  { key: 'terms.read', label: 'قراءة الفصول الدراسية' },
  { key: 'attendance.read', label: 'قراءة ملخّص الحضور' },
  { key: 'committees.read', label: 'قراءة اللجان' },
  { key: 'kpi.read', label: 'قراءة مؤشرات الأداء' }
];

keysRouter.get('/scopes', can('api.keys.manage'), h(async () => SCOPES));

keysRouter.get('/', can('api.keys.manage'), h(async (req) =>
  (await req.app.db.all(`SELECT id,name,key_prefix,scopes,rate_limit,last_used_at,expires_at,revoked,created_at
    FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC`, req.ctx.tenantId))
    .map(k => ({ ...k, scopes: j(k.scopes, []) }))));

keysRouter.post('/', can('api.keys.manage'), h(async (req) => {
  const app = req.app;
  const { name, scopes, rate_limit, expires_at } = req.body || {};
  if (!name) throw badRequest('اسم المفتاح إلزامي');
  const valid = new Set(SCOPES.map(s => s.key));
  const list = (scopes || []).filter(s => valid.has(s));
  if (!list.length) throw badRequest('اختر نطاق وصول واحداً على الأقل');

  const secret = randomToken(24);
  const prefix = `noor_${req.ctx.tenantCode.toLowerCase()}_${randomToken(3).slice(0, 6).toLowerCase()}`;
  const full = `${prefix}.${secret}`;
  const r = await app.db.run(
    `INSERT INTO api_keys(tenant_id,name,key_prefix,key_hash,scopes,rate_limit,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, String(name).trim(), prefix, await sha256Hex(full), JSON.stringify(list),
    Number(rate_limit) || app.cfg.rateLimit.publicMax, expires_at || null, req.ctx.userId);

  await audit(req, { action: 'create', entity: 'api_key', entityId: r.lastId,
    summary: `إصدار مفتاح ربط: ${name} (${list.join('، ')})` });
  return created({ id: r.lastId, key: full, prefix, scopes: list,
    warning: 'احفظ هذا المفتاح الآن — لن يُعرض مرة أخرى.' });
}));

keysRouter.delete('/:id', can('api.keys.manage'), h(async (req) => {
  const k = await findScoped(req.app, req.ctx, 'api_keys', req.params.id);
  if (!k) throw notFound('المفتاح غير موجود');
  await req.app.db.run('UPDATE api_keys SET revoked=1 WHERE id=? AND tenant_id=?', k.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'api_key', entityId: k.id, summary: `إبطال مفتاح الربط: ${k.name}` });
  return { ok: true };
}));

/* ═════ الواجهة البرمجية العامة (RESTful) للأنظمة الخارجية ═════ */
export const publicRouter = new Hono();

publicRouter.use('*', async (c, next) => {
  const app = c.get('app');
  const req = c.get('request');
  const header = req.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
  if (!key || !String(key).includes('.')) throw unauthorized('مفتاح الربط مفقود أو غير صالح');
  const prefix = String(key).split('.')[0];
  const row = await app.db.get('SELECT * FROM api_keys WHERE key_prefix=?', prefix);
  if (!row || row.revoked) throw unauthorized('مفتاح الربط غير صالح أو مُبطَل');
  if (row.expires_at && new Date(row.expires_at) < new Date()) throw unauthorized('انتهت صلاحية مفتاح الربط');
  if (!timingSafeEqual(await sha256Hex(String(key)), row.key_hash)) throw unauthorized('مفتاح الربط غير صالح');
  await app.db.run('UPDATE api_keys SET last_used_at=? WHERE id=?', nowUTC(), row.id);
  const apiKey = { ...row, scopes: j(row.scopes, []) };
  c.set('apiKey', apiKey);
  req.apiKey = apiKey;
  req.tenantId = row.tenant_id;
  await next();
});

publicRouter.use('*', rateLimit({
  key: (req) => `api:${req.apiKey?.id || req.ip}`,
  max: (req, c) => req.apiKey?.rate_limit || c.get('app').cfg.rateLimit.publicMax
}));

const scope = (name) => async (c, next) => {
  const key = c.get('apiKey');
  if (!key?.scopes?.includes(name)) throw forbidden(`المفتاح لا يملك النطاق: ${name}`);
  await next();
};

publicRouter.get('/', h(async (req) => ({
  service: 'Noor ERP Public API', version: 'v1',
  tenant: await req.app.db.get('SELECT code,name FROM tenants WHERE id=?', req.tenantId),
  scopes: req.apiKey.scopes,
  endpoints: ['/v1/teachers', '/v1/teachers/:id', '/v1/branches', '/v1/terms',
    '/v1/attendance/summary', '/v1/committees', '/v1/kpi']
})));

publicRouter.get('/teachers', scope('teachers.read'), h(async (req) => {
  const rows = await req.app.db.all(`SELECT u.id, u.name, u.email, u.phone, u.status,
      e.employee_no, e.job_title, e.department, e.hire_date, b.code AS branch_code, b.name AS branch_name
    FROM users u JOIN roles r ON r.id=u.role_id
    LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id
    LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND r.key='teacher' AND u.status='active' ORDER BY u.name`, req.tenantId);
  return { data: rows, count: rows.length };
}));

publicRouter.get('/teachers/:id', scope('teachers.read'), h(async (req) => {
  const app = req.app;
  const t = await app.db.get(`SELECT u.id, u.name, u.email, u.phone, e.employee_no, e.job_title, e.department,
      e.hire_date, b.code AS branch_code, b.name AS branch_name
    FROM users u JOIN roles r ON r.id=u.role_id
    LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id
    LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND u.id=? AND r.key='teacher'`, req.tenantId, req.params.id);
  if (!t) throw notFound('المعلم غير موجود');
  let attendance = null;
  if (req.apiKey.scopes.includes('attendance.read')) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await app.db.all(
      'SELECT status, COUNT(*) AS c FROM attendance WHERE tenant_id=? AND user_id=? AND date>=? GROUP BY status',
      req.tenantId, t.id, from);
    attendance = { period_days: 30, breakdown: Object.fromEntries(rows.map(r => [r.status, r.c])) };
  }
  return { data: { ...t, attendance } };
}));

publicRouter.get('/branches', scope('branches.read'), h(async (req) => {
  const rows = await req.app.db.all('SELECT id,code,name,address,phone,is_active FROM branches WHERE tenant_id=? ORDER BY code', req.tenantId);
  return { data: rows, count: rows.length };
}));

publicRouter.get('/terms', scope('terms.read'), h(async (req) => {
  const rows = await req.app.db.all(
    'SELECT id,code,name,start_date,end_date,status,is_current FROM terms WHERE tenant_id=? ORDER BY start_date DESC', req.tenantId);
  return { data: rows, current: rows.find(r => r.is_current) || null };
}));

publicRouter.get('/attendance/summary', scope('attendance.read'), h(async (req) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const rows = await req.app.db.all(`SELECT b.code AS branch_code, a.status, COUNT(*) AS c FROM attendance a
    LEFT JOIN branches b ON b.id=a.branch_id
    WHERE a.tenant_id=? AND a.date BETWEEN ? AND ? GROUP BY b.code, a.status`, req.tenantId, from, to);
  return { period: { from, to }, data: rows };
}));

publicRouter.get('/committees', scope('committees.read'), h(async (req) => {
  const term = await currentTerm(req.app, req.tenantId);
  const rows = await req.app.db.all(`SELECT c.id,c.name,c.description,b.code AS branch_code,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) AS members,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id) AS tasks
    FROM committees c LEFT JOIN branches b ON b.id=c.branch_id
    WHERE c.tenant_id=? AND (c.term_id=? OR c.term_id IS NULL)`, req.tenantId, term?.id || 0);
  return { data: rows, term };
}));

publicRouter.get('/kpi', scope('kpi.read'), h(async (req) => {
  const term = await currentTerm(req.app, req.tenantId);
  const rows = await req.app.db.all(
    `SELECT u.name AS user_name, k.tasks_total, k.tasks_done, k.completion_rate,
       k.attendance_rate, k.eval_avg, k.score
     FROM kpis k JOIN users u ON u.id=k.user_id
     WHERE k.tenant_id=? AND k.period='term' ${term ? 'AND k.term_id=?' : ''}
     ORDER BY k.score DESC LIMIT 100`, req.tenantId, ...(term ? [term.id] : []));
  return { data: rows, term };
}));

export default { keysRouter, publicRouter };
