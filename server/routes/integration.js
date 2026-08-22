import express from 'express';
import crypto from 'node:crypto';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, unauthorized, forbidden } from '../lib/errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { findScoped, currentTerm } from '../lib/scope.js';
import { rateLimit } from '../middleware/rateLimit.js';
import config from '../config.js';

/* ═════════ لوحة إعدادات المطورين — إدارة مفاتيح الربط (البند ٩) ═════════ */
export const keysRouter = express.Router();

const SCOPES = [
  { key: 'teachers.read', label: 'قراءة بيانات المعلمين' },
  { key: 'branches.read', label: 'قراءة بيانات الفروع' },
  { key: 'terms.read', label: 'قراءة الفصول الدراسية' },
  { key: 'attendance.read', label: 'قراءة ملخّص الحضور' },
  { key: 'committees.read', label: 'قراءة اللجان' },
  { key: 'kpi.read', label: 'قراءة مؤشرات الأداء' }
];

keysRouter.get('/scopes', can('api.keys.manage'), ah(async (req, res) => res.json(SCOPES)));

keysRouter.get('/', can('api.keys.manage'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT id,name,key_prefix,scopes,rate_limit,last_used_at,expires_at,revoked,created_at
    FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC`).all(req.ctx.tenantId);
  res.json(rows.map(k => ({ ...k, scopes: j(k.scopes, []) })));
}));

keysRouter.post('/', can('api.keys.manage'), ah(async (req, res) => {
  const { name, scopes, rate_limit, expires_at } = req.body || {};
  if (!name) throw badRequest('اسم المفتاح إلزامي');
  const valid = new Set(SCOPES.map(s => s.key));
  const list = (scopes || []).filter(s => valid.has(s));
  if (!list.length) throw badRequest('اختر نطاق وصول واحداً على الأقل');

  const secret = crypto.randomBytes(24).toString('base64url');
  const prefix = `noor_${req.ctx.tenantCode.toLowerCase()}_${crypto.randomBytes(3).toString('hex')}`;
  const full = `${prefix}.${secret}`;
  const r = db.prepare(`INSERT INTO api_keys(tenant_id,name,key_prefix,key_hash,scopes,rate_limit,expires_at,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, name.trim(), prefix,
    crypto.createHash('sha256').update(full).digest('hex'), JSON.stringify(list),
    Number(rate_limit) || config.rateLimit.publicMax, expires_at || null, req.ctx.userId);

  audit(req, { action: 'create', entity: 'api_key', entityId: r.lastInsertRowid, summary: `إصدار مفتاح ربط: ${name} (${list.join('، ')})` });
  res.status(201).json({
    id: r.lastInsertRowid, key: full, prefix, scopes: list,
    warning: 'احفظ هذا المفتاح الآن — لن يُعرض مرة أخرى.'
  });
}));

keysRouter.delete('/:id', can('api.keys.manage'), ah(async (req, res) => {
  const k = findScoped(req.ctx, 'api_keys', req.params.id);
  if (!k) throw notFound('المفتاح غير موجود');
  db.prepare('UPDATE api_keys SET revoked=1 WHERE id=? AND tenant_id=?').run(k.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'api_key', entityId: k.id, summary: `إبطال مفتاح الربط: ${k.name}` });
  res.json({ ok: true });
}));

/* ═════════ الواجهة البرمجية العامة (RESTful) للأنظمة الخارجية ═════════ */
export const publicRouter = express.Router();

function apiAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
    if (!key || !key.includes('.')) throw unauthorized('مفتاح الربط مفقود أو غير صالح');
    const prefix = key.split('.')[0];
    const row = db.prepare('SELECT * FROM api_keys WHERE key_prefix=?').get(prefix);
    if (!row || row.revoked) throw unauthorized('مفتاح الربط غير صالح أو مُبطَل');
    if (row.expires_at && new Date(row.expires_at) < new Date()) throw unauthorized('انتهت صلاحية مفتاح الربط');
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    if (hash.length !== row.key_hash.length ||
        !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.key_hash))) throw unauthorized('مفتاح الربط غير صالح');
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(nowUTC(), row.id);
    req.apiKey = { ...row, scopes: j(row.scopes, []) };
    req.tenantId = row.tenant_id;
    next();
  } catch (e) { next(e); }
}

const scope = (name) => (req, res, next) =>
  req.apiKey?.scopes?.includes(name) ? next() : next(forbidden(`المفتاح لا يملك النطاق: ${name}`));

publicRouter.use(apiAuth);
publicRouter.use(rateLimit({
  key: (req) => `api:${req.apiKey?.id || req.ip}`,
  max: (req) => req.apiKey?.rate_limit || config.rateLimit.publicMax
}));

publicRouter.get('/', (req, res) => res.json({
  service: 'Noor ERP Public API', version: 'v1',
  tenant: db.prepare('SELECT code,name FROM tenants WHERE id=?').get(req.tenantId),
  scopes: req.apiKey.scopes,
  endpoints: ['/v1/teachers', '/v1/teachers/:id', '/v1/branches', '/v1/terms', '/v1/attendance/summary', '/v1/committees', '/v1/kpi']
}));

publicRouter.get('/teachers', scope('teachers.read'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.status,
      e.employee_no, e.job_title, e.department, e.hire_date, b.code branch_code, b.name branch_name
    FROM users u JOIN roles r ON r.id=u.role_id
    LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id
    LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND r.key='teacher' AND u.status='active' ORDER BY u.name`).all(req.tenantId);
  res.json({ data: rows, count: rows.length });
}));

publicRouter.get('/teachers/:id', scope('teachers.read'), ah(async (req, res) => {
  const t = db.prepare(`SELECT u.id, u.name, u.email, u.phone, e.employee_no, e.job_title, e.department,
      e.hire_date, b.code branch_code, b.name branch_name
    FROM users u JOIN roles r ON r.id=u.role_id
    LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id
    LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND u.id=? AND r.key='teacher'`).get(req.tenantId, req.params.id);
  if (!t) throw notFound('المعلم غير موجود');
  let attendance = null;
  if (req.apiKey.scopes.includes('attendance.read')) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT status, COUNT(*) c FROM attendance
      WHERE tenant_id=? AND user_id=? AND date>=? GROUP BY status`).all(req.tenantId, t.id, from);
    attendance = { period_days: 30, breakdown: Object.fromEntries(rows.map(r => [r.status, r.c])) };
  }
  res.json({ data: { ...t, attendance } });
}));

publicRouter.get('/branches', scope('branches.read'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT id,code,name,address,phone,is_active FROM branches WHERE tenant_id=? ORDER BY code`).all(req.tenantId);
  res.json({ data: rows, count: rows.length });
}));

publicRouter.get('/terms', scope('terms.read'), ah(async (req, res) => {
  const rows = db.prepare('SELECT id,code,name,start_date,end_date,status,is_current FROM terms WHERE tenant_id=? ORDER BY start_date DESC').all(req.tenantId);
  res.json({ data: rows, current: rows.find(r => r.is_current) || null });
}));

publicRouter.get('/attendance/summary', scope('attendance.read'), ah(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT b.code branch_code, a.status, COUNT(*) c FROM attendance a
    LEFT JOIN branches b ON b.id=a.branch_id
    WHERE a.tenant_id=? AND a.date BETWEEN ? AND ? GROUP BY b.code, a.status`).all(req.tenantId, from, to);
  res.json({ period: { from, to }, data: rows });
}));

publicRouter.get('/committees', scope('committees.read'), ah(async (req, res) => {
  const term = currentTerm(req.tenantId);
  const rows = db.prepare(`SELECT c.id,c.name,c.description,b.code branch_code,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) members,
      (SELECT COUNT(*) FROM tasks t WHERE t.committee_id=c.id) tasks
    FROM committees c LEFT JOIN branches b ON b.id=c.branch_id
    WHERE c.tenant_id=? AND (c.term_id=? OR c.term_id IS NULL)`).all(req.tenantId, term?.id || 0);
  res.json({ data: rows, term });
}));

publicRouter.get('/kpi', scope('kpi.read'), ah(async (req, res) => {
  const term = currentTerm(req.tenantId);
  const rows = db.prepare(`SELECT u.name user_name, k.tasks_total, k.tasks_done, k.completion_rate,
      k.attendance_rate, k.eval_avg, k.score
    FROM kpis k JOIN users u ON u.id=k.user_id
    WHERE k.tenant_id=? AND k.period='term' ${term ? 'AND k.term_id=' + term.id : ''}
    ORDER BY k.score DESC LIMIT 100`).all(req.tenantId);
  res.json({ data: rows, term });
}));

export default { keysRouter, publicRouter };
