import { Hono } from 'hono';
import { nowUTC, j, isMissingSchema } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden, locked, outOfRange, alreadyDone } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed } from '../scope.js';
import { haversine } from '../geo.js';
import { notifyUsers, notifyByPermission } from '../notify.js';
import { requireFeature } from '../features.js';
import {
  WEEK, DAY_NAMES, defaultDays, sanitizeDays, scheduleFromRow, dailyMinutes, weeklyMinutes, weeklyDays,
  tenantSchedule, effectiveSchedule, schedulesFor, dayPlan, lateMinutes,
  countWorkingDays, workingDaysBetween, describeSchedule, localDate, localMinutes
} from '../workhours.js';

const router = new Hono();

/* ─────────────── زر التحضير الذكي (البند ٥) ─────────────── */
/*
 * كل وحدة فرعية تُحرَس بميزتها لا بميزة الوحدة الأم:
 * خطة قد تمنح الحضور دون مسير الرواتب — والعكس وارد في الصفقات المخصّصة.
 */
router.use('/attendance', requireFeature('attendance'));
router.use('/attendance/*', requireFeature('attendance'));
router.use('/employees', requireFeature('attendance'));
router.use('/employees/*', requireFeature('attendance'));
router.use('/leaves', requireFeature('attendance'));
router.use('/leaves/*', requireFeature('attendance'));
router.use('/advances', requireFeature('payroll'));
router.use('/advances/*', requireFeature('payroll'));

/**
 * فروع الموظف التي يصحّ التحضير منها.
 *
 * من عُيّن على فروعٍ عدّة يُحضِّر من أيّها كان — وكان الخادم يقيس المسافة إلى فرعٍ
 * واحدٍ يختاره هو، فيُرفض من وقف في فرعه الثاني وهو داخل نطاقه تماماً. فصارت
 * الفروع كلُّها تُقاس ويُقبل أقربُها الذي هو داخل نطاقه.
 *
 * وبلا إحداثيات لا يُقاس فرع، فتُستبعد — لا تُرفَض المحاولة بسببها.
 */
const checkinBranches = async (app, ctx) => {
  const ids = ctx.branchIds || [];
  if (!ids.length) return [];
  return app.db.all(
    `SELECT id,name,lat,lng,geofence_radius,address FROM branches
     WHERE tenant_id=? AND is_active=1 AND lat IS NOT NULL AND lng IS NOT NULL
       AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
    ctx.tenantId, ...ids);
};

/** هل يُسمح لهذا الموظف بالحضور عن بُعد؟ */
const remoteAllowed = async (app, ctx) => Boolean((await app.db.get(
  'SELECT remote_allowed FROM employees WHERE tenant_id=? AND user_id=?', ctx.tenantId, ctx.userId))?.remote_allowed);

/**
 * الفرع الذي يُنسب إليه دوامُ الموظف — فرعُ ملفّه أوّلاً.
 *
 * ليس بالضرورة الفرع الذي يقف فيه اليوم: من عُيّن على فرعين وله جدولُ فرعه
 * الأصلي لا يتبدّل دوامُه لأنه حضر من الفرع الآخر.
 */
const homeBranchOf = async (app, ctx, userId = ctx.userId) => {
  const e = await app.db.get('SELECT branch_id FROM employees WHERE tenant_id=? AND user_id=?', ctx.tenantId, userId);
  if (e?.branch_id) return e.branch_id;
  if (userId !== ctx.userId) {
    const u = await app.db.get('SELECT primary_branch_id FROM users WHERE tenant_id=? AND id=?', ctx.tenantId, userId);
    return u?.primary_branch_id || null;
  }
  return ctx.primaryBranchId || ctx.branchIds?.[0] || null;
};

/** جدولُ دوامِ مستخدمٍ نافذاً — موظفُه فوق فرعِه فوق مجمَّعِه */
const scheduleOf = async (app, ctx, userId = ctx.userId) => effectiveSchedule(app, ctx.tenantId, {
  userId, branchId: await homeBranchOf(app, ctx, userId), settings: ctx.tenantSettings || {}
});

router.get('/attendance/today', can('hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const date = localDate();
  const row = await app.db.get('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?',
    req.ctx.tenantId, req.ctx.userId, date);

  const branches = await checkinBranches(app, req.ctx);
  /* الفرع المبدئي — عليه تفتح الخريطة قبل أن يُعرف موقع الموظف */
  const preferred = req.ctx.activeBranchId || req.ctx.primaryBranchId;
  const branch = branches.find(b => b.id === preferred) || branches[0] || null;

  /*
   * دوامُ اليوم يُقرأ من جدول الموظف النافذ لا من إعدادٍ واحدٍ للمجمّع كلّه.
   * و`workday` باقٍ كما كان لمن يقرؤه من الشاشات القديمة، ومعه الآن خطّةُ اليوم
   * كاملةً: أهو يوم عمل، وكم مدّته، وكم يُسمح بالتأخّر عنه.
   */
  const schedule = await scheduleOf(app, req.ctx);
  const plan = dayPlan(schedule, date);
  return {
    date, record: row || null,
    next_action: !row || !row.check_in_at ? 'check_in' : (!row.check_out_at ? 'check_out' : 'done'),
    branch,
    branches,
    remote_allowed: await remoteAllowed(app, req.ctx),
    geofence_radius: branch?.geofence_radius || app.cfg.geofenceDefault,
    workday: { start: plan.start, end: plan.end },
    day: plan,
    schedule: { days: schedule.days, grace_min: schedule.grace_min, source: schedule.source,
      summary: describeSchedule(schedule) },
    server_time: nowUTC()
  };
}));

router.post('/attendance/check', can('hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const { lat, lng, accuracy, branch_id } = req.body || {};
  if (lat === undefined || lng === undefined) throw badRequest('تعذّر تحديد موقعك، فعّل خدمة الموقع وأعد المحاولة');

  /* أرقامٌ عربية كما في بقية رسائل المنصة — والشارة فوق الخريطة بجانبها */
  const m = (n) => Number(n).toLocaleString('ar-SA');
  const remote = await remoteAllowed(app, req.ctx);

  /*
   * فرعٌ بعينه إن طُلب، وإلا فكلُّ فروع الموظف: من عُيّن على فروعٍ عدّة يُحضِّر من
   * أيّها وقف فيه. ويُقاس أقربُها إليه لا أوّلُها في القائمة.
   */
  let candidates;
  if (branch_id) {
    const one = await app.db.get('SELECT * FROM branches WHERE id=? AND tenant_id=?',
      await assertBranch(app, req.ctx, branch_id), req.ctx.tenantId);
    candidates = one ? [one] : [];
  } else {
    candidates = await checkinBranches(app, req.ctx);
  }

  /*
   * العمل عن بُعد: لا نطاقَ يُقاس، والفرع يبقى للنسبة الإدارية فقط. ولو لم يكن
   * للموظف فرعٌ بإحداثيات لم يمنعه ذلك — فمن يعمل عن بُعد قد لا يكون له مقرّ.
   */
  let branch = null, distance = null;
  if (remote) {
    branch = candidates[0]
      || await app.db.get('SELECT * FROM branches WHERE id=? AND tenant_id=?',
        req.ctx.activeBranchId || req.ctx.primaryBranchId || req.ctx.branchIds[0] || 0, req.ctx.tenantId)
      || null;
    if (branch) distance = haversine(Number(lat), Number(lng), branch.lat, branch.lng);
  } else {
    if (!candidates.length) {
      throw badRequest(req.ctx.branchIds?.length
        ? 'لم تُضبط إحداثيات فرعك بعد، راجع الإدارة'
        : 'لم يتم تحديد الفرع الخاص بك، راجع الموارد البشرية');
    }
    /* الأقرب أوّلاً، فإن كان داخل نطاقه قُبل — وإن لم يكن فهو الذي تُذكر مسافته */
    const measured = candidates
      .map(b => ({ b, d: haversine(Number(lat), Number(lng), b.lat, b.lng),
        r: b.geofence_radius || app.cfg.geofenceDefault }))
      .sort((x, y) => (x.d - x.r) - (y.d - y.r));
    const hit = measured.find(x => x.d <= x.r) || null;

    if (!hit) {
      const n = measured[0];
      await audit(req, { action: 'reject', entity: 'attendance', branchId: n.b.id,
        summary: `محاولة تحضير مرفوضة — المسافة ${m(n.d)}م تتجاوز نطاق الفرع (${m(n.r)}م)` });
      throw outOfRange(
        measured.length > 1
          ? `أنت خارج نطاق فروعك كلّها. أقربها ${n.b.name} على بُعد ${m(n.d)} متراً، ونطاقه ${m(n.r)} متراً.`
          : `أنت خارج نطاق الفرع (${m(n.d)} متراً من ${n.b.name}). النطاق المسموح ${m(n.r)} متراً.`,
        { distance: n.d, radius: n.r, branch_id: n.b.id, branch_name: n.b.name });
    }
    branch = hit.b; distance = hit.d;
  }

  const term = await currentTerm(app, req.ctx.tenantId);
  if (term && await termIsClosed(app, req.ctx.tenantId, term.id)) throw locked();
  const date = localDate();
  const existing = await app.db.get('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?',
    req.ctx.tenantId, req.ctx.userId, date);
  /*
   * التأخّر يُقاس بجدول الموظف نفسه لا بساعةٍ واحدةٍ للمجمّع كلّه: من دوامه
   * بعد العصر كان يُسجَّل متأخّراً كلَّ يوم لأن الإعداد العامّ يقول ٧:٣٠.
   * ويُحفظ بدقائقه لا بعلامةٍ فقط — فمن تأخّر خمس دقائق لا يُخصم منه كمن
   * تأخّر ساعتين حين يُبنى المسير.
   */
  const schedule = await scheduleOf(app, req.ctx);
  const plan = dayPlan(schedule, date);

  /* أين وقع الحضور — يُكتب في السجلّ والتنبيه معاً فلا يُسأل عنه بعد شهر */
  const place = remote ? 'عن بُعد' : `في ${branch.name} (${m(distance)}م)`;

  if (!existing) {
    const lateMin = lateMinutes(schedule, date, localMinutes());
    const late = lateMin > 0;
    /*
     * `late_minutes` عمودٌ مستجدّ. وبين نشر الشيفرة وتطبيق المخطط نافذةٌ لا
     * وجود له فيها — ولا يصحّ أن يُردَّ المُحضِّر أمام فرعه لأجل عمودٍ إحصائيّ.
     * فيُكتب الصفُّ بدونه، والحالةُ (متأخّر/حاضر) محفوظةٌ كما كانت قبل الجداول.
     */
    const COLS = 'tenant_id,branch_id,term_id,user_id,date,check_in_at,in_lat,in_lng,in_distance,is_remote,status';
    const vals = [req.ctx.tenantId, branch?.id || null, term?.id || null, req.ctx.userId, date, nowUTC(),
      Number(lat), Number(lng), distance, remote ? 1 : 0, late ? 'late' : 'present'];
    let r;
    try {
      r = await app.db.run(
        `INSERT INTO attendance(${COLS},late_minutes) VALUES(${'?,'.repeat(vals.length)}?)`, ...vals, lateMin);
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
      r = await app.db.run(
        `INSERT INTO attendance(${COLS}) VALUES(${'?,'.repeat(vals.length - 1)}?)`, ...vals);
    }
    await audit(req, { action: 'create', entity: 'attendance', entityId: r.lastId, branchId: branch?.id || null,
      summary: `${req.ctx.userName} سجّل الحضور ${place}`
        + (late ? ` — متأخراً ${m(lateMin)} دقيقة عن ${plan.start}` : '') });
    return { ok: true, action: 'check_in', distance, remote, branch: branch?.name || null,
      status: late ? 'late' : 'present', late_minutes: lateMin, day: plan,
      /* الفرع يُسمّى في الحالتين: من له فروعٌ عدّة يحتاج أن يعرف أيَّها سُجّل له،
         والتأخير لا يُلغي ذلك — بل هو أحوج ما يكون إليه حين يُراجَع السجلّ */
      message: (remote ? 'تم تسجيل حضورك عن بُعد' : `تم تسجيل حضورك في ${branch.name}`)
        + (late ? ` — مسجّل كتأخير ${m(lateMin)} دقيقة`
          : plan.working ? '، وفقك الله' : ' في يوم راحتك، وفقك الله'),
      record: await app.db.get('SELECT * FROM attendance WHERE id=?', r.lastId) };
  }

  if (existing.check_out_at) throw alreadyDone('تم تسجيل حضورك وانصرافك لهذا اليوم مسبقاً');

  const minutes = Math.max(0, Math.round((Date.now() - new Date(existing.check_in_at).getTime()) / 60000));
  await app.db.run('UPDATE attendance SET check_out_at=?,out_lat=?,out_lng=?,out_distance=?,minutes_worked=? WHERE id=?',
    nowUTC(), Number(lat), Number(lng), distance, minutes, existing.id);
  await audit(req, { action: 'update', entity: 'attendance', entityId: existing.id, branchId: branch?.id || null,
    summary: `${req.ctx.userName} سجّل الانصراف ${remote ? 'عن بُعد' : `من ${branch.name}`} — ${Math.floor(minutes / 60)} ساعة و${minutes % 60} دقيقة` });
  return { ok: true, action: 'check_out', distance, minutes,
    message: `تم تسجيل انصرافك — مدة العمل ${Math.floor(minutes / 60).toLocaleString('ar-SA')} ساعة و${(minutes % 60).toLocaleString('ar-SA')} دقيقة`,
    record: await app.db.get('SELECT * FROM attendance WHERE id=?', existing.id) };
}));

router.get('/attendance', can('hr.attendance.view', 'hr.attendance.self'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name AS user_name, b.name AS branch_name, e.employee_no, e.job_title
    FROM attendance a JOIN users u ON u.id=a.user_id
    LEFT JOIN branches b ON b.id=a.branch_id
    LEFT JOIN employees e ON e.user_id=a.user_id AND e.tenant_id=a.tenant_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.attendance.view')) { sql += ' AND a.user_id=?'; params.push(req.ctx.userId); }
  const q = req.query;
  if (q.user_id) { sql += ' AND a.user_id=?'; params.push(Number(q.user_id)); }
  if (q.branch_id) { sql += ' AND a.branch_id=?'; params.push(Number(q.branch_id)); }
  if (q.from) { sql += ' AND a.date >= ?'; params.push(q.from); }
  if (q.to) { sql += ' AND a.date <= ?'; params.push(q.to); }
  if (q.status) { sql += ' AND a.status=?'; params.push(q.status); }
  sql += ' ORDER BY a.date DESC, u.name LIMIT ?';
  params.push(Math.min(2000, Number(q.limit) || 500));
  return req.app.db.all(sql, ...params);
}));

router.patch('/attendance/:id', can('hr.attendance.manage'), h(async (req) => {
  const app = req.app;
  const a = await findScoped(app, req.ctx, 'attendance', req.params.id, { branchCheck: true });
  if (!a) throw notFound('السجل غير موجود');
  if (await termIsClosed(app, req.ctx.tenantId, a.term_id)) throw locked();
  const p = req.body || {};
  const status = p.status ?? a.status;
  /* من صُحّحت حالته إلى غير التأخير لا تبقى عليه دقائقُه — المسير يقرؤها فيخصم */
  const late = p.late_minutes !== undefined
    ? Math.max(0, Number(p.late_minutes) || 0)
    : (status === 'late' ? (a.late_minutes || 0) : 0);
  const head = [status, p.note ?? a.note, p.check_in_at ?? a.check_in_at,
    p.check_out_at ?? a.check_out_at, p.minutes_worked ?? a.minutes_worked];
  try {
    await app.db.run(
      `UPDATE attendance SET status=?, note=?, check_in_at=?, check_out_at=?, minutes_worked=?, late_minutes=?
        WHERE id=? AND tenant_id=?`, ...head, late, a.id, req.ctx.tenantId);
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    await app.db.run(
      `UPDATE attendance SET status=?, note=?, check_in_at=?, check_out_at=?, minutes_worked=?
        WHERE id=? AND tenant_id=?`, ...head, a.id, req.ctx.tenantId);
  }
  await audit(req, { action: 'update', entity: 'attendance', entityId: a.id,
    summary: `تعديل يدوي لسجل حضور بتاريخ ${a.date}`, before: a, after: p });
  return { ok: true };
}));

/* ─────────────── جداول الدوام: أيام العمل وساعاته ───────────────
 *
 * لوحةٌ واحدة تضبط دوام المجمّع كلّه، أو فرعاً بعينه، أو موظفاً بعينه.
 * والثلاثة تُقرأ بالوراثة: جدولُ الموظف يعلو جدولَ فرعه، وجدولُ الفرع يعلو
 * جدولَ المجمّع. وحذفُ جدولٍ ليس تعطيلاً للدوام بل رجوعٌ إلى ما يرثه.
 */
router.use('/schedules', requireFeature('attendance'));
router.use('/schedules/*', requireFeature('attendance'));

/** من يضبط الدوام: الموارد البشرية بصلاحية الحضور، أو من يملك إعدادات الجهة */
const maySchedule = (ctx) => has(ctx, 'hr.attendance.manage') || has(ctx, 'settings.manage');
const assertSchedule = (ctx) => {
  if (!maySchedule(ctx)) throw forbidden('ضبط أوقات الدوام يحتاج صلاحية تعديل الحضور أو إدارة الإعدادات');
};

/**
 * جدولُ المجمّع كلّه لا يضبطه من لا يرى إلا فرعه.
 *
 * ومسؤول الموارد البشرية ليس «مدير جهة» في الأدوار، ولكنه المعنيّ بالدوام
 * والحضور والمسير — فمن كان تعيينه يشمل الفروع النشطة كلَّها فنطاقه نطاق
 * المجمّع فعلاً وإن لم يحمل اسمه، ومن اقتصر على فرعٍ يضبط فرعه لا غير.
 */
async function assertTenantWide(app, ctx) {
  if (ctx.allBranches || has(ctx, 'settings.manage')) return;
  const all = await app.db.all('SELECT id FROM branches WHERE tenant_id=? AND is_active=1', ctx.tenantId);
  const mine = new Set(ctx.branchIds || []);
  /* ومجمّعٌ بلا فروعٍ بعد لا يُحجب دوامُه عمّن يضبط الحضور — لا نطاق يُقصّر عنه */
  if (!all.length || all.every(b => mine.has(b.id))) return;
  throw forbidden('دوام المجمّع كلّه يضبطه من نطاقه كلُّ الفروع');
}

/** موظفٌ يقع في نطاق من يضبط جدوله — ولو كان يعمل في أكثر من فرع */
async function assertUserInScope(app, ctx, userId) {
  const u = await app.db.get('SELECT id, name, primary_branch_id FROM users WHERE id=? AND tenant_id=?',
    Number(userId) || 0, ctx.tenantId);
  if (!u) throw notFound('المستخدم غير موجود');
  if (ctx.allBranches) return u;
  const ids = ctx.branchIds || [];
  if (!ids.length) throw forbidden('ليست لديك صلاحية على أي فرع');
  if (u.primary_branch_id && ids.includes(u.primary_branch_id)) return u;
  const hit = await app.db.get(
    `SELECT 1 AS x FROM user_branches WHERE tenant_id=? AND user_id=? AND branch_id IN (${ids.map(() => '?').join(',')})`,
    ctx.tenantId, u.id, ...ids);
  if (!hit) throw forbidden('هذا المنسوب خارج فروعك');
  return u;
}

/** يُلبس الجدولَ ما تعرضه اللوحة: خلاصةٌ نصّية وحصيلةٌ أسبوعية */
const decorate = (sc) => ({
  ...sc, summary: describeSchedule(sc),
  weekly_minutes: weeklyMinutes(sc.days), weekly_days: weeklyDays(sc.days),
  daily_minutes: dailyMinutes(sc.days)
});

router.get('/schedules', can('hr.attendance.view', 'hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const ctx = req.ctx;
  const settings = ctx.tenantSettings || {};
  const tenant = decorate(await tenantSchedule(app, ctx.tenantId, settings));

  const rows = await app.db.all(
    `SELECT * FROM work_schedules WHERE tenant_id=? AND scope IN ('branch','user')`, ctx.tenantId);
  const byBranch = new Map(rows.filter(r => r.scope === 'branch').map(r => [r.branch_id, r]));
  const byUser = new Map(rows.filter(r => r.scope === 'user').map(r => [r.user_id, r]));

  const bsc = scoped(ctx, { alias: 'b', branchColumn: 'id' });
  const branches = await app.db.all(
    `SELECT b.id, b.name, b.code FROM branches b WHERE ${bsc.where} AND b.is_active=1 ORDER BY b.code`, ...bsc.params);

  /* الموظفون كلُّهم لا أصحابُ الاستثناءات وحدهم: اللوحة تُعدِّل من لا جدول له أيضاً */
  const esc = scoped(ctx, { alias: 'e' });
  const people = await app.db.all(
    `SELECT e.user_id, e.branch_id, e.job_title, e.employee_no, e.status, u.name, b.name AS branch_name
       FROM employees e JOIN users u ON u.id=e.user_id
       LEFT JOIN branches b ON b.id=e.branch_id
      WHERE ${esc.where} AND u.status='active' ORDER BY u.name`, ...esc.params);

  /* `source` تقول من أين جاء الجدول فعلاً، و`overridden` تقول أهو موضوعٌ هنا */
  const branchOut = branches.map(b => {
    const row = byBranch.get(b.id);
    return {
      id: b.id, name: b.name, code: b.code, overridden: !!row,
      schedule: row ? decorate({ ...scheduleFromRow(row, settings), source: 'branch' }) : tenant
    };
  });

  const usersOut = people.map(p => {
    const row = byUser.get(p.user_id);
    const inherited = branchOut.find(b => b.id === p.branch_id)?.schedule || tenant;
    return {
      user_id: p.user_id, name: p.name, job_title: p.job_title, employee_no: p.employee_no,
      branch_id: p.branch_id, branch_name: p.branch_name, overridden: !!row,
      schedule: row ? decorate({ ...scheduleFromRow(row, settings), source: 'user' }) : inherited
    };
  });

  return {
    week: WEEK, day_names: DAY_NAMES,
    tenant, branches: branchOut, users: usersOut,
    fallback: { days: defaultDays(settings), grace_min: Number(settings.late_after_minutes ?? 15) },
    can_manage: maySchedule(ctx),
    can_manage_tenant: maySchedule(ctx)
      && await assertTenantWide(app, ctx).then(() => true).catch(() => false)
  };
}));

router.put('/schedules', h(async (req) => {
  const app = req.app;
  const ctx = req.ctx;
  assertSchedule(ctx);
  const p = req.body || {};
  const scope = ['tenant', 'branch', 'user'].includes(p.scope) ? p.scope : 'tenant';
  const settings = ctx.tenantSettings || {};

  let branchId = 0, userId = 0, label = 'المجمّع';
  if (scope === 'tenant') await assertTenantWide(app, ctx);
  if (scope === 'branch') {
    branchId = await assertBranch(app, ctx, p.branch_id);
    if (!branchId) throw badRequest('يجب اختيار الفرع');
    label = (await app.db.get('SELECT name FROM branches WHERE id=?', branchId))?.name || `فرع ${branchId}`;
  }
  if (scope === 'user') {
    const u = await assertUserInScope(app, ctx, p.user_id);
    userId = u.id; label = u.name;
  }

  /* الأساس الذي تُكمَّل منه الحقول الناقصة هو ما يرثه هذا المستوى فعلاً */
  const inherited = scope === 'tenant'
    ? await tenantSchedule(app, ctx.tenantId, settings)
    : scope === 'branch'
      ? await effectiveSchedule(app, ctx.tenantId, { branchId, settings })
      : await effectiveSchedule(app, ctx.tenantId,
        { userId, branchId: await homeBranchOf(app, ctx, userId), settings });

  const days = sanitizeDays(p.days, inherited.days);
  if (!weeklyDays(days)) throw badRequest('لا بدّ من يوم عملٍ واحدٍ على الأقل');
  const grace = Math.max(0, Math.min(240, Number(p.grace_min ?? inherited.grace_min ?? 15) || 0));
  const note = String(p.note || '').trim().slice(0, 240) || null;

  await app.db.run(
    `INSERT INTO work_schedules(tenant_id,scope,branch_id,user_id,days,grace_min,note,updated_by,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,scope,branch_id,user_id) DO UPDATE SET
       days=excluded.days, grace_min=excluded.grace_min, note=excluded.note,
       updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    ctx.tenantId, scope, branchId, userId, JSON.stringify(days), grace, note, ctx.userId, nowUTC());

  /*
   * «طبّقه على كل الفروع» يمسح استثناءات الفروع بدل أن يكتب صفّاً لكلٍّ منها:
   * التوحيد رجوعٌ إلى الوراثة، فمن أضاف فرعاً غداً وجده موحَّداً بلا عملٍ ثانٍ.
   */
  let cleared = 0;
  if (scope === 'tenant' && p.apply_to_branches) {
    await assertTenantWide(app, ctx);
    cleared = (await app.db.run(
      `DELETE FROM work_schedules WHERE tenant_id=? AND scope='branch'`, ctx.tenantId)).changes || 0;
  }

  const saved = decorate({ id: null, scope, branch_id: branchId || null, user_id: userId || null,
    days, grace_min: grace, note, source: scope });
  await audit(req, { action: 'update', entity: 'work_schedule', entityId: `${scope}:${branchId || userId || 0}`,
    branchId: branchId || null,
    summary: `${ctx.userName} ضبط دوام ${label} — ${saved.summary}`
      + (cleared ? ` ووحّد ${cleared} فرعاً عليه` : ''),
    before: { summary: describeSchedule(inherited) }, after: { summary: saved.summary, grace_min: grace } });

  /* من تغيّر دوامه يُخبَر به: الخصمُ من الراتب يبدأ من الغد ولا يُفاجَأ به */
  if (scope === 'user') await notifyUsers(app, ctx.tenantId, [userId], {
    type: 'schedule.updated', category: 'hr', title: 'تم تحديث أوقات دوامك',
    body: saved.summary, url: '/checkin'
  });

  return { ok: true, schedule: saved, cleared_branches: cleared };
}));

router.delete('/schedules/:scope/:id', h(async (req) => {
  const app = req.app;
  const ctx = req.ctx;
  assertSchedule(ctx);
  const scope = req.params.scope;
  if (!['tenant', 'branch', 'user'].includes(scope)) throw badRequest('نطاق غير مدعوم');
  let branchId = 0, userId = 0, label = 'المجمّع';
  if (scope === 'tenant') await assertTenantWide(app, ctx);
  if (scope === 'branch') {
    branchId = await assertBranch(app, ctx, req.params.id);
    label = (await app.db.get('SELECT name FROM branches WHERE id=?', branchId))?.name || `فرع ${branchId}`;
  }
  if (scope === 'user') { const u = await assertUserInScope(app, ctx, req.params.id); userId = u.id; label = u.name; }

  const r = await app.db.run(
    'DELETE FROM work_schedules WHERE tenant_id=? AND scope=? AND branch_id=? AND user_id=?',
    ctx.tenantId, scope, branchId, userId);
  if (!r.changes) throw notFound('لا يوجد جدول خاص بهذا المستوى');
  await audit(req, { action: 'delete', entity: 'work_schedule', entityId: `${scope}:${branchId || userId || 0}`,
    branchId: branchId || null, summary: `${ctx.userName} أعاد دوام ${label} إلى الموروث` });
  return { ok: true };
}));

/* ─────────────── ملفات الموظفين ─────────────── */
router.get('/employees', can('hr.employees.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'e' });
  return req.app.db.all(`SELECT e.*, u.name, u.email, u.phone, u.status AS user_status, u.avatar_url,
      b.name AS branch_name, r.name AS role_name
    FROM employees e JOIN users u ON u.id=e.user_id
    LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN roles r ON r.id=u.role_id
    WHERE ${sc.where} ORDER BY e.employee_no`, ...sc.params);
}));

router.get('/employees/:userId/file', can('hr.employees.view', 'hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const userId = Number(req.params.userId);
  if (userId !== req.ctx.userId && !has(req.ctx, 'hr.employees.view')) throw forbidden();
  const emp = await app.db.get(
    `SELECT e.*, u.name,u.email,u.phone,u.avatar_url,u.national_id, b.name AS branch_name, r.name AS role_name
     FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN branches b ON b.id=e.branch_id
     LEFT JOIN roles r ON r.id=u.role_id WHERE e.tenant_id=? AND e.user_id=?`, req.ctx.tenantId, userId);
  if (!emp) throw notFound('ملف الموظف غير موجود');

  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const attendance = await app.db.all(
    `SELECT date,status,check_in_at,check_out_at,minutes_worked FROM attendance
     WHERE tenant_id=? AND user_id=? AND date>=? ORDER BY date DESC`, req.ctx.tenantId, userId, from);
  const summary = attendance.reduce((s, a) => { s[a.status] = (s[a.status] || 0) + 1; s.minutes += a.minutes_worked; return s; },
    { present: 0, late: 0, absent: 0, leave: 0, minutes: 0 });
  const leaves = await app.db.all('SELECT * FROM leaves WHERE tenant_id=? AND user_id=? ORDER BY start_date DESC LIMIT 30', req.ctx.tenantId, userId);
  const advances = await app.db.all('SELECT * FROM advances WHERE tenant_id=? AND user_id=? ORDER BY date DESC LIMIT 30', req.ctx.tenantId, userId);
  const payroll = await app.db.all(`SELECT pi.*, pr.year, pr.month, pr.status FROM payroll_items pi
    JOIN payroll_runs pr ON pr.id=pi.payroll_run_id WHERE pi.tenant_id=? AND pi.user_id=?
    ORDER BY pr.year DESC, pr.month DESC LIMIT 12`, req.ctx.tenantId, userId);
  const tasks = await app.db.get(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE tenant_id=? AND assignee_id=?`,
    req.ctx.tenantId, userId);
  const evals = await app.db.get(
    'SELECT AVG(score) AS avg_score, COUNT(*) AS c FROM form_submissions WHERE tenant_id=? AND subject_user_id=?',
    req.ctx.tenantId, userId);

  /* جدولُ دوامه ضمن ملفّه: التأخّر والغياب أعلاه لا يُفهمان بلا معرفة ما يلزمه */
  const sc = await effectiveSchedule(app, req.ctx.tenantId, {
    userId, branchId: emp.branch_id, settings: req.ctx.tenantSettings || {} });

  return { employee: emp, documents: await docsOf(app, req.ctx.tenantId, userId),
    schedule: { days: sc.days, grace_min: sc.grace_min, source: sc.source,
      summary: describeSchedule(sc), weekly_minutes: weeklyMinutes(sc.days),
      weekly_days: weeklyDays(sc.days), daily_minutes: dailyMinutes(sc.days) },
    attendance, attendance_summary: summary, leaves, advances,
    payroll: payroll.map(p => ({ ...p, details: j(p.details, {}) })),
    tasks: { total: tasks.total || 0, done: tasks.done || 0 },
    evaluation: { avg: evals.avg_score ? Number(evals.avg_score.toFixed(1)) : null, count: evals.c } };
}));

router.post('/employees', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const p = req.body || {};
  if (!p.user_id) throw badRequest('يجب اختيار المستخدم');
  const bid = p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : req.ctx.primaryBranchId;
  await app.db.run(
    `INSERT INTO employees(tenant_id,branch_id,user_id,employee_no,job_title,department,contract_type,hire_date,contract_end,basic_salary,allowances,bank_iban,remote_allowed)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,user_id) DO UPDATE SET job_title=excluded.job_title, department=excluded.department,
       basic_salary=excluded.basic_salary, allowances=excluded.allowances, branch_id=excluded.branch_id,
       remote_allowed=excluded.remote_allowed`,
    req.ctx.tenantId, bid, p.user_id, p.employee_no || null, p.job_title || null, p.department || null,
    p.contract_type || 'دوام كامل', p.hire_date || null, p.contract_end || null,
    Number(p.basic_salary) || 0, Number(p.allowances) || 0, p.bank_iban || null, p.remote_allowed ? 1 : 0);
  await audit(req, { action: 'create', entity: 'employee', entityId: p.user_id, summary: `تحديث ملف موظف (${p.job_title || ''})` });
  return created({ ok: true });
}));

/*
 * تعديل ملف الموظف — وبياناته في جدولين لا جدول.
 *
 * الوظيفة والعقد والراتب في `employees`، والاسم والبريد والجوال والهوية في
 * `users`. وكان لا بدّ من شاشتين لتغيير اسمٍ وراتب، والمستخدم لا يعرف ذلك ولا
 * يعنيه. فصار المسار يقبل المجموعتين معاً، وكلُّ مجموعةٍ تُحرَس بصلاحيتها هي:
 *
 *   • بيانات الوظيفة والعقد  → `hr.employees.manage` (حارس المسار نفسه)
 *   • الراتب والبدلات والآيبان → `hr.payroll.view` — من لا يراه لا يضعه
 *   • الاسم والبريد والجوال والهوية → `users.manage`
 *
 * فمسؤول الموارد البشرية بلا صلاحية المستخدمين يعدّل الوظيفة والراتب، ويُردّ
 * برسالة صريحة إن حاول تغيير الاسم — لا يمرّ التعديل صامتاً ولا يُرفض كلُّه.
 */
const EMP_FIELDS = ['employee_no', 'job_title', 'department', 'contract_type',
  'hire_date', 'contract_end', 'status', 'remote_allowed'];
const PAY_FIELDS = ['basic_salary', 'allowances', 'bank_iban'];
const USER_FIELDS = ['name', 'email', 'phone', 'national_id'];
const touches = (p, keys) => keys.some(k => p[k] !== undefined);

router.patch('/employees/:id', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const e = await findScoped(app, req.ctx, 'employees', req.params.id, { branchCheck: true });
  if (!e) throw notFound('ملف الموظف غير موجود');
  const p = req.body || {};

  if (touches(p, PAY_FIELDS) && !has(req.ctx, 'hr.payroll.view'))
    throw forbidden('تعديل الراتب والبيانات البنكية يحتاج صلاحية الرواتب');
  if (touches(p, USER_FIELDS) && !has(req.ctx, 'users.manage'))
    throw forbidden('تعديل الاسم والبريد والجوال والهوية يحتاج صلاحية إدارة المستخدمين');

  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  await app.db.run(
    `UPDATE employees SET employee_no=?,job_title=?,department=?,contract_type=?,hire_date=?,contract_end=?,
      basic_salary=?,allowances=?,bank_iban=?,status=?,remote_allowed=?,branch_id=? WHERE id=? AND tenant_id=?`,
    p.employee_no ?? e.employee_no, p.job_title ?? e.job_title, p.department ?? e.department,
    p.contract_type ?? e.contract_type,
    /* التاريخ يُمحى بإرسال فراغ ويبقى إن لم يُرسَل — و`??` وحدها تخلط بينهما */
    p.hire_date !== undefined ? (p.hire_date || null) : e.hire_date,
    p.contract_end !== undefined ? (p.contract_end || null) : e.contract_end,
    num(p.basic_salary, e.basic_salary), num(p.allowances, e.allowances),
    p.bank_iban !== undefined ? (String(p.bank_iban).trim() || null) : e.bank_iban,
    p.status ?? e.status,
    p.remote_allowed === undefined ? e.remote_allowed : (p.remote_allowed ? 1 : 0),
    p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : e.branch_id, e.id, req.ctx.tenantId);

  if (touches(p, USER_FIELDS)) {
    const u = await app.db.get('SELECT * FROM users WHERE id=? AND tenant_id=?', e.user_id, req.ctx.tenantId);
    if (!u) throw notFound('حساب الموظف غير موجود');
    const email = p.email !== undefined ? String(p.email).trim().toLowerCase() : u.email;
    if (!email) throw badRequest('البريد الإلكتروني مطلوب');
    if (email !== u.email) {
      const taken = await app.db.get('SELECT id FROM users WHERE email=? AND id<>?', email, u.id);
      if (taken) throw badRequest('البريد الإلكتروني مستخدم لحساب آخر');
    }
    await app.db.run('UPDATE users SET name=?,email=?,phone=?,national_id=? WHERE id=? AND tenant_id=?',
      String(p.name ?? u.name).trim() || u.name, email,
      p.phone !== undefined ? (String(p.phone).trim() || null) : u.phone,
      p.national_id !== undefined ? (String(p.national_id).trim() || null) : u.national_id,
      u.id, req.ctx.tenantId);
  }

  await audit(req, { action: 'update', entity: 'employee', entityId: e.id, summary: 'تعديل ملف موظف', before: e, after: p });
  return { ok: true };
}));

/* ─────────────── وثائق الموظف ─────────────── */
/*
 * الملفّ يُرفع أولاً إلى `/api/files` كبقية مرفقات المنصة، ثم يُربط هنا بصاحبه:
 * لمن هو، وما نوعه، وبأي اسمٍ يُعرَف. والتسمية ليست ترفاً — «IMG_2481.jpg» لا
 * يصلح عنواناً لصورة إقامة، ومن يفتح الملف بعد سنةٍ يبحث عن «إقامة ١٤٤٧» لا عن
 * اسم الملف كما خرج من الهاتف. وتاريخ الانتهاء للهوية والإقامة والعقد يُدخَل
 * اختيارياً فتُعرف الوثيقة المنتهية من الشاشة بلا تفتيش.
 */
const DOC_KINDS = new Set(['id', 'contract', 'certificate', 'other']);

/** ملفُّ موظفٍ يقرؤه صاحبُه أو من يملك عرض ملفات الموظفين */
const assertFileAccess = (ctx, userId) => {
  if (userId !== ctx.userId && !has(ctx, 'hr.employees.view')) throw forbidden();
};

const docsOf = (app, tenantId, userId) => app.db.all(
  `SELECT d.id, d.kind, d.title, d.expires_at, d.note, d.created_at,
          d.file_id, f.original_name, f.mime, f.size, u.name AS uploaded_by_name
     FROM employee_documents d
     JOIN files f ON f.id = d.file_id
     LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.tenant_id=? AND d.user_id=?
    ORDER BY d.created_at DESC`, tenantId, userId);

router.get('/employees/:userId/documents', can('hr.employees.view', 'hr.attendance.self'), h(async (req) => {
  const userId = Number(req.params.userId);
  assertFileAccess(req.ctx, userId);
  return docsOf(req.app, req.ctx.tenantId, userId);
}));

router.post('/employees/:userId/documents', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const userId = Number(req.params.userId);
  const p = req.body || {};
  const emp = await app.db.get('SELECT user_id FROM employees WHERE tenant_id=? AND user_id=?', req.ctx.tenantId, userId);
  if (!emp) throw notFound('ملف الموظف غير موجود');

  /* الملفّ من هذه الجهة لا رقمٌ يُكتب بالهواء */
  const file = await app.db.get('SELECT id, original_name FROM files WHERE id=? AND tenant_id=?',
    Number(p.file_id) || 0, req.ctx.tenantId);
  if (!file) throw badRequest('الملف غير موجود — ارفعه أولاً');

  const kind = DOC_KINDS.has(p.kind) ? p.kind : 'other';
  const title = String(p.title || '').trim() || file.original_name;
  const r = await app.db.run(
    `INSERT INTO employee_documents(tenant_id,user_id,file_id,kind,title,expires_at,note,uploaded_by)
     VALUES(?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, userId, file.id, kind, title,
    p.expires_at || null, String(p.note || '').trim() || null, req.ctx.userId);
  await audit(req, { action: 'create', entity: 'employee_document', entityId: r.lastId,
    summary: `إرفاق وثيقة «${title}» بملف موظف` });
  return created({ ok: true, id: r.lastId });
}));

router.patch('/employees/:userId/documents/:id', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const userId = Number(req.params.userId);
  const d = await app.db.get('SELECT * FROM employee_documents WHERE id=? AND tenant_id=? AND user_id=?',
    Number(req.params.id), req.ctx.tenantId, userId);
  if (!d) throw notFound('الوثيقة غير موجودة');
  const p = req.body || {};
  const title = p.title !== undefined ? (String(p.title).trim() || d.title) : d.title;
  await app.db.run('UPDATE employee_documents SET kind=?,title=?,expires_at=?,note=? WHERE id=? AND tenant_id=?',
    DOC_KINDS.has(p.kind) ? p.kind : d.kind, title,
    p.expires_at !== undefined ? (p.expires_at || null) : d.expires_at,
    p.note !== undefined ? (String(p.note).trim() || null) : d.note,
    d.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'employee_document', entityId: d.id,
    summary: `تعديل وثيقة «${title}»`, before: d, after: p });
  return { ok: true };
}));

router.delete('/employees/:userId/documents/:id', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const d = await app.db.get('SELECT * FROM employee_documents WHERE id=? AND tenant_id=? AND user_id=?',
    Number(req.params.id), req.ctx.tenantId, Number(req.params.userId));
  if (!d) throw notFound('الوثيقة غير موجودة');
  /* يُفكّ الربط ويبقى الملفّ في مخزن الجهة — حذفُ ملفٍ قد يُشار إليه من موضعٍ آخر */
  await app.db.run('DELETE FROM employee_documents WHERE id=? AND tenant_id=?', d.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'employee_document', entityId: d.id,
    summary: `حذف وثيقة «${d.title || ''}» من ملف موظف` });
  return { ok: true };
}));

/* ─────────────── الإجازات والسلف ─────────────── */
router.get('/leaves', can('hr.leaves.request', 'hr.leaves.approve'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'l' });
  let sql = `SELECT l.*, u.name AS user_name, a.name AS approver_name FROM leaves l
    JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.approved_by WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.leaves.approve')) { sql += ' AND l.user_id=?'; params.push(req.ctx.userId); }
  if (req.query.status) { sql += ' AND l.status=?'; params.push(req.query.status); }
  sql += ' ORDER BY l.created_at DESC LIMIT 300';
  return req.app.db.all(sql, ...params);
}));

router.post('/leaves', can('hr.leaves.request'), h(async (req) => {
  const app = req.app;
  const { type, start_date, end_date, reason } = req.body || {};
  if (!start_date || !end_date) throw badRequest('تاريخا بداية ونهاية الإجازة إلزاميان');
  const days = Math.max(1, Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
  const term = await currentTerm(app, req.ctx.tenantId);
  const r = await app.db.run(
    `INSERT INTO leaves(tenant_id,branch_id,term_id,user_id,type,start_date,end_date,days,reason) VALUES(?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null, req.ctx.userId,
    type || 'annual', start_date, end_date, days, reason || null);
  await audit(req, { action: 'create', entity: 'leave', entityId: r.lastId, summary: `طلب إجازة ${days} يوم من ${start_date}` });
  await notifyByPermission(app, req.ctx.tenantId, 'hr.leaves.approve', {
    type: 'leave.requested', category: 'hr', title: 'طلب إجازة جديد',
    body: `${req.ctx.userName} — ${days} يوم ابتداءً من ${start_date}`, url: '/hr'
  }, { branchId: req.ctx.primaryBranchId });
  return created({ id: r.lastId, days });
}));

router.post('/leaves/:id/decide', can('hr.leaves.approve'), h(async (req) => {
  const app = req.app;
  const l = await findScoped(app, req.ctx, 'leaves', req.params.id, { branchCheck: true });
  if (!l) throw notFound('طلب الإجازة غير موجود');
  const approve = req.body?.action === 'approve';
  await app.db.run('UPDATE leaves SET status=?, approved_by=? WHERE id=? AND tenant_id=?',
    approve ? 'approved' : 'rejected', req.ctx.userId, l.id, req.ctx.tenantId);
  await audit(req, { action: approve ? 'approve' : 'reject', entity: 'leave', entityId: l.id,
    summary: `${req.ctx.userName} ${approve ? 'اعتمد' : 'رفض'} طلب إجازة (${l.days} يوم)` });
  await notifyUsers(app, req.ctx.tenantId, [l.user_id], {
    type: 'leave.decided', category: 'hr', title: approve ? 'تم اعتماد إجازتك' : 'تم رفض طلب إجازتك',
    body: `من ${l.start_date} إلى ${l.end_date}`, url: '/hr'
  });
  return { ok: true };
}));

router.get('/advances', can('hr.payroll.view', 'hr.attendance.self'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name AS user_name FROM advances a JOIN users u ON u.id=a.user_id WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.payroll.view')) { sql += ' AND a.user_id=?'; params.push(req.ctx.userId); }
  sql += ' ORDER BY a.date DESC LIMIT 300';
  return req.app.db.all(sql, ...params);
}));

router.post('/advances', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const { user_id, amount, reason, date, installments } = req.body || {};
  if (!user_id || !amount) throw badRequest('الموظف والمبلغ إلزاميان');
  const term = await currentTerm(app, req.ctx.tenantId);
  const r = await app.db.run(
    `INSERT INTO advances(tenant_id,branch_id,term_id,user_id,amount,remaining,installments,reason,date,status)
     VALUES(?,?,?,?,?,?,?,?,?,'approved')`,
    req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null, user_id,
    Number(amount), Number(amount), Number(installments) || 1, reason || null,
    date || new Date().toISOString().slice(0, 10));
  await audit(req, { action: 'create', entity: 'advance', entityId: r.lastId, summary: `تسجيل سلفة بمبلغ ${amount} ر.س` });
  await notifyUsers(app, req.ctx.tenantId, [user_id], {
    type: 'advance.created', category: 'hr', title: 'تم تسجيل سلفة',
    body: `بمبلغ ${Number(amount).toLocaleString('ar-SA')} ر.س وستُخصم من راتبك`, url: '/hr'
  });
  return created({ id: r.lastId });
}));

/* ─────────────── محرك احتساب الرواتب (البند ٥) ─────────────── */
router.use('/payroll', requireFeature('payroll'));
router.use('/payroll/*', requireFeature('payroll'));

router.get('/payroll', can('hr.payroll.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'p' });
  return req.app.db.all(`SELECT p.*, b.name AS branch_name, u.name AS generated_by_name,
      (SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_run_id=p.id) AS items_count
    FROM payroll_runs p LEFT JOIN branches b ON b.id=p.branch_id LEFT JOIN users u ON u.id=p.generated_by
    WHERE ${sc.where} ORDER BY p.year DESC, p.month DESC`, ...sc.params);
}));

router.get('/payroll/:id', can('hr.payroll.view'), h(async (req) => {
  const app = req.app;
  const run = await findScoped(app, req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('مسير الرواتب غير موجود');
  const items = await app.db.all(`SELECT i.*, u.name AS user_name, e.employee_no, e.job_title, e.bank_iban
    FROM payroll_items i JOIN users u ON u.id=i.user_id
    LEFT JOIN employees e ON e.user_id=i.user_id AND e.tenant_id=i.tenant_id
    WHERE i.payroll_run_id=? ORDER BY u.name`, run.id);
  return { run, items: items.map(i => ({ ...i, details: j(i.details, {}) })) };
}));

/*
 * محرّك احتساب الرواتب — مبنيٌّ على جدول دوام كلِّ موظف لا على شهرٍ نمطيّ.
 *
 * كان الغياب يُقرأ من صفوفٍ حالتُها `absent`، ولا أحد يكتبها: فمن لم يحضر شهراً
 * كاملاً خرج راتبه كاملاً. وكان التأخير يُخصم بعدد أيامه لا بدقائقه، وبمقام
 * ثابتٍ (٣٦٠ دقيقة) لا يعرف من دوامه أربع ساعات.
 *
 * فصار الاحتساب هكذا:
 *   • أيام العمل المتوقّعة  = أيام جدوله في المدى (لا ٣٠ يوماً لكل الناس)
 *   • المدى                = الشهر، مقصوصاً عند تاريخ المباشرة ونهاية العقد،
 *                            ومنتهياً عند اليوم إن كان الشهر جارياً — فلا يُحسب
 *                            غائباً عن يومٍ لم يأتِ بعد
 *   • الغياب               = المتوقّع − (ما حضره) − (إجازته المعتمدة)
 *   • خصم التأخير          = دقائق تأخّره × قيمة الدقيقة في يومه هو
 */
router.post('/payroll/generate', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const year = Number(req.body?.year) || new Date().getFullYear();
  const month = Number(req.body?.month) || (new Date().getMonth() + 1);
  const branchId = req.body?.branch_id ? await assertBranch(app, req.ctx, req.body.branch_id) : null;
  const term = await currentTerm(app, req.ctx.tenantId);
  const settings = req.ctx.tenantSettings || {};

  const pad = (n) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  /* شهرٌ لم ينتهِ بعد لا يُحاسَب على بقيّته */
  const today = localDate();
  const to = monthEnd > today && from <= today ? today : monthEnd;

  let empSql = `SELECT e.*, u.name FROM employees e JOIN users u ON u.id=e.user_id WHERE e.tenant_id=? AND e.status='active'`;
  const empParams = [req.ctx.tenantId];
  if (branchId) { empSql += ' AND e.branch_id=?'; empParams.push(branchId); }
  else if (!req.ctx.allBranches && req.ctx.branchIds.length) {
    empSql += ` AND e.branch_id IN (${req.ctx.branchIds.map(() => '?').join(',')})`;
    empParams.push(...req.ctx.branchIds);
  }
  const employees = await app.db.all(empSql, ...empParams);
  if (!employees.length) throw badRequest('لا يوجد موظفون ضمن النطاق المحدد');

  /* جداول الجميع باستعلامين لا بثلاثةٍ لكل موظف */
  const schedules = await schedulesFor(app, req.ctx.tenantId,
    employees.map(e => ({ user_id: e.user_id, branch_id: e.branch_id })), settings);

  const runRes = await app.db.run(
    `INSERT INTO payroll_runs(tenant_id,branch_id,term_id,year,month,status,generated_by) VALUES(?,?,?,?,?,'draft',?)`,
    req.ctx.tenantId, branchId, term?.id || null, year, month, req.ctx.userId);
  const runId = runRes.lastId;

  const INSERT_ITEM = `INSERT INTO payroll_items(tenant_id,payroll_run_id,user_id,basic,allowances,absence_deduction,late_deduction,advance_deduction,other_deduction,net,details)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`;
  const stmts = [];
  let total = 0;

  for (const e of employees) {
    const sc = schedules.get(e.user_id);
    /* المدى الفعليّ لهذا الموظف: بعد مباشرته، وقبل نهاية عقده */
    const start = e.hire_date && e.hire_date > from ? e.hire_date : from;
    const finish = e.contract_end && e.contract_end < to ? e.contract_end : to;
    const expectedDays = finish >= start ? workingDaysBetween(sc, start, finish) : [];
    const expected = expectedDays.length;
    /*
     * قيمة اليوم تُقسم على أيام الشهر كلِّها لا على ما مضى منه: الراتب شهريّ،
     * فمن غاب أوّلَ يومٍ في الشهر يُخصم منه يومٌ واحدٌ لا الراتبُ كلُّه.
     */
    const monthFinish = e.contract_end && e.contract_end < monthEnd ? e.contract_end : monthEnd;
    const expectedMonth = monthFinish >= start ? countWorkingDays(sc, start, monthFinish) : 0;

    /* عمود الدقائق مستجدّ — وقبل الترحيلة يُبنى المسير بلا خصم تأخيرٍ لا بخطأ */
    const att = await app.db.all(
      `SELECT date, status, COALESCE(late_minutes,0) AS late_minutes, minutes_worked FROM attendance
       WHERE tenant_id=? AND user_id=? AND date BETWEEN ? AND ?`,
      req.ctx.tenantId, e.user_id, start, finish).catch(async (err) => {
      if (!isMissingSchema(err)) throw err;
      return (await app.db.all(
        `SELECT date, status, minutes_worked FROM attendance
         WHERE tenant_id=? AND user_id=? AND date BETWEEN ? AND ?`,
        req.ctx.tenantId, e.user_id, start, finish)).map(r => ({ ...r, late_minutes: 0 }));
    });
    const workingSet = new Set(expectedDays);
    const attended = new Set();
    let lateDays = 0, lateMin = 0, workedMinutes = 0, offDays = 0;
    for (const a of att) {
      workedMinutes += a.minutes_worked || 0;
      if (['present', 'late'].includes(a.status)) {
        if (workingSet.has(a.date)) attended.add(a.date); else offDays++;
      }
      if (a.status === 'late') { lateDays++; lateMin += a.late_minutes || 0; }
    }

    /* الإجازة المعتمدة تُسقط اليوم من الغياب — والعبرة بأيام جدوله لا بأيام الطلب */
    const leaves = await app.db.all(
      `SELECT start_date, end_date FROM leaves
       WHERE tenant_id=? AND user_id=? AND status='approved' AND start_date<=? AND end_date>=?`,
      req.ctx.tenantId, e.user_id, finish, start);
    const onLeave = new Set();
    for (const l of leaves) {
      for (const d of expectedDays) if (d >= l.start_date && d <= l.end_date) onLeave.add(d);
    }
    const leaveDays = [...onLeave].filter(d => !attended.has(d)).length;
    const absent = Math.max(0, expected - attended.size - leaveDays);

    /* قيمة اليوم والدقيقة من جدوله هو: من دوامه أربع ساعاتٍ لا يُقاس بستّ */
    const gross = e.basic_salary + e.allowances;
    const daily = expectedMonth ? gross / expectedMonth : gross / 30;
    const dayMinutes = dailyMinutes(sc.days) || 360;
    const perMinute = daily / dayMinutes;

    /*
     * الخصومات لا تتجاوز المستحقّ: راتبٌ سالبٌ دَينٌ على الموظف لا مسيرُ رواتب.
     * والسلفة تُخصم مما بقي بعد الغياب والتأخير، وما لم يُخصم يبقى في ذمّتها
     * للشهر القادم — فلا يُنقص الرصيدُ بما لم يُقتطع فعلاً.
     */
    const round2 = (n) => Number(Math.max(0, n).toFixed(2));
    const rawAbsence = absent * daily * (settings.absence_deduction_per_day ?? 1);
    const rawLate = lateMin * perMinute;
    const absenceDeduction = round2(Math.min(rawAbsence, gross));
    const lateDeduction = round2(Math.min(rawLate, gross - absenceDeduction));

    const adv = await app.db.all(
      `SELECT id, remaining, installments FROM advances WHERE tenant_id=? AND user_id=? AND status='approved' AND remaining>0`,
      req.ctx.tenantId, e.user_id);
    let advanceDeduction = 0;
    let room = Math.max(0, gross - absenceDeduction - lateDeduction);
    for (const a of adv) {
      if (room <= 0) break;
      const cut = Number(Math.min(a.remaining, a.remaining / Math.max(1, a.installments), room).toFixed(2));
      if (cut <= 0) continue;
      advanceDeduction += cut; room -= cut;
      stmts.push(['UPDATE advances SET remaining=remaining-? WHERE id=?', [cut, a.id]]);
    }
    advanceDeduction = Number(advanceDeduction.toFixed(2));

    const net = Number((gross - absenceDeduction - lateDeduction - advanceDeduction).toFixed(2));
    total += net;
    stmts.push([INSERT_ITEM, [req.ctx.tenantId, runId, e.user_id, e.basic_salary, e.allowances,
      absenceDeduction, lateDeduction, advanceDeduction, 0, net,
      JSON.stringify({
        present: attended.size, late: lateDays, absent, leave: leaveDays,
        expected_days: expected, expected_month_days: expectedMonth, off_day_attendance: offDays,
        late_minutes: lateMin, worked_minutes: workedMinutes,
        period: { from: start, to: finish },
        schedule: { source: sc.source, summary: describeSchedule(sc), daily_minutes: dayMinutes },
        daily_rate: Number(daily.toFixed(2))
      })]]);
  }
  stmts.push(['UPDATE payroll_runs SET total=? WHERE id=?', [Number(total.toFixed(2)), runId]]);
  await app.db.batch(stmts);

  await audit(req, { action: 'create', entity: 'payroll_run', entityId: runId,
    summary: `${req.ctx.userName} أنشأ مسير رواتب ${month}/${year} لعدد ${employees.length} موظف بإجمالي ${total.toFixed(2)} ر.س` });
  return created({ runId, total: Number(total.toFixed(2)), count: employees.length });
}));

router.post('/payroll/:id/approve', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const run = await findScoped(app, req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('المسير غير موجود');
  const st = req.body?.status === 'paid' ? 'paid' : 'approved';
  await app.db.run('UPDATE payroll_runs SET status=? WHERE id=? AND tenant_id=?', st, run.id, req.ctx.tenantId);
  await audit(req, { action: 'approve', entity: 'payroll_run', entityId: run.id,
    summary: `اعتماد مسير رواتب ${run.month}/${run.year} بحالة ${st}` });
  if (st === 'paid') {
    const users = await app.db.all('SELECT user_id, net FROM payroll_items WHERE payroll_run_id=?', run.id);
    for (const u of users) {
      await notifyUsers(app, req.ctx.tenantId, [u.user_id], {
        type: 'payroll.paid', category: 'hr', title: 'تم صرف راتب الشهر',
        body: `صافي راتب ${run.month}/${run.year}: ${u.net.toLocaleString('ar-SA')} ر.س`, url: '/hr'
      });
    }
  }
  return { ok: true, status: st };
}));

export default router;
