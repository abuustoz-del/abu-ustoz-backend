// Deptor zaxira testlari:  node --test test/deptor_backup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { create } = require('../src/deptor/sync');
const backup = require('../src/deptor/backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dpb-'));
const EGA = '+998901111111';

function seeded() {
  const dir = tmp();
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 's', testMode: true });
  dp._test.upsertUser(EGA, 1, 'Ega');
  const ins = dp.db.prepare(`INSERT INTO debts(ref, creator, creator_name, counter_name, counter, dir, kind, amount, currency, note, date, closed, status, deleted, rev)
    VALUES (?,?,?,?,?,?, 'debt', ?, 'UZS', '', 1, 0,'confirmed',0,?)`);
  for (let i = 0; i < 50; i++) ins.run('REF' + String(i).padStart(5, '0'), EGA, 'Ega', 'Ali', '+998932222222', 'gave', 1000 + i, i + 1);
  return { dir, dp };
}

test('zaxira nusxa butun va ma\'lumotlar bir xil; ikkinchi chaqiruv shu kunga qayta yozmaydi', () => {
  const { dir, dp } = seeded();
  const r = backup.localBackup(dp.db, path.join(dir, 'backups'));
  assert.equal(r.created, true);
  const copy = new Database(r.file, { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM debts').get().n, 50);
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();
  assert.equal(backup.localBackup(dp.db, path.join(dir, 'backups')).created, false);
  dp.close();
});

test('faqat oxirgi 14 ta nusxa saqlanadi', () => {
  const { dir, dp } = seeded();
  const bdir = path.join(dir, 'backups');
  for (let i = 1; i <= 20; i++) {
    backup.localBackup(dp.db, bdir, new Date(Date.UTC(2026, 0, i, 12)));
  }
  const left = fs.readdirSync(bdir).sort();
  assert.equal(left.length, 14);
  assert.equal(left[0], 'deptor_sync-2026-01-07.db');
  assert.equal(left[13], 'deptor_sync-2026-01-20.db');
  dp.close();
});

test('shifrlash: to\'g\'ri kalit bilan ochiladi, noto\'g\'ri kalit yoki buzilgan fayl ochilmaydi', () => {
  const data = Buffer.from('maxfiy qarz ma\'lumotlari '.repeat(100));
  const enc = backup.encrypt(data, 'kalit-1');
  assert.ok(!enc.includes(Buffer.from('maxfiy')));
  assert.deepEqual(backup.decrypt(enc, 'kalit-1'), data);
  assert.throws(() => backup.decrypt(enc, 'boshqa-kalit'));
  const broken = Buffer.from(enc);
  broken[broken.length - 3] ^= 0xff;
  assert.throws(() => backup.decrypt(broken, 'kalit-1'));
  assert.throws(() => backup.decrypt(Buffer.from('notogri'), 'kalit-1'));
});

test('to\'liq oqim: Telegram\'ga shifrlangan nusxa yuboriladi va skript bilan tiklanadi', async () => {
  const { dir, dp } = seeded();
  const sent = [];
  const bot = { sendDocument: async (chat, buf, opts, file) => { sent.push({ chat, buf, opts, file }); } };
  const job = backup.start({
    db: dp.db, dir: path.join(dir, 'backups'), getBot: () => bot, chatId: '12345', secret: 'sir',
    log: () => {}, intervalMs: 3600000, firstDelayMs: 3600000,
  });
  const r = await job.runNow();
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, '12345');
  assert.match(sent[0].file.filename, /^deptor_sync-\d{4}-\d{2}-\d{2}\.db\.enc$/);

  // Xuddi shu kuni ikkinchi marta yuborilmaydi
  assert.equal((await job.runNow()).sent, false);
  assert.equal(sent.length, 1);
  job.stop();

  // Tiklash skripti
  const enc = path.join(dir, 'got.enc');
  const out = path.join(dir, 'restored.db');
  fs.writeFileSync(enc, sent[0].buf);
  execFileSync('node', [path.join(__dirname, '../scripts/dp_restore.js'), enc, out], { env: { ...process.env, DP_BACKUP_KEY: 'sir' } });
  const restored = new Database(out, { readonly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM debts').get().n, 50);
  restored.close();
  assert.throws(() => execFileSync('node', [path.join(__dirname, '../scripts/dp_restore.js'), enc, out + '2'],
    { env: { ...process.env, DP_BACKUP_KEY: 'xato' }, stdio: 'pipe' }));
  dp.close();
});

test('Telegram yuborilmasa ham mahalliy zaxira olinadi', async () => {
  const { dir, dp } = seeded();
  const bot = { sendDocument: async () => { throw new Error('tarmoq yo\'q'); } };
  const job = backup.start({
    db: dp.db, dir: path.join(dir, 'backups'), getBot: () => bot, chatId: '1', secret: 's',
    log: () => {}, intervalMs: 3600000, firstDelayMs: 3600000,
  });
  const r = await job.runNow();
  assert.ok(r.error); // yuborishda xato bor
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db')).length, 1); // lekin nusxa bor
  job.stop();

  // Tarmoq tiklangach keyingi urinishda shu kunning nusxasi yuboriladi
  const sent = [];
  const good = { sendDocument: async (chat, buf) => { sent.push(buf); } };
  const job2 = backup.start({
    db: dp.db, dir: path.join(dir, 'backups'), getBot: () => good, chatId: '1', secret: 's',
    log: () => {}, intervalMs: 3600000, firstDelayMs: 3600000,
  });
  const r2 = await job2.runNow();
  assert.equal(r2.sent, true);
  assert.equal(sent.length, 1);
  assert.equal((await job2.runNow()).sent, false); // endi qayta yuborilmaydi
  job2.stop();
  dp.close();
});
