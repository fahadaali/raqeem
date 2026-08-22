export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', details = null) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
export const badRequest = (m = 'طلب غير صالح', d) => new AppError(m, 400, 'BAD_REQUEST', d);
export const unauthorized = (m = 'الجلسة غير صالحة، يرجى تسجيل الدخول') => new AppError(m, 401, 'UNAUTHORIZED');
export const forbidden = (m = 'ليست لديك صلاحية لهذا الإجراء') => new AppError(m, 403, 'FORBIDDEN');
export const notFound = (m = 'العنصر غير موجود') => new AppError(m, 404, 'NOT_FOUND');
export const conflict = (m = 'تعارض في البيانات') => new AppError(m, 409, 'CONFLICT');
export const locked = (m = 'هذا الفصل مؤرشف ومغلق للقراءة فقط') => new AppError(m, 423, 'TERM_CLOSED');
export const tooMany = (m = 'تجاوزت الحد المسموح من الطلبات، حاول لاحقاً') => new AppError(m, 429, 'RATE_LIMITED');

/** تغليف معالجات async */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
