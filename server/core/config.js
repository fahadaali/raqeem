/**
 * إعدادات التشغيل — تُبنى من كائن البيئة الممرَّر، لا من متغيرات عامة،
 * لأن Cloudflare Workers تمرّر البيئة مع كل طلب ولا تسمح بقراءتها عند التحميل.
 */
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export function buildConfig(env = {}) {
  return {
    env: env.NODE_ENV || 'production',
    appUrl: env.APP_URL || '',
    port: num(env.PORT, 3000),

    jwtSecret: env.JWT_SECRET || 'raqeem-dev-secret-change-me',
    jwtExpires: env.JWT_EXPIRES || '12h',
    refreshDays: num(env.REFRESH_EXPIRES_DAYS, 30),

    dbFile: env.DB_FILE || './data/raqeem.db',
    storageRoot: env.STORAGE_ROOT || './storage',

    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:admin@example.com'
    },

    backup: {
      enabled: bool(env.BACKUP_ENABLED, true),
      hour: num(env.BACKUP_CRON_HOUR, 2),
      keep: num(env.BACKUP_KEEP, 14),
      dir: env.BACKUP_DIR || './data/backups'
    },

    rateLimit: {
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: num(env.RATE_LIMIT_MAX, 300),
      publicMax: num(env.PUBLIC_API_RATE_LIMIT_MAX, 120),
      loginIpMax: num(env.LOGIN_IP_MAX, 120),
      loginAccountMax: num(env.LOGIN_ACCOUNT_MAX, 8)
    },

    /*
     * الخريطة: مفتاح خرائط قوقل سرٌّ يبقى على الخادم — الوسيط في
     * routes/map.js يجلب المربّعات به. وبلا مفتاحٍ تعمل الخريطة على
     * الطبقة المفتوحة، فلا تتعطّل شاشة التحضير لغياب اشتراك.
     */
    maps: {
      googleKey: env.GOOGLE_MAPS_API_KEY || ''
    },

    geofenceDefault: num(env.GEOFENCE_DEFAULT_RADIUS, 50),
    uploadMaxMb: num(env.UPLOAD_MAX_MB, 15),
    trustProxy: bool(env.TRUST_PROXY, true)
  };
}
export default buildConfig;
