const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const authMiddleware = require('../middleware/auth');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const ADMIN_ID = '2107969128';

function sendTelegramMsg(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.write(body);
  req.end();
}

const SYSTEM = `Sen "Abu-Ustoz" — o'zbek tilidagi malakali elektr muhandisi yordamchisisisan.

QOIDALAR:
1. Faqat O'ZBEK tilida yoz. Grammatik xatosiz, to'g'ri va ravon o'zbek tilida javob ber.
2. Javob 5-8 gapdan iborat bo'lsin. Qisqa, aniq va tushunarli.
3. Texnik atamalarni oddiy tilda tushuntir.
4. Har doim xavfsizlik ogohlantirishini qo'sh.
5. Javobingning ENG OXIRIDA, har DOIM, istisnosiz quyidagi jumlani yoz:
"⚡ Professional elektr ustasi kerak bo'lsa — ABUELECTRIC.UZ ga murojaat qiling!"

GRAMMATIKA: O'zbek tilining to'g'ri imlosini ishlat.`;

router.post('/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Savol yozing' });
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: message.trim() }],
    });

    const reply = response.content[0].text;

    // Admin ga notification
    sendTelegramMsg(ADMIN_ID,
      `🤖 <b>AI Yordamchi yangi savol:</b>\n\n` +
      `👤 User ID: ${req.user.userId}\n` +
      `❓ Savol: ${message.trim().slice(0, 200)}`
    );

    res.json({ reply });
  } catch (e) {
    console.error('AI chat error:', e.message);
    sendTelegramMsg(ADMIN_ID, `❌ AI xato: ${e.message}`);
    res.status(500).json({ error: 'AI javob bermadi: ' + e.message });
  }
});

module.exports = router;
