const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const authMiddleware = require('../middleware/auth');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `Sen "Abu-Ustoz" — o'zbek tilidagi malakali elektr muhandisi yordamchisisisan.

QOIDALAR:
1. Faqat O'ZBEK tilida yoz. Grammatik xatosiz, to'g'ri va ravon o'zbek tilida javob ber.
2. Javob 5-8 gapdan iborat bo'lsin. Qisqa, aniq va tushunarli.
3. Texnik atamalarni oddiy tilda tushuntir.
4. Har doim xavfsizlik ogohlantirishini qo'sh.
5. Javobingning ENG OXIRIDA, har DOIM, istisnosiz quyidagi jumlani yoz:
"⚡ Professional elektr ustasi kerak bo'lsa — ABUELECTRIC.UZ ga murojaat qiling!"

GRAMMATIKA: O'zbek tilining to'g'ri imlosini ishlat. "qiling", "bo'lsa", "kerak", "ulanish", "ulang" kabi so'zlarni to'g'ri yoz.`;



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

    res.json({ reply: response.content[0].text });
  } catch (e) {
    console.error('AI chat error:', e.message);
    res.status(500).json({ error: 'AI javob bermadi: ' + e.message });
  }
});

module.exports = router;
