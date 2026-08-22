/**
 * يولّد ترحيل Cloudflare D1 من المصدر الوحيد للمخطط (server/core/schema.sql)
 * حتى لا يحدث انحراف بين قاعدة بيانات التشغيل الذاتي وقاعدة D1.
 *   npm run cf:build:migrations
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitStatements } from '../server/core/sql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = path.join(ROOT, 'server/core/schema.sql');
const OUT_DIR = path.join(ROOT, 'migrations');
const OUT = path.join(OUT_DIR, '0001_init.sql');

const source = fs.readFileSync(SCHEMA, 'utf8');
const statements = splitStatements(source);

const header = [
  '-- ════════════════════════════════════════════════════════════════',
  '--  منصة رقيم — مخطط قاعدة البيانات على Cloudflare D1',
  '--  ⚠ مولَّد آلياً من server/core/schema.sql — لا تُعدّله يدوياً.',
  '--    أعد توليده بـ:  npm run cf:build:migrations',
  '-- ════════════════════════════════════════════════════════════════',
  ''
].join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, header + statements.map(s => (s.endsWith(';') ? s : s + ';')).join('\n\n') + '\n', 'utf8');

const tables = statements.filter(s => /^CREATE TABLE/i.test(s)).length;
const indexes = statements.filter(s => /^CREATE (UNIQUE )?INDEX/i.test(s)).length;
const triggers = statements.filter(s => /^CREATE TRIGGER/i.test(s)).length;

console.log(`✔ ${path.relative(ROOT, OUT)}`);
console.log(`  ${statements.length} جملة  ·  ${tables} جدول  ·  ${indexes} فهرس  ·  ${triggers} مُشغّل`);
