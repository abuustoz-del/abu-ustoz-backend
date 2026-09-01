// .env ni dotenvx ni bypass qilib qo'lda o'qiymiz
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

// MUHIM: bot sendMessage rad etilsa yoki boshqa async xato bo'lsa —
// server CRASH bo'lmasin. Aks holda bitta bloklagan foydalanuvchi
// butun backendni yiqitadi va hamma kira olmay qoladi.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ UnhandledRejection:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ UncaughtException:', (err && err.message) || err);
});

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors());
// Rasm (base64) yuborilganda katta bo'ladi — chegarani oshiramiz (default 100kb)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== ROUTES ====================
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/vision', require('./src/routes/vision'));
app.use('/api/lessons', require('./src/routes/lessons'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/progress', require('./src/routes/progress'));

// VAQTINCHALIK DIAGNOSTIKA: Google Play service account haqiqatan ishlayaptimi?
// (permission/config xatosi bo'lsa — bu HAMMA haqiqiy xaridlarni rad etishi mumkin edi)
app.get('/api/auth/_diag_google_play', async (req, res) => {
  const googlePlay = require('./src/services/googlePlay');
  const hasEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const r = await googlePlay.verifySubscription('diag_check_' + Date.now());
  res.json({ hasEnv, packageName: googlePlay.PACKAGE_NAME, result: r });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    version: '2.0-webhook',
    has_claude_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY?.slice(0, 15) || 'MISSING',
    has_bot_token: !!process.env.TELEGRAM_BOT_TOKEN,
  });
});

// ==================== TELEGRAM BOT ====================
const { initBot, getBot } = require('./src/services/telegramBot');
initBot();

// Webhook endpoint — Telegram xabarlarini qabul qilish
app.post('/webhook', (req, res) => {
  const bot = getBot();
  if (bot) {
    bot.processUpdate(req.body);
  }
  res.sendStatus(200);
});

// ==================== START ====================
// Eslatma: keep-alive va localtunnel olib tashlandi — Render Starter uxlamaydi,
// tunnel esa faqat lokal ishlab chiqish uchun kerak edi.
app.listen(PORT, () => {
  console.log(`\n🚀 Abu-Ustoz Backend ishga tushdi! Port: ${PORT}`);
});

module.exports = app;
