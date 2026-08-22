import { admin, saveAdminTokens, clearAdminSession } from './admin-state.js';
import { toast } from './util.js';
import { ApiError } from './api.js';

/**
 * عميل لوحة المنصة — يحمل رمز الادمن ويجدّده من مساره المستقل.
 *
 * منفصل عن `api.js` عمداً لا تكراراً له: خلطهما يعني تمرير علَم «أي جلسة؟»
 * في كل نداء، وأول موضع يُنسى فيه العلَم يرسل رمز الطبقة الخطأ. الفصل هنا
 * يجعل الخطأ مستحيلاً بدل أن يجعله نادراً.
 */
const BASE = '';
let refreshing = null;

function headers(extra = {}, isForm = false) {
  const h = { ...extra };
  if (!isForm) h['content-type'] = 'application/json';
  if (admin.accessToken) h.authorization = `Bearer ${admin.accessToken}`;
  return h;
}

async function doRefresh() {
  if (!admin.refreshToken) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(BASE + '/api/admin/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: admin.refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      saveAdminTokens(data.accessToken);
      admin.session = data;
      return true;
    } catch { return false; }
    finally { setTimeout(() => { refreshing = null; }, 50); }
  })();
  return refreshing;
}

let leaving = false;
if (typeof window !== 'undefined') {
  const mark = () => { leaving = true; };
  window.addEventListener('pagehide', mark);
  window.addEventListener('beforeunload', mark);
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
    const aborted = leaving || e?.name === 'AbortError'
      || /aborted|cancell?ed/i.test(String(e?.message || ''));
    if (!silent && !aborted) toast('تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت', 'err');
    throw new ApiError(aborted ? 'aborted' : 'offline', 0, aborted ? 'ABORTED' : 'OFFLINE');
  }

  if (res.status === 401 && retry && admin.refreshToken) {
    if (await doRefresh()) return request(method, url, { body, raw, retry: false, silent });
    clearAdminSession();
    window.dispatchEvent(new CustomEvent('raqeem:admin-signout'));
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
    if (!silent) toast(message, 'err');
    throw new ApiError(message, res.status, err.code, err.details);
  }
  return data;
}

export const adminApi = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, body, opts) => request('POST', url, { ...opts, body }),
  patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
  put: (url, body, opts) => request('PUT', url, { ...opts, body }),
  del: (url, opts) => request('DELETE', url, opts),

  async login(email, password, totp) {
    const data = await request('POST', '/api/admin/auth/login', {
      body: { email, password, ...(totp ? { totp } : {}) }, retry: false, silent: true });
    saveAdminTokens(data.accessToken, data.refreshToken);
    admin.session = data;
    return data;
  },
  async me() {
    const data = await request('GET', '/api/admin/auth/me');
    admin.session = data;
    return data;
  },
  async logout() {
    try {
      await request('POST', '/api/admin/auth/logout',
        { body: { refreshToken: admin.refreshToken }, silent: true });
    } catch { /* الخروج محلياً يتم على كل حال */ }
    clearAdminSession();
  },

  async downloadGet(url, filename) {
    const { blob, res } = await request('GET', url, { raw: true });
    const disp = res.headers.get('content-disposition') || '';
    const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
    const name = filename || (m ? decodeURIComponent(m[1]) : 'raqeem-file');
    const { download } = await import('./util.js');
    download(blob, name);
  },

  qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  }
};

export default adminApi;
