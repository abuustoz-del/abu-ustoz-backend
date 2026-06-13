const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const authMiddleware = require('../middleware/auth');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `Sen "Abu-Ustoz" — o'zbek tilidagi elektr muhandisi yordamchisisisan.
Foydalanuvchi elektr asboblar, ulanish sxemalari, ta'mirlash haqida savol beradi.
Javobingni QISQA va ANIQ yoz (5-10 gap). O'zbek tilida javob ber.
Xavfsizlik ogohlantirishini har doim qo'sh.
Har bir javobingni ALBATTA shu gap bilan tugat: "⚡ Professional elektr ustasi kerakmi? ABUELECTRIC.UZ ga murojaat qiling!"`;


router.post('/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Savol yozing' });
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: message.trim() }],
    });

    res.json({ reply: response.content[0].text });
  } catch (e) {
    console.error('AI chat error:', e.message);
    res.status(500).json({ error: 'AI javob bermadi: ' + e.message });
  }
});

module.exports = router;
