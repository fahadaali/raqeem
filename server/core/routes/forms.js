import { Hono } from 'hono';
import { j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, findScoped, currentTerm } from '../scope.js';
import { notifyUsers } from '../notify.js';
import { recomputeKPIs } from '../jobs/kpi.js';

const router = new Hono();
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'rating', 'file', 'section'];

/* ─────────────── منشئ النماذج المرئي ─────────────── */
router.get('/', can('forms.view', 'forms.submit'), h(async (req) => {
  const rows = await req.app.db.all(`SELECT f.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id=f.id) AS submissions_count
    FROM forms f LEFT JOIN users u ON u.id=f.created_by
    WHERE f.tenant_id=? ${req.query.active === '1' ? 'AND f.is_active=1' : ''} ORDER BY f.created_at DESC`,
    req.ctx.tenantId);
  return rows.map(f => ({ ...f, schema: j(f.schema_json, { fields: [] }) }));
}));

/* لوحات مؤشرات الأداء — قبل /:id حتى لا يبتلعها التوجيه */
router.get('/kpi/overview', can('kpi.view', 'kpi.view_all'), h(async (req) => {
  const app = req.app;
  const viewAll = has(req.ctx, 'kpi.view_all');
  const term = req.query.term_id ? Number(req.query.term_id)
    : (req.ctx.activeTermId || (await currentTerm(app, req.ctx.tenantId))?.id);

  const sc = scoped(req.ctx, { alias: 'k' });
  let sql = `SELECT k.*, u.name AS user_name, u.avatar_url, b.name AS branch_name, c.name AS committee_name
    FROM kpis k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN branches b ON b.id=k.branch_id
    LEFT JOIN committees c ON c.id=k.committee_id WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!viewAll) { sql += ' AND k.user_id=?'; params.push(req.ctx.userId); }
  if (term) { sql += ' AND k.term_id=?'; params.push(term); }
  sql += ` AND k.period='term' ORDER BY k.score DESC`;
  const rows = await app.db.all(sql, ...params);

  const tScope = scoped(req.ctx, { alias: 't' });
  const mine = viewAll ? '' : ' AND t.assignee_id=?';
  const mineParam = viewAll ? [] : [req.ctx.userId];
  const taskStats = await app.db.all(
    `SELECT status, COUNT(*) AS c FROM tasks t WHERE ${tScope.where}${term ? ' AND t.term_id=?' : ''}${mine} GROUP BY status`,
    ...tScope.params, ...(term ? [term] : []), ...mineParam);
  const overdueRow = await app.db.get(
    `SELECT COUNT(*) AS c FROM tasks t WHERE ${tScope.where} AND t.status<>'done' AND t.due_date < date('now')${term ? ' AND t.term_id=?' : ''}${mine}`,
    ...tScope.params, ...(term ? [term] : []), ...mineParam);
  const evalAvg = await app.db.get(
    `SELECT AVG(score) AS a, COUNT(*) AS c FROM form_submissions s
     WHERE s.tenant_id=? AND s.score IS NOT NULL${term ? ' AND s.term_id=?' : ''}${viewAll ? '' : ' AND s.subject_user_id=?'}`,
    req.ctx.tenantId, ...(term ? [term] : []), ...mineParam);

  return {
    leaderboard: rows,
    task_stats: Object.fromEntries(taskStats.map(t => [t.status, t.c])),
    overdue: overdueRow.c,
    evaluation: { avg: evalAvg.a ? Number(evalAvg.a.toFixed(1)) : null, count: evalAvg.c },
    term_id: term
  };
}));

router.post('/kpi/recompute', can('kpi.view_all'), h(async (req) => {
  const n = await recomputeKPIs(req.app, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'kpi', summary: `إعادة احتساب مؤشرات الأداء يدوياً (${n} سجل)` });
  return { ok: true, updated: n };
}));

router.get('/:id', can('forms.view', 'forms.submit'), h(async (req) => {
  const f = await findScoped(req.app, req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  return { ...f, schema: j(f.schema_json, { fields: [] }) };
}));

function validateSchema(schema) {
  const fields = schema?.fields;
  if (!Array.isArray(fields) || !fields.length) throw badRequest('يجب إضافة حقل واحد على الأقل للنموذج');
  for (const f of fields) {
    if (!f.id || !f.label) throw badRequest('كل حقل يحتاج معرّفاً وعنواناً');
    if (!FIELD_TYPES.includes(f.type)) throw badRequest(`نوع حقل غير مدعوم: ${f.type}`);
    if (['select', 'multiselect'].includes(f.type) && !Array.isArray(f.options))
      throw badRequest(`الحقل "${f.label}" يحتاج قائمة خيارات`);
  }
  return { fields };
}

router.post('/', can('forms.manage'), h(async (req) => {
  const { title, description, type, schema, target_role } = req.body || {};
  if (!title) throw badRequest('عنوان النموذج إلزامي');
  const clean = validateSchema(schema);
  const r = await req.app.db.run(
    'INSERT INTO forms(tenant_id,title,description,type,schema_json,target_role,created_by) VALUES(?,?,?,?,?,?,?)',
    req.ctx.tenantId, String(title).trim(), description || null, type || 'evaluation',
    JSON.stringify(clean), target_role || null, req.ctx.userId);
  await audit(req, { action: 'create', entity: 'form', entityId: r.lastId,
    summary: `بناء نموذج جديد: ${title} (${clean.fields.length} حقل)` });
  return created({ id: r.lastId });
}));

router.patch('/:id', can('forms.manage'), h(async (req) => {
  const f = await findScoped(req.app, req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  const p = req.body || {};
  const clean = p.schema ? validateSchema(p.schema) : j(f.schema_json, { fields: [] });
  await req.app.db.run('UPDATE forms SET title=?,description=?,type=?,schema_json=?,target_role=?,is_active=? WHERE id=? AND tenant_id=?',
    p.title ?? f.title, p.description ?? f.description, p.type ?? f.type,
    JSON.stringify(clean), p.target_role ?? f.target_role, p.is_active ?? f.is_active, f.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'form', entityId: f.id, summary: `تعديل النموذج: ${f.title}` });
  return { ok: true };
}));

router.delete('/:id', can('forms.manage'), h(async (req) => {
  const f = await findScoped(req.app, req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  await req.app.db.run('UPDATE forms SET is_active=0 WHERE id=? AND tenant_id=?', f.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'form', entityId: f.id, summary: `تعطيل النموذج: ${f.title}` });
  return { ok: true };
}));

/* ─────────────── التعبئة والتقييم ─────────────── */
function scoreSubmission(schema, answers) {
  let score = 0, max = 0;
  for (const f of schema.fields || []) {
    const w = Number(f.weight) || 0;
    if (!w) continue;
    max += w;
    const v = answers[f.id];
    if (f.type === 'rating') score += ((Number(v) || 0) / (Number(f.max) || 5)) * w;
    else if (f.type === 'select' && Array.isArray(f.options)) {
      const idx = f.options.indexOf(v);
      if (idx >= 0 && f.options.length > 1) score += ((f.options.length - idx - 1) / (f.options.length - 1)) * w;
    } else if (f.type === 'checkbox') { if (v) score += w; }
    else if (f.type === 'number') score += Math.min(1, (Number(v) || 0) / (Number(f.max) || 100)) * w;
  }
  return max ? { score: Number(score.toFixed(1)), max_score: max } : { score: null, max_score: null };
}

router.post('/:id/submit', can('forms.submit'), h(async (req) => {
  const app = req.app;
  const f = await findScoped(app, req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  if (!f.is_active) throw badRequest('النموذج غير مفعّل حالياً');
  const schema = j(f.schema_json, { fields: [] });
  const answers = req.body?.answers || {};

  for (const field of schema.fields) {
    if (field.required && field.type !== 'section') {
      const v = answers[field.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))
        throw badRequest(`الحقل "${field.label}" إلزامي`);
    }
  }

  const { score, max_score } = scoreSubmission(schema, answers);
  const term = await currentTerm(app, req.ctx.tenantId);
  const r = await app.db.run(
    `INSERT INTO form_submissions(tenant_id,branch_id,term_id,form_id,subject_user_id,submitted_by,answers,score,max_score)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId, term?.id || null, f.id,
    req.body?.subject_user_id || null, req.ctx.userId, JSON.stringify(answers), score, max_score);

  await audit(req, { action: 'create', entity: 'form_submission', entityId: r.lastId,
    summary: `تعبئة النموذج (${f.title})${score !== null ? ` — النتيجة ${score}/${max_score}` : ''}` });

  if (req.body?.subject_user_id && f.type === 'evaluation') {
    await notifyUsers(app, req.ctx.tenantId, [req.body.subject_user_id], {
      type: 'evaluation.received', category: 'tasks', title: 'تم رصد تقييم جديد لك',
      body: `${f.title}${score !== null ? ` — النتيجة ${score} من ${max_score}` : ''}`, url: '/kpi'
    });
  }
  return created({ id: r.lastId, score, max_score });
}));

router.get('/:id/submissions', can('forms.results'), h(async (req) => {
  const app = req.app;
  const f = await findScoped(app, req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  const rows = await app.db.all(`SELECT s.*, su.name AS subject_name, sb.name AS submitted_by_name, b.name AS branch_name
    FROM form_submissions s LEFT JOIN users su ON su.id=s.subject_user_id
    LEFT JOIN users sb ON sb.id=s.submitted_by LEFT JOIN branches b ON b.id=s.branch_id
    WHERE s.tenant_id=? AND s.form_id=? ORDER BY s.submitted_at DESC LIMIT 500`, req.ctx.tenantId, f.id);
  return { form: { ...f, schema: j(f.schema_json, {}) },
    submissions: rows.map(s => ({ ...s, answers: j(s.answers, {}) })) };
}));

export default router;
