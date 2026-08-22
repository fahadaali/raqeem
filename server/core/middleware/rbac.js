import { forbidden } from '../errors.js';

/** يشترط امتلاك صلاحية واحدة على الأقل من القائمة */
export const can = (...keys) => async (c, next) => {
  const perms = c.get('ctx')?.perms || [];
  if (keys.some(k => perms.includes(k))) return next();
  throw forbidden(`تحتاج صلاحية: ${keys.join(' أو ')}`);
};

/** يشترط امتلاك جميع الصلاحيات */
export const canAll = (...keys) => async (c, next) => {
  const perms = c.get('ctx')?.perms || [];
  if (keys.every(k => perms.includes(k))) return next();
  throw forbidden(`تحتاج الصلاحيات: ${keys.join('، ')}`);
};

export const has = (ctx, key) => (ctx?.perms || []).includes(key);
