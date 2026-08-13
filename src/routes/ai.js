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

function buildSystem(langName, langCode) {
  const lang = (langName && langCode) ? `${langName} (${langCode})` : 'English (en)';
  return `You are "Abu-Ustoz" — a skilled electrical engineering assistant.

RULES:
1. Reply ONLY in this language: ${lang}. Write correct, fluent, grammatically accurate text in that language. Even if the user writes in another language, always answer in ${lang}.
2. Keep the answer to 5-8 sentences. Short, clear and understandable.
3. Explain technical terms in simple words.
4. Always include a safety warning.
5. At the VERY END of your answer, ALWAYS and without exception, write the following sentence translated into ${lang}, but keep "ABUELECTRIC.UZ" exactly as is:
"⚡ If you need a professional electrician — contact ABUELECTRIC.UZ!"`;
}

router.post('/chat', authMiddleware, async (req, res) => {
  const { message, lang, langName } = req.body;
  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Savol yozing' });
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystem(langName, lang),
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

function buildVisionSystem(langName, langCode) {
  const lang = (langName && langCode) ? `${langName} (${langCode})` : 'English (en)';
  return `You are "Abu-Ustoz" — an expert electrical engineer analyzing a photo of an electrical scheme, wiring, panel, or circuit that the user uploaded.

RULES:
1. Reply ONLY in this language: ${lang}. Write correct, fluent, grammatically accurate text in that language.
2. Look carefully at the image. Identify what it shows (wiring diagram, socket, breaker panel, connection, etc.).
3. If you see an ERROR or a dangerous/incorrect connection, clearly point out WHERE it is and WHY it is wrong, and how to fix it correctly.
4. If the connection looks correct, say so and briefly explain what it does.
5. Explain technical terms in simple words. Keep it to 6-10 sentences.
6. Always include a safety warning about electricity.
7. If the image is not related to electrical work, politely say you can only analyze electrical schemes/wiring.
8. At the VERY END of your answer, ALWAYS write this sentence translated into ${lang}, but keep "ABUELECTRIC.UZ" exactly as is:
"⚡ If you need a professional electrician — contact ABUELECTRIC.UZ!"`;
}

router.post('/vision', authMiddleware, async (req, res) => {
  const { image, mediaType, message, lang, langName } = req.body;
  if (!image || image.length < 100) {
    return res.status(400).json({ error: 'Rasm yuborilmadi' });
  }

  const mt = (mediaType || 'image/jpeg').toLowerCase();
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(mt)) {
    return res.status(400).json({ error: 'Rasm formati qo\'llab-quvvatlanmaydi' });
  }

  const userText = (message && message.trim().length >= 2)
    ? message.trim()
    : 'Bu rasmni tahlil qil. Agar xato bo\'lsa qayerdaligini va sababini tushuntir.';

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: buildVisionSystem(langName, lang),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mt, data: image } },
          { type: 'text', text: userText },
        ],
      }],
    });

    const reply = response.content[0].text;

    sendTelegramMsg(ADMIN_ID,
      `📷 <b>AI Ustoz rasm tahlili:</b>\n\n` +
      `👤 User ID: ${req.user.userId}\n` +
      `❓ Savol: ${userText.slice(0, 150)}`
    );

    res.json({ reply });
  } catch (e) {
    console.error('AI vision error:', e.message);
    sendTelegramMsg(ADMIN_ID, `❌ AI vision xato: ${e.message}`);
    res.status(500).json({ error: 'AI rasmni tahlil qila olmadi: ' + e.message });
  }
});

module.exports = router;
