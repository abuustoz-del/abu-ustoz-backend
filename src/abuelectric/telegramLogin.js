// AbuElectric (abuelectric.uz) — Telegram orqali kirish.
// Abu-Ustoz botidan butunlay alohida: o'z boti (AE_BOT_TOKEN), o'z yo'llari (/ae/...).
//
// Oqim:
//  1) Sayt  POST /ae/login/start  → { code, bot }      (bir martalik kod, 10 daqiqa)
//  2) Usta  t.me/<bot>?start=<code> → bot "📱 Raqamni yuborish" tugmasini ko'rsatadi
//  3) Usta  o'z kontaktini yuboradi → server tekshiradi (o'ziniki, +998) → Firebase custom token
//  4) Sayt  GET /ae/login/poll?code=… → { status: 'done', token } → signInWithCustomToken
//
// Kerakli ENV (Render → Environment):
//   AE_BOT_TOKEN        — @BotFather bergan token
//   AE_WEBHOOK_SECRET   — ixtiyoriy uzun tasodifiy matn (webhook himoyasi)
//   AE_FIREBASE_SA      — Firebase service account JSON (yoki Secret File: /etc/secrets/ae-firebase-sa.json)
//   AE_SITE_URL         — https://abuelectric.uz (botdagi "saytga qaytish" tugmasi uchun)
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const TelegramBot = require('node-telegram-bot-api');

const router = express.Router();
const SESSION_TTL = 10 * 60 * 1000;
const MAX_SESSIONS = 5000;
const sessions = new Map(); // code → { createdAt, status, chatId, token, ip }
let bot = null;
let botUsername = process.env.AE_BOT_USERNAME || '';
let serviceAccount = null;

function loadServiceAccount() {
  try {
    // 1) ENV  2) Render Secret File — nomi qanday bo'lishidan qat'i nazar (/etc/secrets/*.json va ilova papkasi)
    const candidates = [];
    if (process.env.AE_FIREBASE_SA) candidates.push(process.env.AE_FIREBASE_SA);
    for (const dir of ['/etc/secrets', process.cwd()]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/\.json$/i.test(f) && !/^package/.test(f)) candidates.push(fs.readFileSync(require('path').join(dir, f), 'utf8'));
        }
      } catch {}
    }
    for (const raw of candidates) {
      try {
        const sa = JSON.parse(raw);
        if (sa.type === 'service_account' && sa.client_email && sa.private_key && /abuelectric/.test(sa.project_id || '')) {
          sa.private_key = sa.private_key.replace(/\\n/g, '\n');
          console.log(`🔑 [AE] Firebase kaliti topildi: ${sa.client_email}`);
          return sa;
        }
      } catch {}
    }
    return null;
  } catch (e) {
    console.error('⚠️ [AE] Firebase service account o\'qilmadi:', e.message);
    return null;
  }
}

// Firebase custom token (firebase-admin'siz, RS256 JWT)
function createCustomToken(uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims,
  }, serviceAccount.private_key, { algorithm: 'RS256' });
}

function cleanup() {
  const now = Date.now();
  for (const [code, s] of sessions) if (now - s.createdAt > SESSION_TTL) sessions.delete(code);
}
setInterval(cleanup, 60 * 1000).unref();

// Oddiy IP cheklovi: 10 daqiqada 20 ta kirish urinishi
const ipHits = new Map();
function ipAllowed(ip) {
  const now = Date.now();
  const list = (ipHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 20) { ipHits.set(ip, list); return false; }
  list.push(now); ipHits.set(ip, list);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of ipHits) if (!l.some((t) => now - t < 10 * 60 * 1000)) ipHits.delete(ip); }, 5 * 60 * 1000).unref();

// Render proksi orqasida: haqiqiy mijoz IP'si X-Forwarded-For'ning birinchi qiymati
const clientIp = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

const normalizePhone = (p) => '+' + String(p || '').replace(/\D/g, '');
const isUzMobile = (p) => /^\+998\d{9}$/.test(p);
const uidForPhone = (p) => 'p' + p.slice(1); // +998901234567 → p998901234567 (bitta raqam = bitta profil)

// ---------- HTTP ----------
router.post('/login/start', (req, res) => {
  if (!bot || !serviceAccount) return res.status(503).json({ error: 'not_configured' });
  if (!ipAllowed(clientIp(req))) return res.status(429).json({ error: 'too_many' });
  if (sessions.size >= MAX_SESSIONS) cleanup();
  if (sessions.size >= MAX_SESSIONS) return res.status(503).json({ error: 'busy' });
  const code = crypto.randomBytes(16).toString('hex');
  sessions.set(code, { createdAt: Date.now(), status: 'pending', ip: clientIp(req) });
  res.json({ code, bot: botUsername, expiresIn: SESSION_TTL / 1000 });
});

router.get('/login/poll', (req, res) => {
  const code = String(req.query.code || '');
  const s = sessions.get(code);
  if (!s || Date.now() - s.createdAt > SESSION_TTL) return res.json({ status: 'expired' });
  if (s.status === 'done') {
    sessions.delete(code); // token faqat bir marta beriladi
    return res.json({ status: 'done', token: s.token });
  }
  res.json({ status: s.status });
});

router.post('/webhook', (req, res) => {
  const secret = process.env.AE_WEBHOOK_SECRET;
  if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(401);
  if (bot) bot.processUpdate(req.body);
  res.sendStatus(200);
});

router.get('/health', (req, res) => res.json({ bot: !!bot, botUsername, firebase: !!serviceAccount, sessions: sessions.size }));

// ---------- Bot ----------
const siteUrl = () => process.env.AE_SITE_URL || 'https://abuelectric.uz';

async function onStart(msg, code) {
  const chatId = msg.chat.id;
  const s = code && sessions.get(code);
  if (!s || Date.now() - s.createdAt > SESSION_TTL) {
    return bot.sendMessage(chatId,
      "Assalomu alaykum! Bu AbuElectric — O'zbekiston bo'ylab elektriklar katalogi.\n\nKirish uchun saytdagi «Telegram orqali kirish» tugmasini bosing.",
      { reply_markup: { inline_keyboard: [[{ text: '⚡ abuelectric.uz', url: siteUrl() + '/kirish/' }]] } });
  }
  // Shu chatdagi eski, tugallanmagan sessiyalar bekor (token faqat oxirgi kirishga beriladi)
  for (const [c, o] of sessions) if (o !== s && o.chatId === chatId && o.status === 'waiting_contact') sessions.delete(c);
  s.chatId = chatId;
  s.status = 'waiting_contact';
  return bot.sendMessage(chatId,
    "Raqamingizni tasdiqlash uchun pastdagi «📱 Raqamni yuborish» tugmasini bosing.\n\nRaqamingiz faqat profilingiz uchun ishlatiladi.",
    { reply_markup: { keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
}

async function onContact(msg) {
  const chatId = msg.chat.id;
  const entry = [...sessions.entries()].find(([, s]) => s.chatId === chatId && s.status === 'waiting_contact');
  if (!entry) {
    return bot.sendMessage(chatId, "Kirish vaqti tugagan. Saytda «Telegram orqali kirish» tugmasini qayta bosing.",
      { reply_markup: { remove_keyboard: true } });
  }
  const [, s] = entry;
  const contact = msg.contact;
  // Faqat o'z raqami: boshqa odamning kontaktini yuborib bo'lmaydi
  if (!contact || String(contact.user_id) !== String(msg.from.id)) {
    return bot.sendMessage(chatId, "Iltimos, aynan o'zingizning raqamingizni «📱 Raqamni yuborish» tugmasi orqali yuboring.");
  }
  const phone = normalizePhone(contact.phone_number);
  if (!isUzMobile(phone)) {
    return bot.sendMessage(chatId, "Hozircha faqat O'zbekiston raqamlari (+998) qabul qilinadi.", { reply_markup: { remove_keyboard: true } });
  }
  s.token = createCustomToken(uidForPhone(phone), { tel: phone, tg: String(msg.from.id) });
  s.status = 'done';
  return bot.sendMessage(chatId, `✅ Raqam tasdiqlandi: ${phone}\n\nSaytga qayting — kirish avtomatik davom etadi.`,
    { reply_markup: { remove_keyboard: true } })
    .then(() => bot.sendMessage(chatId, '👇', { reply_markup: { inline_keyboard: [[{ text: '⚡ Saytga qaytish', url: siteUrl() + '/kabinet/' }]] } }));
}

function init(app) {
  serviceAccount = loadServiceAccount();
  const token = process.env.AE_BOT_TOKEN;
  if (!token) { console.log('ℹ️  [AE] AE_BOT_TOKEN yo\'q — AbuElectric Telegram kirish o\'chiq'); }
  else {
    bot = new TelegramBot(token, { polling: false });
    bot.onText(/^\/start(?:\s+([a-f0-9]{32}))?/, (msg, m) => onStart(msg, m && m[1]).catch((e) => console.error('[AE] start:', e.message)));
    bot.on('contact', (msg) => onContact(msg).catch((e) => console.error('[AE] contact:', e.message)));
    bot.getMe().then((me) => { botUsername = me.username; console.log(`🤖 [AE] @${botUsername} tayyor`); }).catch((e) => console.error('[AE] getMe:', e.message));
    const base = process.env.RENDER_EXTERNAL_URL || process.env.AE_PUBLIC_URL;
    if (base) {
      bot.setWebHook(`${base}/ae/webhook`, { secret_token: process.env.AE_WEBHOOK_SECRET || undefined })
        .then(() => console.log('🔗 [AE] webhook o\'rnatildi'))
        .catch((e) => console.error('[AE] setWebHook:', e.message));
    }
  }
  if (!serviceAccount) console.log('ℹ️  [AE] AE_FIREBASE_SA yo\'q — custom token yaratib bo\'lmaydi');
  app.use('/ae', router);
}

module.exports = { init, _test: { normalizePhone, isUzMobile, uidForPhone, sessions } };
