// Deptor sinxronlash bazasining zaxira nusxalari.
//  1) Kunlik mahalliy nusxa: <DATA_DIR>/backups/deptor_sync-YYYY-MM-DD.db (oxirgi 14 tasi).
//  2) Tashqi nusxa: siqilgan + shifrlangan fayl Telegram'dagi shaxsiy chatga yuboriladi
//     (DP_BACKUP_CHAT_ID va DP_BACKUP_KEY o'rnatilgan bo'lsa).
// Tiklash: scripts/dp_restore.js (qarang: src/deptor/BACKUP.md).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const KEEP = 14;
const MAX_UPLOAD = 45 * 1024 * 1024; // Telegram bot hujjat chegarasi 50 MB
const MAGIC = Buffer.from('DPB1');

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Bazaning to'liq, izchil nusxasini oladi va butunligini tekshiradi. Yo'lni qaytaradi. */
function localBackup(db, dir, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `deptor_sync-${dayStamp(now)}.db`);
  if (fs.existsSync(file)) return { file, created: false };
  const tmp = file + '.tmp';
  try { fs.unlinkSync(tmp); } catch {}
  db.prepare('VACUUM INTO ?').run(tmp);
  const chk = new Database(tmp, { readonly: true });
  try {
    const r = chk.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new Error('integrity_check: ' + r);
  } finally {
    chk.close();
  }
  fs.renameSync(tmp, file);
  prune(dir, KEEP);
  return { file, created: true };
}

function prune(dir, keep = KEEP) {
  const files = fs.readdirSync(dir).filter((f) => /^deptor_sync-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
    try { fs.unlinkSync(path.join(dir, f + '.sent')); } catch {}
  }
}

const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest();

/** gzip + AES-256-GCM:  'DPB1' | iv(12) | tag(16) | shifrlangan ma'lumot */
function encrypt(buf, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(zlib.gzipSync(buf)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}

function decrypt(buf, secret) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad_format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  const plain = Buffer.concat([d.update(buf.subarray(32)), d.final()]); // noto'g'ri kalit bo'lsa xato beradi
  return zlib.gunzipSync(plain);
}

/**
 * Kunlik zaxirani ishga tushiradi: boshlanganda va har soatda "bugungi nusxa bormi" tekshiradi.
 * @returns {{stop: () => void, runNow: () => Promise<object>}}
 */
function start({ db, dir, getBot, chatId, secret, log = console.log, intervalMs = 60 * 60 * 1000, firstDelayMs = 2 * 60 * 1000 }) {
  let running = false;

  async function runNow() {
    if (running) return { skipped: 'running' };
    running = true;
    try {
      const r = localBackup(db, dir);
      let sent = false;
      const bot = getBot && getBot();
      // Yuborilmagan bo'lsa (masalan tarmoq xatosi) keyingi soatda qayta uriniladi.
      const marker = r.file + '.sent';
      if (bot && chatId && secret && !fs.existsSync(marker)) {
        const raw = fs.readFileSync(r.file);
        const payload = encrypt(raw, secret);
        if (payload.length > MAX_UPLOAD) {
          log(`[DP] zaxira tashqi yuborilmadi: fayl katta (${payload.length} bayt)`);
        } else {
          await bot.sendDocument(chatId, payload,
            { caption: `Deptor zaxira ${path.basename(r.file)} (shifrlangan)` },
            { filename: path.basename(r.file) + '.enc', contentType: 'application/octet-stream' });
          fs.writeFileSync(marker, new Date().toISOString());
          sent = true;
        }
      }
      if (r.created || sent) log(`💾 [DP] zaxira olindi: ${path.basename(r.file)}${sent ? ' + Telegram' : ''}`);
      return { ...r, sent };
    } catch (e) {
      log('[DP] zaxira xatosi:', e.message);
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  const first = setTimeout(runNow, firstDelayMs);
  const timer = setInterval(runNow, intervalMs);
  first.unref();
  timer.unref();
  return { runNow, stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { localBackup, prune, encrypt, decrypt, start, dayStamp };
