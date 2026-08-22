import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// تحميل ملف .env يدوياً (دون تبعيات خارجية)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || `http://localhost:${num(process.env.PORT, 3000)}`,

  jwtSecret: process.env.JWT_SECRET || 'noor-dev-secret-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  refreshDays: num(process.env.REFRESH_EXPIRES_DAYS, 30),

  dbFile: path.resolve(ROOT, process.env.DB_FILE || './data/noor.db'),

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    root: path.resolve(ROOT, process.env.STORAGE_ROOT || './storage'),
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || '',
      accessKey: process.env.S3_ACCESS_KEY || '',
      secretKey: process.env.S3_SECRET_KEY || '',
      endpoint: process.env.S3_ENDPOINT || ''
    }
  },

  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
  },

  backup: {
    enabled: bool(process.env.BACKUP_ENABLED, true),
    hour: num(process.env.BACKUP_CRON_HOUR, 2),
    keep: num(process.env.BACKUP_KEEP, 14),
    dir: path.resolve(ROOT, './data/backups')
  },

  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: num(process.env.RATE_LIMIT_MAX, 300),
    publicMax: num(process.env.PUBLIC_API_RATE_LIMIT_MAX, 120)
  },

  geofenceDefault: num(process.env.GEOFENCE_DEFAULT_RADIUS, 50),
  uploadMaxMb: num(process.env.UPLOAD_MAX_MB, 15)
};

export default config;
