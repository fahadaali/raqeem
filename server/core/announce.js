import { nowUTC, j } from './sql.js';
import { badRequest } from './errors.js';
import { notifyUsers } from './notify.js';

/**
 * إعلانات المنصة والبثّ (المستوى ٢).
 *
 * لم تكن هناك وسيلة يخاطب بها مالك المنصة مشتركيه: صيانة مجدولة، ميزة جديدة،
 * تغيير في الأسعار. بنية الإشعارات الثلاثية جاهزة، وينقصها التوزيع عبر الجهات.
 *
 * الجمهور قابل للتقسيم: الكل · خطة بعينها · حالة اشتراك · جهة واحدة.
 * والإعلان قد يكون شريطاً ثابتاً في واجهة الجهات إضافةً إلى الإشعار.
 */

export const AUDIENCES = ['all', 'plan', 'status', 'tenant'];
export const SEVERITY_AR = { info: 'معلومة', warn: 'تنبيه', critical: 'حرج' };
export const AUDIENCE_AR = { all: 'كل الجهات', plan: 'خطة محددة', status: 'حالة اشتراك', tenant: 'جهة واحدة' };

/** يحلّ الجمهور إلى قائمة معرّفات جهات */
export async function resolveAudience(app, { audience = 'all', value = null } = {}) {
  if (audience === 'tenant') {
    const t = await app.db.get(`SELECT id FROM tenants WHERE id=? OR code=?`, Number(value) || 0, String(value || ''));
    return t ? [t.id] : [];
  }
  if (audience === 'plan') {
    return (await app.db.all(
      `SELECT s.tenant_id AS id FROM subscriptions s JOIN plans p ON p.id=s.plan_id
       JOIN tenants t ON t.id=s.tenant_id WHERE p.code=? AND t.status='active'`, String(value || '')))
      .map(r => r.id);
  }
  if (audience === 'status') {
    return (await app.db.all(
      `SELECT s.tenant_id AS id FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
       WHERE s.status=? AND t.status='active'`, String(value || ''))).map(r => r.id);
  }
  return (await app.db.all(`SELECT id FROM tenants WHERE status='active'`)).map(r => r.id);
}

/**
 * ينشئ إعلاناً ويبثّه.
 * البث اختياري: إعلان بشريط فقط لا يُزعج أحداً بإشعار.
 */
export async function createAnnouncement(app, {
  title, body = null, url = null, severity = 'info', audience = 'all', audienceValue = null,
  banner = false, push = true, startsAt = null, endsAt = null, send = true,
  createdBy = null, createdByName = null
} = {}) {
  if (!String(title || '').trim()) throw badRequest('عنوان الإعلان إلزامي');
  if (!AUDIENCES.includes(audience)) throw badRequest('جمهور غير مدعوم');
  if (audience !== 'all' && !audienceValue) throw badRequest('حدّد قيمة الجمهور (خطة أو حالة أو جهة)');

  const tenants = await resolveAudience(app, { audience, value: audienceValue });

  const r = await app.db.run(
    `INSERT INTO announcements(title,body,url,severity,audience,audience_value,banner,push,
       starts_at,ends_at,tenants_count,created_by,created_by_name)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    String(title).trim(), body, url, severity, audience, audienceValue,
    banner ? 1 : 0, push ? 1 : 0, startsAt || nowUTC(), endsAt,
    tenants.length, createdBy, createdByName);

  let recipients = 0;
  if (send && tenants.length) {
    for (const tenantId of tenants) {
      const users = (await app.db.all(
        `SELECT id FROM users WHERE tenant_id=? AND status='active'`, tenantId)).map(u => u.id);
      if (!users.length) continue;
      const out = await notifyUsers(app, tenantId, users, {
        type: 'platform.announcement', category: 'system',
        title: String(title).trim(), body: body || '', url: url || '/',
        urgency: severity === 'critical' ? 'high' : 'normal',
        silent: !push,
        data: { announcement_id: r.lastId, severity }
      }).catch(() => ({ created: 0 }));
      recipients += out.created || 0;
    }
    await app.db.run('UPDATE announcements SET sent_at=?, recipients=? WHERE id=?',
      nowUTC(), recipients, r.lastId);
  }

  return { ...(await app.db.get('SELECT * FROM announcements WHERE id=?', r.lastId)), recipients, tenants: tenants.length };
}

/** الإعلانات النشطة التي تخصّ جهة معيّنة — تقرأها واجهة الجهة كشريط */
export async function activeBanners(app, { tenantId, planCode = null, subStatus = null } = {}) {
  const now = nowUTC();
  const rows = await app.db.all(
    `SELECT id,title,body,url,severity,audience,audience_value,starts_at,ends_at
     FROM announcements
     WHERE banner=1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
     ORDER BY id DESC LIMIT 5`, now, now);

  return rows.filter(a => {
    if (a.audience === 'all') return true;
    if (a.audience === 'plan') return planCode && a.audience_value === planCode;
    if (a.audience === 'status') return subStatus && a.audience_value === subStatus;
    if (a.audience === 'tenant') return String(a.audience_value) === String(tenantId);
    return false;
  });
}

export async function listAnnouncements(app, { limit = 100 } = {}) {
  return app.db.all('SELECT * FROM announcements ORDER BY id DESC LIMIT ?', Math.min(300, limit));
}

export async function deleteAnnouncement(app, id) {
  await app.db.run('DELETE FROM announcements WHERE id=?', id);
  return { ok: true };
}
