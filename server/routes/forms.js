import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, forbidden } from '../lib/errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, findScoped, currentTerm } from '../lib/scope.js';
import { notifyUsers } from '../lib/notify.js';

const router = express.Router();
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'rating', 'file', 'section'];

/* ─────────────────────────── منشئ النماذج المرئي (Drag & Drop) ──────────── */
router.get('/', can('forms.view', 'forms.submit'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT f.*, u.name created_by_name,
      (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id=f.id) submissions_count
    FROM forms f LEFT JOIN users u ON u.id=f.created_by
    WHERE f.tenant_id=? ${req.query.active === '1' ? 'AND f.is_active=1' : ''} ORDER BY f.created_at DESC`)
    .all(req.ctx.tenantId);
  res.json(rows.map(f => ({ ...f, schema: j(f.schema_json, { fields: [] }) })));
}));

router.get('/:id', can('forms.view', 'forms.submit'), ah(async (req, res) => {
  const f = findScoped(req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  res.json({ ...f, schema: j(f.schema_json, { fields: [] }) });
}));

function validateSchema(schema) {
  const fields = schema?.fields;
  if (!Array.isArray(fields) || !fields.length) throw badRequest('يجب إضافة حقل واحد على الأقل للنموذج');
  for (const f of fields) {
    if (!f.id || !f.label) throw badRequest('كل حقل يحتاج معرّفاً وعنواناً');
    if (!FIELD_TYPES.includes(f.type)) throw badRequest(`نوع حقل غير مدعوم: ${f.type}`);
    if (['select', 'multiselect'].includes(f.type) && !Array.isArray(f.options)) throw badRequest(`الحقل "${f.label}" يحتاج قائمة خيارات`);
  }
  return { fields };
}

router.post('/', can('forms.manage'), ah(async (req, res) => {
  const { title, description, type, schema, target_role } = req.body || {};
  if (!title) throw badRequest('عنوان النموذج إلزامي');
  const clean = validateSchema(schema);
  const r = db.prepare('INSERT INTO forms(tenant_id,title,description,type,schema_json,target_role,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(req.ctx.tenantId, title.trim(), description || null, type || 'evaluation',
      JSON.stringify(clean), target_role || null, req.ctx.userId);
  audit(req, { action: 'create', entity: 'form', entityId: r.lastInsertRowid, summary: `بناء نموذج جديد: ${title} (${clean.fields.length} حقل)` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.patch('/:id', can('forms.manage'), ah(async (req, res) => {
  const f = findScoped(req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  const p = req.body || {};
  const clean = p.schema ? validateSchema(p.schema) : j(f.schema_json, { fields: [] });
  db.prepare('UPDATE forms SET title=?,description=?,type=?,schema_json=?,target_role=?,is_active=? WHERE id=? AND tenant_id=?')
    .run(p.title ?? f.title, p.description ?? f.description, p.type ?? f.type,
      JSON.stringify(clean), p.target_role ?? f.target_role, p.is_active ?? f.is_active, f.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'form', entityId: f.id, summary: `تعديل النموذج: ${f.title}` });
  res.json({ ok: true });
}));

router.delete('/:id', can('forms.manage'), ah(async (req, res) => {
  const f = findScoped(req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  db.prepare('UPDATE forms SET is_active=0 WHERE id=? AND tenant_id=?').run(f.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'form', entityId: f.id, summary: `تعطيل النموذج: ${f.title}` });
  res.json({ ok: true });
}));

/* ─────────────────────────── تعبئة النماذج والتقييم ─────────────────────── */
function scoreSubmission(schema, answers) {
  let score = 0, max = 0;
  for (const f of schema.fields || []) {
    const w = Number(f.weight) || 0;
    if (!w) continue;
    max += w;
    const v = answers[f.id];
    if (f.type === 'rating') {
      const m = Number(f.max) || 5;
      score += ((Number(v) || 0) / m) * w;
    } else if (f.type === 'select' && Array.isArray(f.options)) {
      const idx = f.options.indexOf(v);
      if (idx >= 0 && f.options.length > 1) score += ((f.options.length - idx - 1) / (f.options.length - 1)) * w;
    } else if (f.type === 'checkbox') {
      if (v) score += w;
    } else if (f.type === 'number') {
      const m = Number(f.max) || 100;
      score += Math.min(1, (Number(v) || 0) / m) * w;
    }
  }
  return max ? { score: Number(score.toFixed(1)), max_score: max } : { score: null, max_score: null };
}

router.post('/:id/submit', can('forms.submit'), ah(async (req, res) => {
  const f = findScoped(req.ctx, 'forms', req.params.id);
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
  const term = currentTerm(req.ctx.tenantId);
  const r = db.prepare(`INSERT INTO form_submissions(tenant_id,branch_id,term_id,form_id,subject_user_id,submitted_by,answers,score,max_score)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId,
    term?.id || null, f.id, req.body?.subject_user_id || null, req.ctx.userId,
    JSON.stringify(answers), score, max_score);

  audit(req, { action: 'create', entity: 'form_submission', entityId: r.lastInsertRowid,
    summary: `تعبئة النموذج (${f.title})${score !== null ? ` — النتيجة ${score}/${max_score}` : ''}` });

  if (req.body?.subject_user_id && f.type === 'evaluation') {
    await notifyUsers(req.ctx.tenantId, [req.body.subject_user_id], {
      type: 'evaluation.received', category: 'tasks', title: 'تم رصد تقييم جديد لك',
      body: `${f.title}${score !== null ? ` — النتيجة ${score} من ${max_score}` : ''}`, url: '/kpi'
    });
  }
  res.status(201).json({ id: r.lastInsertRowid, score, max_score });
}));

router.get('/:id/submissions', can('forms.results'), ah(async (req, res) => {
  const f = findScoped(req.ctx, 'forms', req.params.id);
  if (!f) throw notFound('النموذج غير موجود');
  const rows = db.prepare(`SELECT s.*, su.name subject_name, sb.name submitted_by_name, b.name branch_name
    FROM form_submissions s LEFT JOIN users su ON su.id=s.subject_user_id
    LEFT JOIN users sb ON sb.id=s.submitted_by LEFT JOIN branches b ON b.id=s.branch_id
    WHERE s.tenant_id=? AND s.form_id=? ORDER BY s.submitted_at DESC LIMIT 500`).all(req.ctx.tenantId, f.id);
  res.json({ form: { ...f, schema: j(f.schema_json, {}) }, submissions: rows.map(s => ({ ...s, answers: j(s.answers, {}) })) });
}));

/* ─────────────────────────── لوحات مؤشرات الأداء (KPI) ──────────────────── */
router.get('/kpi/overview', can('kpi.view', 'kpi.view_all'), ah(async (req, res) => {
  const viewAll = has(req.ctx, 'kpi.view_all');
  const term = req.query.term_id ? Number(req.query.term_id) : (req.ctx.activeTermId || currentTerm(req.ctx.tenantId)?.id);
  const sc = scoped(req.ctx, { alias: 'k' });
  let sql = `SELECT k.*, u.name user_name, u.avatar_url, b.name branch_name, c.name committee_name
    FROM kpis k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN branches b ON b.id=k.branch_id
    LEFT JOIN committees c ON c.id=k.committee_id WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!viewAll) { sql += ' AND k.user_id=?'; params.push(req.ctx.userId); }
  if (term) { sql += ' AND k.term_id=?'; params.push(term); }
  sql += " AND k.period='term' ORDER BY k.score DESC";
  const rows = db.prepare(sql).all(...params);

  const tScope = scoped(req.ctx, { alias: 't' });
  const taskStats = db.prepare(`SELECT status, COUNT(*) c FROM tasks t WHERE ${tScope.where} ${term ? 'AND t.term_id=?' : ''}
    ${viewAll ? '' : 'AND t.assignee_id=' + req.ctx.userId} GROUP BY status`)
    .all(...tScope.params, ...(term ? [term] : []));

  const overdue = db.prepare(`SELECT COUNT(*) c FROM tasks t WHERE ${tScope.where} AND t.status<>'done' AND t.due_date < date('now')
    ${term ? 'AND t.term_id=?' : ''} ${viewAll ? '' : 'AND t.assignee_id=' + req.ctx.userId}`)
    .get(...tScope.params, ...(term ? [term] : [])).c;

  const evalAvg = db.prepare(`SELECT AVG(score) a, COUNT(*) c FROM form_submissions s
    WHERE s.tenant_id=? AND s.score IS NOT NULL ${term ? 'AND s.term_id=?' : ''}
    ${viewAll ? '' : 'AND s.subject_user_id=' + req.ctx.userId}`)
    .get(req.ctx.tenantId, ...(term ? [term] : []));

  res.json({
    leaderboard: rows,
    task_stats: Object.fromEntries(taskStats.map(t => [t.status, t.c])),
    overdue,
    evaluation: { avg: evalAvg.a ? Number(evalAvg.a.toFixed(1)) : null, count: evalAvg.c },
    term_id: term
  });
}));

router.post('/kpi/recompute', can('kpi.view_all'), ah(async (req, res) => {
  const { recomputeKPIs } = await import('../jobs/kpi.js');
  const n = recomputeKPIs(req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'kpi', summary: `إعادة احتساب مؤشرات الأداء يدوياً (${n} سجل)` });
  res.json({ ok: true, updated: n });
}));

export default router;
