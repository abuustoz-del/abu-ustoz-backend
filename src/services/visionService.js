const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const db = require('../db/database');

// Lazy init — env yuklanganidan keyin ishlatiladi
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `Sen elektr muhandisi yordamchisisisan. Foydalanuvchi yuborgan elektr asbob yoki qurilma rasmini tahlil qilasan.

Javobingni FAQAT quyidagi JSON formatda ber (boshqa hech narsa yozma):
{
  "device_name": "Asbob nomi (o'zbekcha)",
  "device_name_ru": "Название на русском",
  "category": "kalit|rozetka|lampa|himoya|o'lchov|kabel|boshqa",
  "function": "Bu asbob nima uchun ishlatiladi (1-2 gap)",
  "connection_steps": ["1-qadam", "2-qadam", "3-qadam"],
  "terminals": ["Terminal 1 nomi: vazifasi", "Terminal 2: vazifasi"],
  "safety_warning": "Xavfsizlik ogohlantirishлari",
  "confidence": 0.95,
  "search_keywords": ["kalit", "switch", "ikki pozisiyali"]
}

Agar rasm elektr asbobi EMAS bo'lsa:
{
  "error": "Bu elektr asbobi emas",
  "confidence": 0.0
}

MUHIM: Javob faqat JSON bo'lsin, boshqa matn yo'q.`;

async function analyzeImage(imagePath, userId = null) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const ext = imagePath.split('.').pop().toLowerCase();
  const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const mediaType = mediaTypeMap[ext] || 'image/jpeg';

  const response = await getClient().messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          {
            type: 'text',
            text: 'Bu elektr asbobni tahlil qil va JSON formatda javob ber.',
          },
        ],
      },
    ],
  });

  const rawText = response.content[0].text.trim();

  let parsed;
  try {
    // JSON extract (ba'zan ```json ``` bilan o'ralgan bo'lishi mumkin)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch (e) {
    parsed = { error: 'AI javobi tahlil qilinmadi', raw: rawText };
  }

  // Mos sxema topish
  let recommendedSchematic = null;
  if (!parsed.error && parsed.search_keywords?.length > 0) {
    recommendedSchematic = findMatchingSchematic(parsed.search_keywords);
  }

  // Log saqlash
  try {
    db.prepare(`
      INSERT INTO vision_logs (user_id, image_path, ai_response, recommended_schematic_id)
      VALUES (?, ?, ?, ?)
    `).run(userId, imagePath, JSON.stringify(parsed), recommendedSchematic?.id || null);
  } catch (e) {
    console.error('Log save error:', e.message);
  }

  return {
    analysis: parsed,
    schematic: recommendedSchematic,
    disclaimer: '⚠️ Diqqat: AI tahlili 100% to\'g\'ri bo\'lmasligi mumkin. Elektr ishlari paytida xavfsizlik qoidalariga rioya qiling va mutaxassis bilan maslahatlashing.',
  };
}

function findMatchingSchematic(keywords) {
  const schematics = db.prepare('SELECT * FROM schematics').all();

  let bestMatch = null;
  let bestScore = 0;

  for (const s of schematics) {
    let schemaKeywords = [];
    try { schemaKeywords = JSON.parse(s.keywords); } catch {}

    let score = 0;
    for (const kw of keywords) {
      for (const sk of schemaKeywords) {
        if (sk.toLowerCase().includes(kw.toLowerCase()) ||
            kw.toLowerCase().includes(sk.toLowerCase())) {
          score++;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = s;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

module.exports = { analyzeImage };
