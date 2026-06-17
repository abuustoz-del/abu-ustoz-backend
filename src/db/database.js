const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'abu_ustoz.db'));

// WAL mode - tezroq
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== JADVALLAR ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    name TEXT,
    username TEXT,
    flutter_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    video_url TEXT NOT NULL,
    video_file_id TEXT,
    order_num INTEGER UNIQUE NOT NULL,
    duration_seconds INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_option TEXT NOT NULL CHECK(correct_option IN ('A','B','C','D')),
    FOREIGN KEY (lesson_id) REFERENCES lessons(id)
  );

  CREATE TABLE IF NOT EXISTS user_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    lesson_id INTEGER NOT NULL,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked','watching','watched','testing','completed','failed')),
    wrong_count INTEGER DEFAULT 0,
    watch_started_at DATETIME,
    completed_at DATETIME,
    UNIQUE(user_id, lesson_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (lesson_id) REFERENCES lessons(id)
  );

  CREATE TABLE IF NOT EXISTS schematics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT,
    component_ids TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vision_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    image_path TEXT,
    ai_response TEXT,
    recommended_schematic_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pro_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    flutter_token TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL,
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ==================== SAMPLE DATA ====================

const lessonCount = db.prepare('SELECT COUNT(*) as c FROM lessons').get();
if (lessonCount.c === 0) {
  const insertLesson = db.prepare(`
    INSERT INTO lessons (title, description, video_url, order_num, duration_seconds)
    VALUES (?, ?, ?, ?, ?)
  `);

  const lessons = [
    ['Elektr asoslari: Tok va Kuchlanish', 'Elektr toki nima, kuchlanish, qarshilik haqida asosiy tushunchalar', 'https://t.me/c/placeholder/1', 1, 120],
    ['Simlar va ulanish usullari', 'Elektr simlarini to\'g\'ri ulash, izolatsiya, qisqa tutashuv', 'https://t.me/c/placeholder/2', 2, 150],
    ['Rozetka va kalitlar', 'Rozetka va kalit o\'rnatish, ulanish tartibi', 'https://t.me/c/placeholder/3', 3, 180],
    ['Zamin (Zazemlenie)', 'Zazemlenie nima, nima uchun kerak, qanday o\'rnatiladi', 'https://t.me/c/placeholder/4', 4, 120],
    ['UZO va Avtomat', 'Himoya qurilmalari: UZO, avtomat, diffavtomat farqi', 'https://t.me/c/placeholder/5', 5, 200],
  ];

  for (const l of lessons) insertLesson.run(...l);

  const insertQ = db.prepare(`
    INSERT INTO questions (lesson_id, question_text, option_a, option_b, option_c, option_d, correct_option)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const questions = [
    [1, 'Elektr toki nima?', 'Zaryadlarning tartibli harakati', 'Issiqlik energiyasi', 'Magnit maydoni', 'Nur energiyasi', 'A'],
    [1, 'Kuchlanish birligi qaysi?', 'Amper', 'Vatt', 'Volt', 'Om', 'C'],
    [1, 'Om qonuni: I = ?', 'U × R', 'U / R', 'R / U', 'U + R', 'B'],
    [2, 'Qaysi rang sim zamin uchun?', 'Qizil', 'Ko\'k', 'Sariq-yashil', 'Qora', 'C'],
    [2, 'Qisqa tutashuv nima?', 'Tok kuchining oshishi', 'Faza va nol to\'g\'ridan ulanishi', 'Kuchlanish kamayishi', 'Simning uzilib qolishi', 'B'],
    [3, 'Rozetkaga nechta sim ulanadi?', '1', '2', '3', '4', 'C'],
    [3, 'Kalit nima vazifani bajaradi?', 'Tok kuchini oshiradi', 'Zanjirni uzadi/ulaydi', 'Kuchlanishni kamaytiradi', 'Tok yo\'nalishini o\'zgartiradi', 'B'],
    [4, 'Zamin nima uchun kerak?', 'Tok kuchini oshirish', 'Insonni elektr urishidan himoya qilish', 'Kuchlanishni kamaytirish', 'Chiroqni yoqish', 'B'],
    [5, 'UZO nima?', 'Universal zamin o\'rnatgich', 'Utechka tokindan himoya qurilmasi', 'Ulash taxtasi', 'Uzatma o\'lchagich', 'B'],
  ];

  for (const q of questions) insertQ.run(...q);

  // Sxemalar
  const insertS = db.prepare(`
    INSERT INTO schematics (name, description, keywords, component_ids)
    VALUES (?, ?, ?, ?)
  `);

  const schematics = [
    ['Oddiy chiroq sxemasi', '1 kalit - 1 chiroq asosiy sxema', '["chiroq","kalit","lampa","switch"]', '["switch","lamp","wire"]'],
    ['Prohodnoj kalit sxemasi', 'Ikki joydan 1 chiroqni boshqarish', '["prohodnoj","tunel kalit","ikki kalit"]', '["switch_double","lamp","wire"]'],
    ['Rozetka sxemasi', 'Oddiy rozetka ulash', '["rozetka","rozetak","socket"]', '["socket","wire"]'],
    ['UZO sxemasi', 'UZO bilan himoyalangan sxema', '["uzo","rcd","himoya"]', '["rcd","switch","socket","wire"]'],
    ['Kartali kalit sxemasi', 'Karta kiritilganda chiroq yonadi', '["kartali","kalit","key switch"]', '["switch_card","lamp","wire"]'],
  ];

  for (const s of schematics) insertS.run(...s);

  console.log('✅ Sample data inserted');
}

// ==================== VIDEO FILE_ID YUKLASH ====================
// 1-usul: Render environment variables dan (VIDEO_1, VIDEO_2, ...)
//         Bu DOIMIY — Render restart bo'lsa ham saqlanadi
let envCount = 0;
for (let i = 1; i <= 20; i++) {
  const fileId = process.env[`VIDEO_${i}`];
  if (fileId && fileId.trim()) {
    db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(fileId.trim(), i);
    envCount++;
  }
}
if (envCount > 0) console.log(`✅ ${envCount} ta video ENV dan yuklandi (VIDEO_1...VIDEO_${envCount})`);

// 2-usul: file_ids.json dan (agar ENV da yo'q bo'lsa)
try {
  const fPath = path.join(__dirname, '../../file_ids.json');
  if (fs.existsSync(fPath)) {
    const saved = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    let jsonCount = 0;
    for (const [orderNum, fileId] of Object.entries(saved)) {
      const n = parseInt(orderNum);
      // Faqat ENV da yo'q bo'lsa JSON dan olamiz
      if (!process.env[`VIDEO_${n}`]) {
        db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(fileId, n);
        jsonCount++;
      }
    }
    if (jsonCount > 0) console.log(`✅ ${jsonCount} ta video JSON dan yuklandi`);
  }
} catch (e) {
  console.log('file_ids.json yuklanmadi:', e.message);
}

module.exports = db;
