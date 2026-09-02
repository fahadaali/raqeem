/** مخزن الحالة العام للتطبيق */
const listeners = new Set();

export const state = {
  session: null,          // { user, tenant, permissions, branches, terms, current_term, push }
  accessToken: localStorage.getItem('raqeem_at') || null,
  refreshToken: localStorage.getItem('raqeem_rt') || null,
  branchId: localStorage.getItem('raqeem_branch') || 'all',
  termId: localStorage.getItem('raqeem_term') || '',
  calendar: localStorage.getItem('raqeem_cal') || 'hijri',
  theme: localStorage.getItem('raqeem_theme') || 'auto',
  route: { path: '/', query: {} },
  notifications: { items: [], unread: 0 },
  chat: { unread: 0 },          // خيوط محادثةٍ فيها جديدٌ لم يُقرأ
  online: navigator.onLine
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
}
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function saveTokens(access, refresh) {
  state.accessToken = access || null;
  if (access) localStorage.setItem('raqeem_at', access); else localStorage.removeItem('raqeem_at');
  if (refresh !== undefined) {
    state.refreshToken = refresh || null;
    if (refresh) localStorage.setItem('raqeem_rt', refresh); else localStorage.removeItem('raqeem_rt');
  }
}
export function clearSession() {
  saveTokens(null, null);
  state.session = null;
  state.notifications = { items: [], unread: 0 };
  state.chat = { unread: 0 };
}
export const setPref = (key, value) => {
  state[key] = value;
  localStorage.setItem('raqeem_' + ({ branchId: 'branch', termId: 'term', calendar: 'cal', theme: 'theme' }[key] || key), value);
};

/**
 * تطبيق السمة على الجذر.
 *
 * هنا لا في `app.js`: الصفحة العامة تحمل مفتاح المظهر أيضاً، ولو بقي في هيكل
 * التطبيق لاحتاجت الصفحةُ أن تستورد الهيكلَ الذي يستوردها — دورةٌ لا داعي لها.
 */
export function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  /* لونا الهوية: أخضر سنا فاتحاً، والغامق في الوضع الداكن */
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#1C5E4C' : '#2F8A6F');
}

/** التحقق من صلاحية — يقود إظهار/إخفاء عناصر الواجهة المرنة */
export const can = (...keys) => {
  const p = state.session?.permissions || [];
  return keys.some(k => p.includes(k));
};
export const isRole = (...keys) => keys.includes(state.session?.user?.role?.key);
export const activeBranch = () => state.branchId === 'all' ? null : Number(state.branchId);
export const activeTerm = () => state.termId ? Number(state.termId) : (state.session?.current_term?.id || null);
export const currentTermObj = () => (state.session?.terms || []).find(t => t.id === activeTerm()) || state.session?.current_term || null;
export const termIsArchived = () => ['closed', 'archived'].includes(currentTermObj()?.status);
