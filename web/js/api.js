import { state, saveTokens, clearSession, activeBranch, activeTerm } from './state.js';
import { toast } from './util.js';

const BASE = '';
let refreshing = null;

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export { ApiError };

function headers(extra = {}, isForm = false) {
  const h = { ...extra };
  if (!isForm) h['content-type'] = 'application/json';
  if (state.accessToken) h.authorization = `Bearer ${state.accessToken}`;
  const b = activeBranch(); if (b) h['x-branch-id'] = String(b);
  const t = activeTerm(); if (t) h['x-term-id'] = String(t);
  return h;
}

async function doRefresh() {
  if (!state.refreshToken) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(BASE + '/api/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      saveTokens(data.accessToken);
      state.session = data;
      return true;
    } catch { return false; }
    finally { setTimeout(() => { refreshing = null; }, 50); }
  })();
  return refreshing;
}

async function request(method, url, { body, raw, retry = true, silent = false } = {}) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(BASE + url, {
      method, headers: headers({}, isForm),
      body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined)
    });
  } catch (e) {
    /* طلب أُلغي لأن المستخدم انتقل لشاشة أخرى ليس انقطاعاً في الشبكة */
    const aborted = e?.name === 'AbortError' || /aborted|cancell?ed/i.test(String(e?.message || ''));
    if (!silent && !aborted) toast('تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت', 'err');
    throw new ApiError(aborted ? 'aborted' : 'offline', 0, aborted ? 'ABORTED' : 'OFFLINE');
  }

  if (res.status === 401 && retry && state.refreshToken) {
    if (await doRefresh()) return request(method, url, { body, raw, retry: false, silent });
    clearSession();
    window.dispatchEvent(new CustomEvent('noor:signout'));
    throw new ApiError('انتهت الجلسة', 401, 'UNAUTHORIZED');
  }

  if (raw) {
    if (!res.ok) throw new ApiError('فشل تنزيل الملف', res.status, 'DOWNLOAD_FAILED');
    return { blob: await res.blob(), res };
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    const err = data?.error || {};
    const message = err.message || 'حدث خطأ غير متوقع';
    if (!silent) toast(message, res.status === 423 ? 'warn' : 'err');
    throw new ApiError(message, res.status, err.code, err.details);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, body, opts) => request('POST', url, { ...opts, body }),
  patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
  put: (url, body, opts) => request('PUT', url, { ...opts, body }),
  del: (url, opts) => request('DELETE', url, opts),

  async login(email, password) {
    const data = await request('POST', '/api/auth/login', { body: { email, password }, retry: false });
    saveTokens(data.accessToken, data.refreshToken);
    state.session = data;
    return data;
  },
  async me() {
    const data = await request('GET', '/api/auth/me');
    state.session = data;
    return data;
  },
  async logout() {
    try { await request('POST', '/api/auth/logout', { body: { refreshToken: state.refreshToken }, silent: true }); } catch {}
    clearSession();
  },
  /** تنزيل ملف (Excel / CSV) */
  async download(url, body, filename) {
    const { blob, res } = await request('POST', url, { body, raw: true });
    const disp = res.headers.get('content-disposition') || '';
    const m = disp.match(/filename\*=UTF-8''([^;]+)/);
    const name = filename || (m ? decodeURIComponent(m[1]) : 'noor-export');
    const { download } = await import('./util.js');
    download(blob, name);
  },
  /** تنزيل ملف عبر GET (مع ترويسة المصادقة) */
  async downloadGet(url, filename) {
    const { blob, res } = await request('GET', url, { raw: true });
    const disp = res.headers.get('content-disposition') || '';
    const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
    const name = filename || (m ? decodeURIComponent(m[1]) : 'noor-file');
    const { download } = await import('./util.js');
    download(blob, name);
  },
  /** فتح مستند طباعة رسمي في تبويب جديد */
  async openPrint(url, body) {
    const { blob } = await request('POST', url, { body, raw: true });
    const objUrl = URL.createObjectURL(new Blob([blob], { type: 'text/html;charset=utf-8' }));
    const w = window.open(objUrl, '_blank');
    if (!w) toast('يرجى السماح بالنوافذ المنبثقة لعرض التقرير', 'warn');
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  },
  /** فتح مستند طباعة عبر GET */
  async openPrintGet(url) {
    const { blob } = await request('GET', url, { raw: true });
    const objUrl = URL.createObjectURL(new Blob([blob], { type: 'text/html;charset=utf-8' }));
    const w = window.open(objUrl, '_blank');
    if (!w) toast('يرجى السماح بالنوافذ المنبثقة لعرض المستند', 'warn');
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  },
  qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  }
};
export default api;
