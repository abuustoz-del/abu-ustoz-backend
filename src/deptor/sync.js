// Deptor (qarz va xarajat daftari) — ilovalar o'rtasida qarzlarni sinxronlash.
// Abu-Ustoz va AbuElectric'dan butunlay alohida: o'z boti (DP_BOT_TOKEN),
// o'z yo'llari (/dp/...), o'z SQLite fayli (deptor_sync.db).
//
// Shaxsiyat: Telegram'da tasdiqlangan telefon raqami (+998...). Server faqat
// TELEFON RAQAMI BILAN BOG'LANGAN QARZLARNI saqlaydi (raqam kiritilgan va
// tarmoqqa ulangan yozuvlar). Xarajat va kirimlar serverga HECH QACHON yuborilmaydi.
//
// Kirish oqimi (abuelectric kabi):
//  1) Ilova  POST /dp/login/start  -> { code, bot }
//  2) Foydalanuvchi  t.me/<bot>?start=<code>  -> bot "Raqamni yuborish" tugmasi
//  3) Foydalanuvchi o'z kontaktini yuboradi -> server tekshiradi (o'ziniki, +998)
//  4) Ilova  GET /dp/login/poll?code=...  -> { status: 'done', token, phone }
//
// Sinxronlash: POST /dp/sync { since, name, ops: [...] } -> o'zgarishlar.
// Qoidalar:
//  - Qarz maydonlarini (summa, yo'nalish, sana...) faqat YARATUVCHI o'zgartiradi.
//  - Ikkinchi tomon uni tasdiqlaydi yoki rad etadi (respond).
//  - Qaytarishni ikkala tomon qo'sha oladi; muallif yoki ikkinchi tomon o'chira oladi.
//  - "Kechirdim" (closed) faqat qarz bergan tomondan.
//
// ENV (Render -> Environment):
//   DP_BOT_TOKEN       - @BotFather bergan token (Deptor boti)
//   DP_WEBHOOK_SECRET  - ixtiyoriy uzun tasodifiy matn (webhook himoyasi)
//   DP_JWT_SECRET      - ixtiyoriy; yo'q bo'lsa data papkada avtomatik yaratiladi
//   DP_TEST_MODE=1     - FAQAT testlar uchun: Telegram'siz kirish (productionda qo'ymang!)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const SESSION_TTL = 10 * 60 * 1000;
const MAX_SESSIONS = 5000;
const MAX_OPS = 500;
const TOKEN_TTL = '400d';

const normalizePhone = (p) => '+' + String(p || '').replace(/\D/g, '');
const isUzMobile = (p) => /^\+998\d{9}$/.test(p);
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      phone TEXT PRIMARY KEY,
      tg_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      token_ver INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS debts(
      ref TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      creator_name TEXT NOT NULL DEFAULT '',
      counter_name TEXT NOT NULL DEFAULT '',
      counter TEXT NOT NULL,
      dir TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'debt',
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      date INTEGER NOT NULL,
      due INTEGER,
      closed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      deleted INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS debts_creator ON debts(creator, rev);
    CREATE INDEX IF NOT EXISTS debts_counter ON debts(counter, rev);
    CREATE TABLE IF NOT EXISTS payments(
      uid TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      amount INTEGER NOT NULL,
      date INTEGER NOT NULL,
      by_phone TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payments_ref ON payments(ref, rev);
    CREATE TABLE IF NOT EXISTS shops(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shop_members(
      phone TEXT PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'seller',
      status TEXT NOT NULL DEFAULT 'invited',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shop_members_shop ON shop_members(shop_id);
    CREATE TABLE IF NOT EXISTS audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      who TEXT NOT NULL,
      who_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS audit_ref ON audit(ref, id);
    CREATE TABLE IF NOT EXISTS counter(id INTEGER PRIMARY KEY CHECK(id = 1), rev INTEGER NOT NULL);
    INSERT OR IGNORE INTO counter(id, rev) VALUES (1, 0);
  `);
  const cols = db.prepare('PRAGMA table_info(debts)').all().map((c) => c.name);
  if (!cols.includes('counter_name')) db.exec("ALTER TABLE debts ADD COLUMN counter_name TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('shop')) db.exec('ALTER TABLE debts ADD COLUMN shop INTEGER');
  if (!cols.includes('author_name')) db.exec("ALTER TABLE debts ADD COLUMN author_name TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS debts_shop ON debts(shop, rev)');
  return db;
}

function loadSecret(dir) {
  if (process.env.DP_JWT_SECRET) return process.env.DP_JWT_SECRET;
  const f = path.join(dir, 'deptor_secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
}

/**
 * @param {{dbFile?: string, secret?: string, testMode?: boolean}} opts
 */
function create(opts = {}) {
  const dataDir = process.env.DATA_DIR
    || (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, '../../data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(opts.dbFile || path.join(dataDir, 'deptor_sync.db'));
  const secret = opts.secret || loadSecret(dataDir);
  const testMode = opts.testMode ?? process.env.DP_TEST_MODE === '1';

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  const sessions = new Map(); // code -> { createdAt, status, chatId, token, phone, ip }
  const hits = new Map();     // chek: kalit -> [vaqtlar]
  const allowed = (key, max, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    return true;
  };
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [c, s] of sessions) if (now - s.createdAt > SESSION_TTL) sessions.delete(c);
    for (const [k, l] of hits) if (!l.some((t) => now - t < 10 * 60 * 1000)) hits.delete(k);
  }, 60 * 1000);
  cleaner.unref();

  const clientIp = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

  // ---------- Foydalanuvchi va token ----------
  const q = {
    user: db.prepare('SELECT * FROM users WHERE phone = ?'),
    insUser: db.prepare('INSERT INTO users(phone, tg_id, name, created_at, last_seen) VALUES (?,?,?,?,?)'),
    touch: db.prepare('UPDATE users SET last_seen = ?, name = CASE WHEN ? != \'\' THEN ? ELSE name END WHERE phone = ?'),
    bumpVer: db.prepare('UPDATE users SET token_ver = token_ver + 1 WHERE phone = ?'),
    nextRev: db.prepare('UPDATE counter SET rev = rev + 1 WHERE id = 1 RETURNING rev'),
    maxRev: db.prepare('SELECT rev FROM counter WHERE id = 1'),
    debt: db.prepare('SELECT * FROM debts WHERE ref = ?'),
    pay: db.prepare('SELECT * FROM payments WHERE uid = ?'),
    member: db.prepare('SELECT * FROM shop_members WHERE phone = ?'),
    shop: db.prepare('SELECT * FROM shops WHERE id = ?'),
    members: db.prepare('SELECT m.phone, m.role, m.status, u.name FROM shop_members m LEFT JOIN users u ON u.phone = m.phone WHERE m.shop_id = ? ORDER BY m.created_at'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM shop_members WHERE shop_id = ?'),
  };

  /** Foydalanuvchining faol do'koni (yo'q bo'lsa null). */
  function activeShop(phone) {
    const m = q.member.get(phone);
    return m && m.status === 'active' ? m : null;
  }
  /** Qarzda "yaratuvchi tomon"da ishlay oladimi (o'zi yoki do'kondoshi). */
  function onCreatorSide(me, d) {
    if (!d.shop) return d.creator === me;
    // Do'kon qarzi faqat do'kon a'zosiga ochiq (yaratuvchi do'kondan chiqsa ham ko'rmaydi).
    const m = activeShop(me);
    return !!m && m.shop_id === d.shop;
  }
  const canAccess = (me, d) => onCreatorSide(me, d) || d.counter === me;
  /** Qarz bergan tomonmi (close uchun). */
  const isLender = (me, d) => (d.dir === 'gave' ? onCreatorSide(me, d) : d.counter === me);
  /** Do'kon yozuvlarini qayta tamg'alash: yangi a'zo ularni qaytadan tortib olsin. */
  function restamp(shopId) {
    for (const r of db.prepare('SELECT ref FROM debts WHERE shop = ?').all(shopId)) {
      db.prepare('UPDATE debts SET rev = ? WHERE ref = ?').run(q.nextRev.get().rev, r.ref);
    }
    for (const r of db.prepare('SELECT p.uid FROM payments p JOIN debts d ON d.ref = p.ref WHERE d.shop = ?').all(shopId)) {
      db.prepare('UPDATE payments SET rev = ? WHERE uid = ?').run(q.nextRev.get().rev, r.uid);
    }
  }
  const MAX_SHOP_MEMBERS = 10;

  /** O'zgarishlar tarixi: kim, qachon, nima qilgan. Hech qachon o'chirilmaydi. */
  const insAudit = db.prepare('INSERT INTO audit(ts, who, who_name, action, ref, uid, detail) VALUES (?,?,?,?,?,?,?)');
  function audit(me, myName, action, ref, uid, detail) {
    insAudit.run(Date.now(), me, myName || '', action, ref || '', uid || '', detail ? JSON.stringify(detail) : '');
  }

  function upsertUser(phone, tgId, name) {
    const now = Date.now();
    if (!q.user.get(phone)) q.insUser.run(phone, tgId ? String(tgId) : null, clip(name, 80), now, now);
    else if (tgId) db.prepare('UPDATE users SET tg_id = ? WHERE phone = ?').run(String(tgId), phone);
  }

  function issueToken(phone) {
    const u = q.user.get(phone);
    return jwt.sign({ sub: phone, v: u ? u.token_ver : 1 }, secret, { algorithm: 'HS256', expiresIn: TOKEN_TTL });
  }

  function auth(req, res, next) {
    const h = String(req.get('authorization') || '');
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    try {
      const p = jwt.verify(t, secret, { algorithms: ['HS256'] });
      const u = q.user.get(p.sub);
      if (!u || u.token_ver !== p.v) throw new Error('revoked');
      req.phone = p.sub;
      req.user = u;
      next();
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  }

  // ---------- Kirish ----------
  let bot = null;
  let botUsername = process.env.DP_BOT_USERNAME || '';

  router.post('/login/start', (req, res) => {
    // Bot yo'q yoki bot nomi noma'lum (token yaroqsiz): bo'sh havola foydalanuvchini adashtiradi.
    if ((!bot || !botUsername) && !testMode) return res.status(503).json({ error: 'not_configured' });
    if (!allowed('ip:' + clientIp(req), 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    if (sessions.size >= MAX_SESSIONS) return res.status(503).json({ error: 'busy' });
    const code = crypto.randomBytes(16).toString('hex');
    sessions.set(code, { createdAt: Date.now(), status: 'pending' });
    res.json({ code, bot: botUsername, expiresIn: SESSION_TTL / 1000 });
  });

  router.get('/login/poll', (req, res) => {
    const code = String(req.query.code || '');
    const s = sessions.get(code);
    if (!s || Date.now() - s.createdAt > SESSION_TTL) return res.json({ status: 'expired' });
    if (s.status === 'done') {
      sessions.delete(code); // token faqat bir marta beriladi
      return res.json({ status: 'done', token: s.token, phone: s.phone });
    }
    res.json({ status: s.status });
  });

  router.post('/logout', auth, (req, res) => {
    q.bumpVer.run(req.phone);
    res.json({ ok: true });
  });

  // Faqat testlar uchun: Telegram'siz kirish
  if (testMode) {
    router.post('/test/login', (req, res) => {
      const phone = normalizePhone(req.body && req.body.phone);
      if (!isUzMobile(phone)) return res.status(400).json({ error: 'bad_phone' });
      upsertUser(phone, 'test', '');
      res.json({ token: issueToken(phone), phone });
    });
  }

  router.post('/webhook', (req, res) => {
    const sec = process.env.DP_WEBHOOK_SECRET;
    if (sec && req.get('X-Telegram-Bot-Api-Secret-Token') !== sec) return res.sendStatus(401);
    if (bot) bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  router.get('/health', async (req, res) => {
    const out = { bot: !!bot, botUsername, testMode, sessions: sessions.size };
    // Diagnostika: Telegram aloqasi va zaxira holati (maxfiy ma'lumotlarsiz).
    try {
      const bdir = path.join(dataDir, 'backups');
      const files = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith('.db')).sort() : [];
      out.backups = { count: files.length, last: files[files.length - 1] || null, offsite: !!(process.env.DP_BACKUP_CHAT_ID && process.env.DP_BACKUP_KEY) };
      out.disk = dataDir.startsWith('/var/data') ? 'persistent' : 'local';
      // Faqat sonlar (ism yoki raqamsiz): foydalanuvchilar kirganini va qarzlar yetib kelganini ko'rish uchun.
      out.counts = {
        users: db.prepare('SELECT COUNT(*) n FROM users WHERE tg_id IS NOT NULL').get().n,
        debts: db.prepare('SELECT COUNT(*) n FROM debts WHERE deleted = 0').get().n,
        pending: db.prepare("SELECT COUNT(*) n FROM debts WHERE deleted = 0 AND status = 'pending'").get().n,
        shops: db.prepare('SELECT COUNT(*) n FROM shops').get().n,
        // Qarzdagi ikkinchi tomon raqami ro'yxatdan o'tgan foydalanuvchiga mos keladimi (yetkazilishi mumkinmi).
        matched: db.prepare('SELECT COUNT(*) n FROM debts d JOIN users u ON u.phone = d.counter AND u.tg_id IS NOT NULL WHERE d.deleted = 0').get().n,
      };
    } catch {}
    if (bot) {
      try {
        const w = await Promise.race([bot.getWebHookInfo(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
        out.webhook = { set: !!w.url, pending: w.pending_update_count, lastError: w.last_error_message || null, lastErrorAt: w.last_error_date || null };
      } catch (e) { out.webhook = { error: e.message }; }
    }
    res.json(out);
  });

  // ---------- Foydalanuvchi ma'lumoti ----------
  router.get('/me', auth, (req, res) => res.json({ phone: req.phone, name: req.user.name }));

  router.get('/lookup', auth, (req, res) => {
    if (!allowed('lk:' + req.phone, 30, 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const phone = normalizePhone(req.query.phone);
    if (!isUzMobile(phone)) return res.json({ registered: false });
    res.json({ registered: !!q.user.get(phone) });
  });

  // ---------- Sinxronlash ----------

  /** Bitta amalni bajaradi; xato bo'lsa sabab satrini qaytaradi. */
  function applyOp(me, myName, op) {
    if (!op || typeof op !== 'object') return 'bad_op';
    switch (op.op) {
      case 'debt': {
        const ref = clip(op.ref, 40);
        if (!/^[A-Za-z0-9_-]{6,40}$/.test(ref)) return 'bad_ref';
        const existing = q.debt.get(ref);
        if (existing && !onCreatorSide(me, existing)) return 'forbidden'; // boshqaning yozuvi
        // Do'kon qarzida mijoz raqami bo'lmasligi mumkin (counter = ''): faqat do'kondoshlar ko'radi.
        const rawCounter = clip(op.counter, 20);
        const shopDebt = !!(existing ? existing.shop : op.shop);
        const counter = rawCounter ? normalizePhone(rawCounter) : '';
        if (counter === '') {
          if (!shopDebt) return 'bad_counter';
        } else if (!isUzMobile(counter) || counter === me) {
          return 'bad_counter';
        }
        if (op.dir !== 'gave' && op.dir !== 'took') return 'bad_dir';
        const kind = op.kind === 'payment' ? 'payment' : 'debt';
        if (!isInt(op.amount, 1, 1e13)) return 'bad_amount';
        if (!isInt(op.date, 0, 4e12)) return 'bad_date';
        const due = op.due == null ? null : op.due;
        if (due != null && !isInt(due, 0, 4e12)) return 'bad_due';
        const currency = clip(op.currency, 5);
        const note = clip(op.note, 500);
        const cname = clip(op.cname, 80);
        const cur = q.debt.get(ref);
        const name = myName || me;
        if (!cur) {
          let shopId = null;
          let shownName = name;
          if (op.shop) {
            const m = activeShop(me);
            if (!m) return 'no_shop';
            shopId = m.shop_id;
            shownName = q.shop.get(shopId).name;
          }
          const rev = q.nextRev.get().rev;
          db.prepare(`INSERT INTO debts(ref, creator, creator_name, author_name, shop, counter_name, counter, dir, kind, amount, currency, note, date, due, closed, status, deleted, rev)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,0,?)`)
            .run(ref, me, shownName, name, shopId, cname, counter, op.dir, kind, op.amount, currency, note, op.date, due, counter ? 'pending' : 'confirmed', rev);
          audit(me, name, 'create', ref, '', { amount: op.amount, dir: op.dir, name: cname, note });
          return null;
        }
        if (!onCreatorSide(me, cur)) return 'forbidden';
        if (cur.deleted) return 'deleted';
        const changed = cur.counter !== counter || cur.dir !== op.dir || cur.kind !== kind
          || cur.amount !== op.amount || cur.date !== op.date || (cur.due ?? null) !== due
          || cur.currency !== currency || cur.note !== note
          || (!cur.shop && cur.creator_name !== name) || cur.counter_name !== cname;
        if (!changed) return null;
        const material = cur.counter !== counter || cur.dir !== op.dir || cur.kind !== kind
          || cur.amount !== op.amount || cur.currency !== currency;
        const status = !counter ? 'confirmed' : (material ? 'pending' : cur.status);
        const rev = q.nextRev.get().rev;
        // Do'kon yozuvida ko'rinadigan nom do'kon nomi; shaxsiyda - egasining ismi.
        const shown = cur.shop ? cur.creator_name : name;
        db.prepare(`UPDATE debts SET creator_name=?, counter_name=?, counter=?, dir=?, kind=?, amount=?, currency=?, note=?, date=?, due=?, status=?, rev=? WHERE ref=?`)
          .run(shown, cname, counter, op.dir, kind, op.amount, currency, note, op.date, due, status, rev, ref);
        audit(me, name, 'edit', ref, '', {
          amount: [cur.amount, op.amount], note: [cur.note, note], name: [cur.counter_name, cname],
        });
        return null;
      }
      case 'del_debt': {
        const cur = q.debt.get(clip(op.ref, 40));
        if (!cur) return null; // allaqachon yo'q - muammo emas
        if (!onCreatorSide(me, cur)) return 'forbidden';
        if (cur.deleted) return null;
        db.prepare('UPDATE debts SET deleted = 1, rev = ? WHERE ref = ?').run(q.nextRev.get().rev, cur.ref);
        audit(me, myName, 'delete', cur.ref, '', { amount: cur.amount, name: cur.counter_name });
        return null;
      }
      case 'respond': {
        const cur = q.debt.get(clip(op.ref, 40));
        if (!cur || cur.deleted) return 'not_found';
        if (cur.counter !== me) return 'forbidden';
        if (op.status !== 'confirmed' && op.status !== 'rejected') return 'bad_status';
        if (cur.status === op.status) return null;
        db.prepare('UPDATE debts SET status = ?, rev = ? WHERE ref = ?').run(op.status, q.nextRev.get().rev, cur.ref);
        audit(me, myName, 'respond', cur.ref, '', { status: op.status });
        return null;
      }
      case 'close': {
        const cur = q.debt.get(clip(op.ref, 40));
        if (!cur || cur.deleted) return 'not_found';
        if (!canAccess(me, cur)) return 'forbidden';
        if (!isLender(me, cur)) return 'forbidden';
        const closed = op.closed ? 1 : 0;
        if (cur.closed === closed) return null;
        db.prepare('UPDATE debts SET closed = ?, rev = ? WHERE ref = ?').run(closed, q.nextRev.get().rev, cur.ref);
        audit(me, myName, closed ? 'close' : 'reopen', cur.ref, '', null);
        return null;
      }
      case 'pay': {
        const uid = clip(op.uid, 40);
        if (!/^[A-Za-z0-9_-]{8,40}$/.test(uid)) return 'bad_uid';
        const d = q.debt.get(clip(op.ref, 40));
        if (!d || d.deleted) return 'not_found';
        if (!canAccess(me, d)) return 'forbidden';
        if (d.status === 'rejected') return 'rejected';
        if (!isInt(op.amount, 1, 1e13)) return 'bad_amount';
        if (!isInt(op.date, 0, 4e12)) return 'bad_date';
        const cur = q.pay.get(uid);
        if (cur) {
          if (cur.ref !== d.ref || cur.by_phone !== me) return 'forbidden';
          return null; // takroriy yuborish
        }
        db.prepare('INSERT INTO payments(uid, ref, amount, date, by_phone, deleted, rev) VALUES (?,?,?,?,?,0,?)')
          .run(uid, d.ref, op.amount, op.date, me, q.nextRev.get().rev);
        audit(me, myName, 'pay', d.ref, uid, { amount: op.amount });
        return null;
      }
      case 'del_pay': {
        const cur = q.pay.get(clip(op.uid, 40));
        if (!cur) return null;
        const d = q.debt.get(cur.ref);
        if (!d || !canAccess(me, d)) return 'forbidden';
        if (cur.deleted) return null;
        db.prepare('UPDATE payments SET deleted = 1, rev = ? WHERE uid = ?').run(q.nextRev.get().rev, cur.uid);
        audit(me, myName, 'del_pay', d.ref, cur.uid, { amount: cur.amount });
        return null;
      }
      case 'restore_debt': {
        const d = q.debt.get(clip(op.ref, 40));
        if (!d) return 'not_found';
        if (!onCreatorSide(me, d)) return 'forbidden';
        if (!d.deleted) return null;
        db.prepare('UPDATE debts SET deleted = 0, rev = ? WHERE ref = ?').run(q.nextRev.get().rev, d.ref);
        // Qaytarishlar ham qayta yuborilsin (telefondagi nusxa qarz bilan birga o'chgan edi).
        for (const r of db.prepare('SELECT uid FROM payments WHERE ref = ?').all(d.ref)) {
          db.prepare('UPDATE payments SET rev = ? WHERE uid = ?').run(q.nextRev.get().rev, r.uid);
        }
        audit(me, myName, 'restore', d.ref, '', { amount: d.amount, name: d.counter_name });
        return null;
      }
      case 'restore_pay': {
        const cur = q.pay.get(clip(op.uid, 40));
        if (!cur) return 'not_found';
        const d = q.debt.get(cur.ref);
        if (!d || !canAccess(me, d)) return 'forbidden';
        if (d.deleted) return 'debt_deleted';
        if (!cur.deleted) return null;
        db.prepare('UPDATE payments SET deleted = 0, rev = ? WHERE uid = ?').run(q.nextRev.get().rev, cur.uid);
        audit(me, myName, 'restore_pay', d.ref, cur.uid, { amount: cur.amount });
        return null;
      }
      case 'shop_create': {
        if (q.member.get(me)) return 'already_member';
        const name = clip(op.name, 60);
        if (name.length < 2) return 'bad_name';
        const id = db.prepare('INSERT INTO shops(name, owner, created_at) VALUES (?,?,?)').run(name, me, Date.now()).lastInsertRowid;
        db.prepare("INSERT INTO shop_members(phone, shop_id, role, status, created_at) VALUES (?,?, 'owner','active',?)").run(me, id, Date.now());
        return null;
      }
      case 'shop_invite': {
        const m = activeShop(me);
        if (!m || m.role !== 'owner') return 'forbidden';
        const phone = normalizePhone(op.phone);
        if (!isUzMobile(phone) || phone === me) return 'bad_phone';
        const u = q.user.get(phone);
        if (!u || !u.tg_id) return 'not_registered';
        if (q.member.get(phone)) return 'already_member';
        if (q.memberCount.get(m.shop_id).n >= MAX_SHOP_MEMBERS) return 'too_many_members';
        db.prepare("INSERT INTO shop_members(phone, shop_id, role, status, created_at) VALUES (?,?, 'seller','invited',?)").run(phone, m.shop_id, Date.now());
        return null;
      }
      case 'shop_accept': {
        const m = q.member.get(me);
        if (!m || m.status !== 'invited') return 'no_invite';
        db.prepare("UPDATE shop_members SET status = 'active' WHERE phone = ?").run(me);
        restamp(m.shop_id);
        return null;
      }
      case 'shop_leave': { // taklifni rad etish yoki do'kondan chiqish
        const m = q.member.get(me);
        if (!m) return null;
        if (m.role === 'owner') {
          if (q.memberCount.get(m.shop_id).n > 1) return 'owner_cannot_leave';
          db.prepare('DELETE FROM shops WHERE id = ?').run(m.shop_id);
        }
        db.prepare('DELETE FROM shop_members WHERE phone = ?').run(me);
        return null;
      }
      case 'shop_remove': {
        const m = activeShop(me);
        if (!m || m.role !== 'owner') return 'forbidden';
        const phone = normalizePhone(op.phone);
        const t = q.member.get(phone);
        if (!t || t.shop_id !== m.shop_id || phone === me) return 'not_found';
        db.prepare('DELETE FROM shop_members WHERE phone = ?').run(phone);
        return null;
      }
      default:
        return 'unknown_op';
    }
  }

  /** Foydalanuvchi uchun do'kon holati (taklif yoki faol), yo'q bo'lsa null. */
  function shopInfo(phone) {
    const m = q.member.get(phone);
    if (!m) return null;
    const sh = q.shop.get(m.shop_id);
    if (!sh) return null;
    const info = { id: sh.id, name: sh.name, role: m.role, status: m.status, owner: sh.owner };
    if (m.status === 'active') {
      info.members = q.members.all(m.shop_id).map((x) => ({ phone: x.phone, name: x.name || '', role: x.role, status: x.status }));
    }
    return info;
  }

  const PULL_DEBTS = opts.pullDebts || 2000;
  const PULL_PAYS = opts.pullPays || 5000;
  const pullDebts = db.prepare(`SELECT * FROM debts WHERE ((creator = ? AND shop IS NULL) OR counter = ? OR shop = ?) AND rev > ? ORDER BY rev LIMIT ${PULL_DEBTS}`);
  const pullPays = db.prepare(`SELECT p.* FROM payments p JOIN debts d ON d.ref = p.ref
                               WHERE ((d.creator = ? AND d.shop IS NULL) OR d.counter = ? OR d.shop = ?) AND p.rev > ? ORDER BY p.rev LIMIT ${PULL_PAYS}`);
  const isReg = db.prepare('SELECT 1 FROM users WHERE phone = ? AND tg_id IS NOT NULL');

  // ---------- Jonli aloqa (Server-Sent Events) ----------
  // Ilova ochiq paytida ulanib turadi: o'zgarish bo'lsa darhol "change" yuboriladi va
  // ilova sinxronlashni boshlaydi (60 soniya kutmaydi).
  const streams = new Map(); // telefon -> Set<res>
  const MAX_STREAMS_PER_PHONE = 5;

  router.get('/events', auth, (req, res) => {
    const set = streams.get(req.phone) || new Set();
    if (set.size >= MAX_STREAMS_PER_PHONE) {
      // Eng eskisini yopamiz (ilova qayta ulangan bo'lishi mumkin).
      const oldest = set.values().next().value;
      try { oldest.end(); } catch {}
      set.delete(oldest);
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\nevent: hello\ndata: 1\n\n');
    set.add(res);
    streams.set(req.phone, set);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20 * 1000);
    req.on('close', () => {
      clearInterval(beat);
      set.delete(res);
      if (!set.size) streams.delete(req.phone);
    });
  });

  function notifyPhones(phones) {
    for (const ph of phones) {
      const set = streams.get(ph);
      if (!set) continue;
      for (const r of set) { try { r.write('event: change\ndata: 1\n\n'); } catch {} }
    }
  }

  /** Muvaffaqiyatli bajarilgan amallardan ta'sirlangan telefonlarni topadi va xabar beradi. */
  function notifyAffected(sender, ops) {
    const phones = new Set();
    const addShop = (shopId) => {
      if (!shopId) return;
      for (const m of q.members.all(shopId)) phones.add(m.phone);
    };
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      let ref = op.ref ? clip(op.ref, 40) : '';
      if (!ref && op.uid) { const pay = q.pay.get(clip(op.uid, 40)); if (pay) ref = pay.ref; }
      if (ref) {
        const d = q.debt.get(ref);
        if (d) {
          if (d.counter) phones.add(d.counter);
          if (d.shop) addShop(d.shop); else phones.add(d.creator);
        }
      }
      if (String(op.op || '').startsWith('shop_')) {
        const mine = q.member.get(sender);
        if (mine) addShop(mine.shop_id);
        if (op.phone) phones.add(normalizePhone(op.phone));
      }
    }
    phones.delete(sender);
    notifyPhones(phones);
  }

  // ---------- Tarix va o'chirilganlar ----------
  router.get('/history', auth, (req, res) => {
    if (!allowed('hi:' + req.phone, 60, 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const d = q.debt.get(clip(req.query.ref, 40));
    if (!d || !onCreatorSide(req.phone, d)) return res.status(404).json({ error: 'not_found' });
    const rows = db.prepare('SELECT ts, who, who_name, action, uid, detail FROM audit WHERE ref = ? ORDER BY id DESC LIMIT 200').all(d.ref);
    res.json({
      items: rows.map((r) => {
        let detail = null;
        try { detail = r.detail ? JSON.parse(r.detail) : null; } catch {}
        return { ts: r.ts, who: r.who, name: r.who_name, action: r.action, uid: r.uid, detail };
      }),
    });
  });

  router.get('/trash', auth, (req, res) => {
    if (!allowed('tr:' + req.phone, 30, 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const m = activeShop(req.phone);
    const shopId = m ? m.shop_id : -1;
    const lastDel = db.prepare("SELECT ts, who_name FROM audit WHERE ref = ? AND action = 'delete' ORDER BY id DESC LIMIT 1");
    const lastDelPay = db.prepare("SELECT ts, who_name FROM audit WHERE uid = ? AND action = 'del_pay' ORDER BY id DESC LIMIT 1");
    const debts = db.prepare(`SELECT * FROM debts WHERE deleted = 1 AND ((creator = ? AND shop IS NULL) OR shop = ?) ORDER BY rev DESC LIMIT 100`)
      .all(req.phone, shopId).map((d) => {
        const a = lastDel.get(d.ref) || {};
        return { ref: d.ref, name: d.counter_name, dir: d.dir, kind: d.kind, amount: d.amount, currency: d.currency, date: d.date, shop: d.shop || null, deletedAt: a.ts || 0, by: a.who_name || '' };
      });
    const payments = db.prepare(`SELECT p.*, d.counter_name AS cname FROM payments p JOIN debts d ON d.ref = p.ref
                                 WHERE p.deleted = 1 AND d.deleted = 0 AND ((d.creator = ? AND d.shop IS NULL) OR d.shop = ? OR d.counter = ?)
                                 ORDER BY p.rev DESC LIMIT 100`)
      .all(req.phone, shopId, req.phone).map((p) => {
        const a = lastDelPay.get(p.uid) || {};
        return { uid: p.uid, ref: p.ref, name: p.cname, amount: p.amount, date: p.date, deletedAt: a.ts || 0, by: a.who_name || '' };
      });
    res.json({ debts, payments });
  });

  router.post('/sync', auth, (req, res) => {
    if (!allowed('sy:' + req.phone, 120, 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const body = req.body || {};
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length > MAX_OPS) return res.status(413).json({ error: 'too_many_ops' });
    const since = Number.isSafeInteger(body.since) && body.since >= 0 ? body.since : 0;
    const name = clip(body.name, 80);
    const rejected = [];
    const applied = [];
    try {
      db.transaction(() => {
        q.touch.run(Date.now(), name, name, req.phone);
        const myName = name || q.user.get(req.phone).name;
        ops.forEach((op, i) => {
          const why = applyOp(req.phone, myName, op);
          if (why) rejected.push({ i, reason: why }); else applied.push(op);
        });
      })();
    } catch (e) {
      console.error('[DP] sync:', e.message);
      return res.status(500).json({ error: 'server' });
    }
    if (applied.length) { try { notifyAffected(req.phone, applied); } catch (e) { console.error('[DP] notify:', e.message); } }
    const myShop = activeShop(req.phone);
    const shopId = myShop ? myShop.shop_id : -1;
    let debts = pullDebts.all(req.phone, req.phone, shopId, since);
    let payments = pullPays.all(req.phone, req.phone, shopId, since);
    // Natija juda katta bo'lsa, kursorni qirqilgan joyga qo'yamiz - aks holda
    // qolgan yozuvlar hech qachon kelmay qolardi. Ilova `more` bo'lsa qayta so'raydi.
    const globalMax = q.maxRev.get().rev;
    let upto = globalMax;
    if (debts.length >= PULL_DEBTS) upto = Math.min(upto, debts[debts.length - 1].rev);
    if (payments.length >= PULL_PAYS) upto = Math.min(upto, payments[payments.length - 1].rev);
    debts = debts.filter((d) => d.rev <= upto);
    payments = payments.filter((p) => p.rev <= upto);
    const phones = new Set();
    for (const d of debts) { phones.add(d.creator); phones.add(d.counter); }
    phones.delete(req.phone);
    const registered = [...phones].filter((p) => isReg.get(p));
    res.json({
      rev: upto,
      more: upto < globalMax,
      debts: debts.map((d) => ({
        ref: d.ref, creator: d.creator, creatorName: d.creator_name, counter: d.counter,
        // Yaratuvchi tomonning (o'zi va do'kondoshlari) yorlig'i faqat shu tomonga qaytadi
        counterName: (d.shop ? d.shop === shopId : d.creator === req.phone) ? d.counter_name : '',
        authorName: d.author_name, shop: d.shop || null,
        dir: d.dir, kind: d.kind, amount: d.amount, currency: d.currency, note: d.note,
        date: d.date, due: d.due, closed: !!d.closed, status: d.status, deleted: !!d.deleted,
      })),
      payments: payments.map((p) => ({
        uid: p.uid, ref: p.ref, amount: p.amount, date: p.date, by: p.by_phone, deleted: !!p.deleted,
      })),
      registered,
      rejected,
      shop: shopInfo(req.phone),
    });
  });

  // ---------- Telegram bot ----------
  const botKeyboard = { keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

  async function onStart(msg, code) {
    const chatId = msg.chat.id;
    const s = code && sessions.get(code);
    if (!s || Date.now() - s.createdAt > SESSION_TTL) {
      return bot.sendMessage(chatId, "Assalomu alaykum! Bu Deptor — qarz va xarajatlar daftari.\n\nKirish uchun Deptor ilovasida «Telegram orqali kirish» tugmasini bosing.");
    }
    for (const [c, o] of sessions) if (o !== s && o.chatId === chatId && o.status === 'waiting_contact') sessions.delete(c);
    s.chatId = chatId;
    s.status = 'waiting_contact';
    return bot.sendMessage(chatId,
      "Raqamingizni tasdiqlash uchun pastdagi «📱 Raqamni yuborish» tugmasini bosing.\n\nRaqamingiz faqat qarzlarni ikkinchi tomon bilan bog'lash uchun ishlatiladi.",
      { reply_markup: botKeyboard });
  }

  async function onContact(msg) {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    if (!contact || String(contact.user_id) !== String(msg.from.id)) {
      return bot.sendMessage(chatId, "Iltimos, aynan o'zingizning raqamingizni «📱 Raqamni yuborish» tugmasi orqali yuboring.");
    }
    const phone = normalizePhone(contact.phone_number);
    if (!isUzMobile(phone)) {
      return bot.sendMessage(chatId, "Hozircha faqat O'zbekiston raqamlari (+998) qabul qilinadi.", { reply_markup: { remove_keyboard: true } });
    }
    const entry = [...sessions.entries()].find(([, o]) => o.chatId === chatId && o.status === 'waiting_contact');
    if (!entry) return bot.sendMessage(chatId, 'Avval Deptor ilovasida «Telegram orqali kirish» tugmasini bosing.', { reply_markup: { remove_keyboard: true } });
    completeLogin(entry[1], phone, msg.from.id);
    return bot.sendMessage(chatId, `✅ Raqam tasdiqlandi: ${phone}\n\nDeptor ilovasiga qayting — kirish avtomatik davom etadi.`,
      { reply_markup: { remove_keyboard: true } });
  }

  function completeLogin(session, phone, tgId) {
    upsertUser(phone, tgId, '');
    session.phone = phone;
    session.token = issueToken(phone);
    session.status = 'done';
  }

  function initBot() {
    const token = process.env.DP_BOT_TOKEN;
    if (!token) { console.log("ℹ️  [DP] DP_BOT_TOKEN yo'q - Deptor sinxronlash kirishi o'chiq"); return; }
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(token, { polling: false });
    bot.onText(/^\/start(?:\s+([a-f0-9]{32}))?/, (msg, m) => onStart(msg, m && m[1]).catch((e) => console.error('[DP] start:', e.message)));
    // Zaxira nusxa yuboriladigan chat raqamini bilish uchun (faqat o'z raqamingizni ko'rsatadi).
    bot.onText(/^\/id$/, (msg) => bot.sendMessage(msg.chat.id, `Chat ID: ${msg.chat.id}`).catch(() => {}));
    bot.on('contact', (msg) => onContact(msg).catch((e) => console.error('[DP] contact:', e.message)));
    const loadMe = (tries) => bot.getMe()
      .then((me) => { botUsername = me.username; console.log(`🤖 [DP] @${botUsername} tayyor`); })
      .catch((e) => {
        console.error('[DP] getMe:', e.message);
        if (tries > 0) { const t = setTimeout(() => loadMe(tries - 1), 30 * 1000); t.unref(); }
      });
    loadMe(10);
    const base = process.env.RENDER_EXTERNAL_URL || process.env.DP_PUBLIC_URL;
    if (base) {
      bot.setWebHook(`${base}/dp/webhook`, { secret_token: process.env.DP_WEBHOOK_SECRET || undefined })
        .then(() => console.log("🔗 [DP] webhook o'rnatildi"))
        .catch((e) => console.error('[DP] setWebHook:', e.message));
    }
  }

  let backups = null;
  /** Kunlik zaxira: faqat asosiy serverda (testlarda chaqirilmaydi). */
  function startBackups() {
    if (backups) return backups;
    backups = require('./backup').start({
      db,
      dir: path.join(dataDir, 'backups'),
      getBot: () => bot,
      chatId: process.env.DP_BACKUP_CHAT_ID,
      secret: process.env.DP_BACKUP_KEY,
    });
    if (!process.env.DP_BACKUP_CHAT_ID || !process.env.DP_BACKUP_KEY) {
      console.log("ℹ️  [DP] DP_BACKUP_CHAT_ID/DP_BACKUP_KEY yo'q - faqat mahalliy zaxira (tashqi yuborilmaydi)");
    }
    return backups;
  }

  return {
    router, db, sessions, initBot, startBackups,
    close() {
      clearInterval(cleaner);
      if (backups) backups.stop();
      for (const set of streams.values()) for (const r of set) { try { r.end(); } catch {} }
      try { db.close(); } catch {}
    },
    _test: { completeLogin, issueToken, upsertUser },
  };
}

/** Asosiy ilovaga ulash: xato bo'lsa ham boshqa modullarga ta'sir qilmaydi. */
function init(app) {
  const dp = create();
  dp.initBot();
  dp.startBackups();
  app.use('/dp', dp.router);
  return dp;
}

module.exports = { create, init, normalizePhone, isUzMobile };
