const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middleware/auth');
const { analyzeImage } = require('../services/visionService');

// Upload papka
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `vision_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Faqat rasm fayllari qabul qilinadi'));
  },
});

// POST /api/vision/analyze
router.post('/analyze', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Rasm yuklanmadi' });

  try {
    const result = await analyzeImage(req.file.path, req.user.userId);

    // Eski fayllarni o'chirish (1 soatdan eski)
    cleanOldUploads(uploadDir);

    res.json(result);
  } catch (err) {
    console.error('Vision error:', err.message);
    res.status(500).json({ error: 'AI tahlil xatosi: ' + err.message });
  }
});

// GET /api/vision/schematics - barcha sxemalar
router.get('/schematics', authMiddleware, (req, res) => {
  const db = require('../db/database');
  const schematics = db.prepare('SELECT * FROM schematics').all();
  res.json(schematics);
});

function cleanOldUploads(dir) {
  try {
    const files = fs.readdirSync(dir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const f of files) {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < oneHourAgo) fs.unlinkSync(fp);
    }
  } catch {}
}

module.exports = router;
