const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Token orqali autentifikatsiya (oddiy — middleware ishlatmaymiz)
function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.replace('Bearer ', '').trim() || req.body?.flutter_token || '';
}

// POST /api/progress/push — Flutter → Server (progress yuklash)
router.post('/push', (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'token kerak' });

  const {
    completed_lessons = [],
    study_minutes = 0,
    lessons_completed = 0,
    schemes_built = 0,
    tests_passed = 0,
  } = req.body;

  try {
    // Mavjud progress bilan merge (max qiymat olish)
    const existing = db.prepare('SELECT * FROM user_cloud_progress WHERE flutter_token = ?').get(token);

    if (existing) {
      const existingLessons = JSON.parse(existing.completed_lessons || '[]');
      const mergedLessons = [...new Set([...existingLessons, ...completed_lessons])];

      db.prepare(`
        UPDATE user_cloud_progress SET
          completed_lessons = ?,
          study_minutes = MAX(study_minutes, ?),
          lessons_completed = MAX(lessons_completed, ?),
          schemes_built = MAX(schemes_built, ?),
          tests_passed = MAX(tests_passed, ?),
          updated_at = CURRENT_TIMESTAMP
        WHERE flutter_token = ?
      `).run(
        JSON.stringify(mergedLessons),
        study_minutes, lessons_completed, schemes_built, tests_passed,
        token
      );
    } else {
      db.prepare(`
        INSERT INTO user_cloud_progress
          (flutter_token, completed_lessons, study_minutes, lessons_completed, schemes_built, tests_passed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(token, JSON.stringify(completed_lessons), study_minutes, lessons_completed, schemes_built, tests_passed);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/progress/pull — Server → Flutter (progress olish)
router.get('/pull', (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'token kerak' });

  const row = db.prepare('SELECT * FROM user_cloud_progress WHERE flutter_token = ?').get(token);
  if (!row) return res.json({ found: false });

  res.json({
    found: true,
    completed_lessons: JSON.parse(row.completed_lessons || '[]'),
    study_minutes: row.study_minutes || 0,
    lessons_completed: row.lessons_completed || 0,
    schemes_built: row.schemes_built || 0,
    tests_passed: row.tests_passed || 0,
    updated_at: row.updated_at,
  });
});

module.exports = router;
