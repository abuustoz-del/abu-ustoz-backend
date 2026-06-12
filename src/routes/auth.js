const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db/database');

// Flutter app uchun token olish (telegram_id yoki anonim)
router.post('/flutter-token', (req, res) => {
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

module.exports = router;
