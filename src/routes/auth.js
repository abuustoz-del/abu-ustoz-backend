const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db/database');

// Flutter app uchun token olish (telegram_id yoki anonim)
router.post('/flutter-token', (req, res) => {
  console.log('[AUTH] POST /flutter-token, body:', JSON.stringify(req.body), 'headers:', req.headers['content-type']);
  const { telegram_id, name } = req.body;

  let user;
  if (telegram_id) {
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
    if (!user) {
      const result = db.prepare('INSERT INTO users (telegram_id, name) VALUES (?, ?)').run(telegram_id, name || 'Foydalanuvchi');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }
  } else {
    // Anonim foydalanuvchi
    const result = db.prepare('INSERT INTO users (name) VALUES (?)').run(name || 'Mehmon');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  }

  const token = jwt.sign(
    { userId: user.id, telegramId: user.telegram_id },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  db.prepare('UPDATE users SET flutter_token = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?').run(token, user.id);

  res.json({ token, userId: user.id, name: user.name });
});

// Telegram verify sessiyasi boshlash
router.post('/verify-start', (req, res) => {
  const { flutter_token } = req.body;
  if (!flutter_token) return res.status(400).json({ error: 'flutter_token kerak' });

  // Eski sessiyani o'chirish
  db.prepare('DELETE FROM verify_sessions WHERE flutter_token = ?').run(flutter_token);

  // Yangi 6 belgili kod
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  db.prepare('INSERT INTO verify_sessions (code, flutter_token) VALUES (?, ?)').run(code, flutter_token);

  res.json({ code, bot_url: `https://t.me/abu_ustoz_bot?start=verify_${code}` });
});

// Verify holatini tekshirish (app har 2 soniyada so'raydi)
router.get('/verify-status', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code kerak' });

  const session = db.prepare('SELECT * FROM verify_sessions WHERE code = ?').get(code);
  if (!session) return res.status(404).json({ error: 'Sessiya topilmadi' });

  if (!session.verified) return res.json({ verified: false });

  res.json({
    verified: true,
    phone: session.phone,
    name: session.tg_name,
    telegram_id: session.telegram_id,
  });
});

// PRO xarid qilinganida Flutter app xabar yuboradi
router.post('/pro-purchase', (req, res) => {
  const { name, flutter_token, plan, phone, telegram_id } = req.body;
  if (!flutter_token || !plan) return res.status(400).json({ error: 'flutter_token va plan kerak' });

  try {
    db.prepare(`
      INSERT INTO pro_purchases (name, flutter_token, plan, phone, telegram_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(flutter_token) DO UPDATE SET
        plan = excluded.plan,
        phone = COALESCE(excluded.phone, phone),
        telegram_id = COALESCE(excluded.telegram_id, telegram_id),
        purchased_at = CURRENT_TIMESTAMP
    `).run(name || 'Noma\'lum', flutter_token, plan, phone || null, telegram_id || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
