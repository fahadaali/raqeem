/**
 * جلسة لوحة المنصة — منفصلة تماماً عن جلسة المجمّعات.
 *
 * مفاتيح تخزين مستقلة (`raqeem_admin_*`) فتتعايش الجلستان في المتصفّح نفسه:
 * يبقى مدير المجمّع داخلاً في تبويب، والادمن داخلاً في آخر، ولا يُخرج أحدهما
 * الآخر — وهو ما يحتاجه من يشغّل المنصة ويشرف على مجمّع فيها في آن.
 */
export const admin = {
  accessToken: localStorage.getItem('raqeem_admin_at') || null,
  refreshToken: localStorage.getItem('raqeem_admin_rt') || null,
  session: null,
  route: { path: '/admin', query: {} }
};

export function saveAdminTokens(access, refresh) {
  admin.accessToken = access || null;
  if (access) localStorage.setItem('raqeem_admin_at', access);
  else localStorage.removeItem('raqeem_admin_at');

  if (refresh !== undefined) {
    admin.refreshToken = refresh || null;
    if (refresh) localStorage.setItem('raqeem_admin_rt', refresh);
    else localStorage.removeItem('raqeem_admin_rt');
  }
}

export function clearAdminSession() {
  saveAdminTokens(null, null);
  admin.session = null;
}
