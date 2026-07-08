const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

// GET /api/lessons/count — DB dagi darslar soni (public, no auth)
router.get('/count', (req, res) => {
  const c = db.prepare('SELECT COUNT(*) as cnt FROM lessons').get();
  const list = db.prepare('SELECT order_num, title FROM lessons ORDER BY order_num').all();
  res.json({ count: c.cnt, lessons: list });
});

// GET /api/lessons — barcha darslar + foydalanuvchi progressi
router.get('/', authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const lessons = db.prepare('SELECT * FROM lessons WHERE is_active = 1 ORDER BY order_num').all();

  const result = lessons.map(lesson => {
    const progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(userId, lesson.id);
    return {
      ...lesson,
      status: progress?.status || 'locked',
      wrong_count: progress?.wrong_count || 0,
      completed_at: progress?.completed_at || null,
    };
  });

  res.json(result);
});

// GET /api/lessons/:id
router.get('/:id', authMiddleware, (req, res) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Dars topilmadi' });
  res.json(lesson);
});

// GET /api/lessons/:id/questions
router.get('/:id/questions', authMiddleware, (req, res) => {
  const questions = db.prepare('SELECT id, lesson_id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE lesson_id = ?').all(req.params.id);
  res.json(questions);
});

// POST /api/lessons/:id/answer — javob tekshirish
router.post('/:id/answer', authMiddleware, (req, res) => {
  const { questionId, selectedOption } = req.body;
  const userId = req.user.userId;
  const lessonId = parseInt(req.params.id);

  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  if (!q) return res.status(404).json({ error: 'Savol topilmadi' });

  const isCorrect = q.correct_option === selectedOption?.toUpperCase();
  const progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId);

  if (!isCorrect && progress) {
    const newWrongCount = (progress.wrong_count || 0) + 1;
    db.prepare('UPDATE user_progress SET wrong_count = ? WHERE user_id = ? AND lesson_id = ?').run(newWrongCount, userId, lessonId);

    if (newWrongCount >= 3) {
      db.prepare('UPDATE user_progress SET status = ?, wrong_count = 0 WHERE user_id = ? AND lesson_id = ?').run('watching', userId, lessonId);
      return res.json({ correct: false, wrong_count: newWrongCount, reset: true, message: '3 xato — qaytadan ko\'ring' });
    }

    return res.json({ correct: false, wrong_count: newWrongCount });
  }

  res.json({ correct: isCorrect, correct_option: q.correct_option });
});

module.exports = router;
