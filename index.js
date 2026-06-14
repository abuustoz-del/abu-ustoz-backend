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

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== ROUTES ====================
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/vision', require('./src/routes/vision'));
app.use('/api/lessons', require('./src/routes/lessons'));
app.use('/api/ai', require('./src/routes/ai'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    version: '1.0.0',
    has_claude_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY?.slice(0, 15) || 'MISSING',
    has_bot_token: !!process.env.TELEGRAM_BOT_TOKEN,
  });
});

// ==================== TELEGRAM BOT ====================
const { initBot } = require('./src/services/telegramBot');
initBot();

// ==================== START ====================
app.listen(PORT, async () => {
  console.log(`\n🚀 Abu-Ustoz Backend v2 ishga tushdi!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);

  // Localtunnel - internet orqali kirish
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: PORT });
    console.log(`\n🌐 PUBLIC URL: ${tunnel.url}`);
    console.log(`📱 Flutter kBackendUrl ni shu URL ga o'zgartiring!\n`);
    tunnel.on('error', () => {});
    tunnel.on('close', () => console.log('Tunnel yopildi'));
  } catch(e) {
    console.log('Tunnel ishlamadi:', e.message);
  }
});

module.exports = app;
