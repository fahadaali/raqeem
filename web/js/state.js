/** مخزن الحالة العام للتطبيق */
const listeners = new Set();

export const state = {
  session: null,          // { user, tenant, permissions, branches, terms, current_term, push }
  accessToken: localStorage.getItem('noor_at') || null,
  refreshToken: localStorage.getItem('noor_rt') || null,
  branchId: localStorage.getItem('noor_branch') || 'all',
  termId: localStorage.getItem('noor_term') || '',
  calendar: localStorage.getItem('noor_cal') || 'hijri',
  theme: localStorage.getItem('noor_theme') || 'auto',
  route: { path: '/', query: {} },
  notifications: { items: [], unread: 0 },
  online: navigator.onLine
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
}
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function saveTokens(access, refresh) {
  state.accessToken = access || null;
  if (access) localStorage.setItem('noor_at', access); else localStorage.removeItem('noor_at');
  if (refresh !== undefined) {
    state.refreshToken = refresh || null;
    if (refresh) localStorage.setItem('noor_rt', refresh); else localStorage.removeItem('noor_rt');
  }
}
export function clearSession() {
  saveTokens(null, null);
  state.session = null;
  state.notifications = { items: [], unread: 0 };
}
export const setPref = (key, value) => {
  state[key] = value;
  localStorage.setItem('noor_' + ({ branchId: 'branch', termId: 'term', calendar: 'cal', theme: 'theme' }[key] || key), value);
};

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
