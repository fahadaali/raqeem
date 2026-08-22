import { forbidden } from '../lib/errors.js';

/** يشترط امتلاك صلاحية واحدة على الأقل من القائمة */
export const can = (...keys) => (req, res, next) => {
  const perms = req.ctx?.perms || [];
  if (keys.some(k => perms.includes(k))) return next();
  next(forbidden(`تحتاج صلاحية: ${keys.join(' أو ')}`));
};

/** يشترط امتلاك جميع الصلاحيات */
export const canAll = (...keys) => (req, res, next) => {
  const perms = req.ctx?.perms || [];
  if (keys.every(k => perms.includes(k))) return next();
  next(forbidden(`تحتاج الصلاحيات: ${keys.join('، ')}`));
};

export const has = (ctx, key) => (ctx?.perms || []).includes(key);
