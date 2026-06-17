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

// PRO xarid qilinganida Flutter app xabar yuboradi
router.post('/pro-purchase', (req, res) => {
  const { name, flutter_token, plan } = req.body;
  if (!flutter_token || !plan) return res.status(400).json({ error: 'flutter_token va plan kerak' });

  try {
    db.prepare(`
      INSERT INTO pro_purchases (name, flutter_token, plan)
      VALUES (?, ?, ?)
      ON CONFLICT(flutter_token) DO UPDATE SET plan = excluded.plan, purchased_at = CURRENT_TIMESTAMP
    `).run(name || 'Noma\'lum', flutter_token, plan);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
