const TelegramBot = require('node-telegram-bot-api');
const db = require('../db/database');

// ==================== DOIMIY VIDEO FILE_IDS ====================
// Eng ishonchli usul: Render → Environment → Add Variable
//   VIDEO_1 = BAACAgI...   (1-dars file_id)
//   VIDEO_2 = BAACAgI...   (2-dars file_id)
//   VIDEO_3 = BAACAgI...   (3-dars file_id)
// Deploy bo'lsa ham yo'qolmaydi!
//
// Qo'shimcha zaxira — kod ichida (ENV dan ustun EMAS):
const HARDCODED_VIDEO_IDS = {
  1: 'BAACAgIAAxkBAAO9ajeoa8E85SjL1UHllL2zbP4m-AEAAraYAALM28FJyKOH9tTPt0g8BA',
  2: 'BAACAgIAAxkBAAPHajfLlrmVIf9EgN901kC23YSuPKAAAlegAAI2rLlJiMGjUkI5PJ08BA',
  3: 'BAACAgIAAxkBAAPJajfL0tw582hW66I2jsTucykUZN0AAlugAAI2rLlJuTWnRgmXrN48BA',
};

// DB ga yuklash (server ishga tushganda)
function loadHardcodedVideos() {
  let count = 0;

  // 1. RENDER ENV (VIDEO_1, VIDEO_2, ...) — eng ishonchli, deploy da saqlanadi
  for (let i = 1; i <= 20; i++) {
    const envId = process.env[`VIDEO_${i}`];
    if (envId && envId.length > 20) {
      db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(envId, i);
      count++;
      console.log(`✅ VIDEO_${i} ENV dan yuklandi`);
    }
  }

  // 2. HARDCODED_VIDEO_IDS — faqat ENV da bo'lmasa
  for (const [orderNum, fileId] of Object.entries(HARDCODED_VIDEO_IDS)) {
    if (fileId && fileId.length > 20 && !process.env[`VIDEO_${orderNum}`]) {
      db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(fileId, parseInt(orderNum));
      count++;
    }
  }

  // 3. file_ids.json — zaxira (Render restart da yo'qoladi, lekin qo'shimcha himoya)
  try {
    const fs2 = require('fs'), path2 = require('path');
    const fPath = path2.join(__dirname, '../../file_ids.json');
    const saved = JSON.parse(fs2.readFileSync(fPath, 'utf8'));
    for (const [num, fileId] of Object.entries(saved)) {
      if (fileId && fileId.length > 20 && !process.env[`VIDEO_${num}`]) {
        db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(fileId, parseInt(num));
        count++;
      }
    }
  } catch {}

  console.log(`📹 Jami ${count} ta video yuklandi (ENV + hardcoded + json)`);
}

let bot = null;

function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token_here') {
    console.log('⚠️  Telegram bot token yo\'q — bot ishlamaydi');
    return null;
  }

  // Webhook mode — polling yo'q, Express /webhook route orqali update keladi
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  console.log('✅ Telegram bot ishga tushdi (webhook mode)');

  // Hardcoded videolarni DB ga yuklash
  loadHardcodedVideos();

  // ==================== /start ====================
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const name = msg.from.first_name || 'Foydalanuvchi';
    const param = match ? match[1] : null;

    // === TELEGRAM VERIFY (ilova login) ===
    if (param && param.startsWith('verify_')) {
      const code = param.replace('verify_', '').toUpperCase();
      const session = db.prepare('SELECT * FROM verify_sessions WHERE code = ?').get(code);

      if (!session) {
        await bot.sendMessage(chatId, '❌ Kod noto\'g\'ri yoki muddati o\'tgan. Ilovadan qayta urinib ko\'ring.');
        return;
      }

      if (session.verified) {
        await bot.sendMessage(chatId, '✅ Siz allaqachon tasdiqlangansiz! Ilovaga qayting.');
        return;
      }

      // Telefon raqam so'rash
      await bot.sendMessage(chatId,
        `👋 Assalomu alaykum, ${name}!\n\n` +
        `📱 *Abu-Ustoz* ilovasiga kirish uchun\n` +
        `telefon raqamingizni tasdiqlang:\n\n` +
        `⬇️ Pastdagi tugmani bosing`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{ text: '📱 Telefon raqamni ulashish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          }
        }
      );

      // Kodni vaqtinchalik saqlash (telegram_id bilan bog'lash)
      db.prepare('UPDATE verify_sessions SET telegram_id = ? WHERE code = ?').run(telegramId, code);
      return;
    }

    // === ODDIY /start ===
    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user) {
      const r = db.prepare('INSERT INTO users (telegram_id, name, username) VALUES (?, ?, ?)').run(
        telegramId, name, msg.from.username || null
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);

      const firstLesson = db.prepare('SELECT * FROM lessons WHERE order_num = 1 AND is_active = 1').get();
      if (firstLesson) {
        db.prepare(`INSERT OR IGNORE INTO user_progress (user_id, lesson_id, status) VALUES (?, ?, 'locked')`).run(user.id, firstLesson.id);
      }
    }

    db.prepare('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    await bot.sendMessage(chatId,
      `👋 Assalomu alaykum, ${name}!\n\n` +
      `🎓 *Abu-Ustoz O'quv Bot*ga xush kelibsiz!\n\n` +
      `Bu bot orqali siz:\n` +
      `✅ Elektr montaj video darslarini ko'rasiz\n` +
      `✅ Har bir darsdan keyin test topshirasiz\n` +
      `✅ Bilimingizni bosqichma-bosqich oshirasiz\n\n` +
      `Boshlash uchun /darslar ni bosing`,
      { parse_mode: 'Markdown' }
    );
  });

  // === TELEFON RAQAM QABUL QILISH (verify uchun) ===
  bot.on('message', async (msg) => {
    if (!msg.contact) return;
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const contact = msg.contact;

    // Faqat o'z raqamini yuborgan bo'lsin
    if (String(contact.user_id) !== telegramId) {
      await bot.sendMessage(chatId, '❌ Faqat o\'z raqamingizni yuboring!');
      return;
    }

    const phone = contact.phone_number.startsWith('+') ? contact.phone_number : '+' + contact.phone_number;
    const tgName = (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '');

    // Bu telegram_id ga tegishli verify sessiyasini topish
    const session = db.prepare('SELECT * FROM verify_sessions WHERE telegram_id = ? AND verified = 0 ORDER BY created_at DESC LIMIT 1').get(telegramId);

    if (!session) {
      await bot.sendMessage(chatId, '❌ Faol sessiya topilmadi. Ilovadan qayta urinib ko\'ring.', {
        reply_markup: { remove_keyboard: true }
      });
      return;
    }

    // Tasdiqlash
    db.prepare('UPDATE verify_sessions SET verified = 1, phone = ?, tg_name = ? WHERE id = ?').run(phone, tgName, session.id);

    await bot.sendMessage(chatId,
      `✅ *Muvaffaqiyatli tasdiqlandi!*\n\n` +
      `👤 Ism: ${tgName}\n` +
      `📱 Raqam: ${phone}\n\n` +
      `🎓 Ilovaga qayting — avtomatik kiradi!`,
      {
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true }
      }
    );
  });

  // ==================== /darslar ====================
  bot.onText(/\/darslar/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUserByTgId(msg.from.id);
    if (!user) { await bot.sendMessage(chatId, 'Avval /start bosing'); return; }

    // Birinchi videoni to'g'ridan-to'g'ri yuborish
    await sendLessonVideo(chatId, user, 1);
  });

  // ==================== ADMIN VIDEO HANDLER ====================
  // Admin video yuborganda file_id va dars raqamini ko'rsatadi
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '2107969128';

  bot.on('video', async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const fileId = msg.video.file_id;
    const caption = msg.caption || '';
    const numMatch = caption.match(/\d+/);

    // Caption da raqam yo'q — faqat qabul qilindi deb ayt
    if (!numMatch) {
      const lessons = db.prepare('SELECT order_num, title FROM lessons WHERE is_active = 1 ORDER BY order_num').all();
      const list = lessons.map(l => `${l.order_num}. ${l.title}`).join('\n');
      await bot.sendMessage(ADMIN_ID,
        `📹 Video qabul qilindi!\n\n` +
        `Qaysi darsga ulash kerak?\n` +
        `Videoni qayta yuboring, caption ga FAQAT RAQAM yozing:\n\n` +
        `${list}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Caption da raqam bor — avtomatik ulash
    const orderNum = parseInt(numMatch[0]);
    const lesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum);

    if (!lesson) {
      await bot.sendMessage(ADMIN_ID, `❌ ${orderNum}-dars topilmadi!`);
      return;
    }

    // Caption da raqamdan keyin nom bor bo'lsa — uni ham yangilaymiz
    // Masalan: "6 Щit montaji - amaliy dars"
    const customTitle = caption.replace(/^\d+\s*/, '').trim();
    if (customTitle.length > 2) {
      db.prepare('UPDATE lessons SET title = ? WHERE order_num = ?').run(customTitle, orderNum);
    }

    // DB ga saqlash
    db.prepare('UPDATE lessons SET video_file_id = ? WHERE order_num = ?').run(fileId, orderNum);

    // file_ids.json ga saqlaymiz (Render restart fallback)
    try {
      const fs2 = require('fs');
      const path2 = require('path');
      const fPath = path2.join(__dirname, '../../file_ids.json');
      let saved = {};
      try { saved = JSON.parse(fs2.readFileSync(fPath, 'utf8')); } catch {}
      saved[orderNum] = fileId;
      fs2.writeFileSync(fPath, JSON.stringify(saved, null, 2));
    } catch(e) {}

    await bot.sendMessage(ADMIN_ID,
      `✅ <b>${orderNum}-dars video ulandi!</b>\n\n` +
      `📚 ${lesson.title}\n` +
      `🎬 Video hoziroq foydalanuvchilarga ko'rinadi!\n\n` +
      `⚠️ <b>MUHIM — Doimiy saqlash uchun:</b>\n` +
      `Render → abu-ustoz-backend → Environment\n` +
      `Key: <code>VIDEO_${orderNum}</code>\n` +
      `Value: <code>${fileId}</code>`,
      { parse_mode: 'HTML' }
    );
  });

  // /setvideo komandasi: /setvideo 1 BAACAgI...
  bot.onText(/\/setvideo (\d+) (.+)/, async (msg, match) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const orderNum = parseInt(match[1]);
    // "file_id: BAAC..." yoki "BAAC..." ikkalasini ham qabul qilish
    const fileId = match[2].trim().replace(/^file_id:\s*/i, '');

    const lesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum);
    if (!lesson) {
      await bot.sendMessage(ADMIN_ID, `❌ ${orderNum}-dars topilmadi!`);
      return;
    }

    db.prepare('UPDATE lessons SET video_file_id = ? WHERE id = ?').run(fileId, lesson.id);

    // file_ids.json ga saqlaymiz (Render restart fallback)
    try {
      const fs = require('fs');
      const path = require('path');
      const fPath = path.join(__dirname, '../../file_ids.json');
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch {}
      saved[orderNum] = fileId;
      fs.writeFileSync(fPath, JSON.stringify(saved, null, 2));
    } catch(e) {}

    await bot.sendMessage(ADMIN_ID,
      `✅ <b>${orderNum}-dars video ulandi!</b>\n` +
      `📚 ${lesson.title}\n\n` +
      `⚠️ <b>MUHIM — Doimiy saqlash uchun:</b>\n` +
      `Render → abu-ustoz-backend → Environment\n` +
      `Key: <code>VIDEO_${orderNum}</code>\n` +
      `Value: <code>${fileId}</code>\n\n` +
      `📋 Barcha darslar: /darslar_admin`,
      { parse_mode: 'HTML' }
    );
  });

  // /darslar_admin - barcha darslarni video holati bilan ko'rish
  bot.onText(/\/darslar_admin/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const lessons = db.prepare('SELECT order_num, title, video_file_id FROM lessons WHERE is_active = 1 ORDER BY order_num').all();
    const list = lessons.map(l => {
      const hasEnv = !!process.env[`VIDEO_${l.order_num}`];
      const hasDb  = !!l.video_file_id;
      const icon = hasDb ? '✅' : '❌';
      const envTag = hasEnv ? ' [ENV✓]' : ' [ENV❌]';
      return `${icon} ${l.order_num}. ${l.title}${envTag}`;
    }).join('\n');
    await bot.sendMessage(ADMIN_ID,
      `📚 <b>Darslar holati:</b>\n\n${list}\n\n` +
      `✅ = video bor | ENV✓ = Render'da doimiy saqlangan\n` +
      `ENV❌ = Render restart bo'lsa yo'qoladi!`,
      { parse_mode: 'HTML' }
    );
  });

  // /pro_users - PRO foydalanuvchilar ro'yxati (faqat admin)
  bot.onText(/\/pro_users/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const total = db.prepare('SELECT COUNT(*) as c FROM pro_purchases').get();
    const plan6 = db.prepare("SELECT COUNT(*) as c FROM pro_purchases WHERE plan = '6-month'").get();
    const plan1  = db.prepare("SELECT COUNT(*) as c FROM pro_purchases WHERE plan = '1-year'").get();
    const recent = db.prepare('SELECT name, plan, purchased_at FROM pro_purchases ORDER BY purchased_at DESC LIMIT 10').all();

    const recentList = recent.map((r, i) => {
      const date = r.purchased_at ? r.purchased_at.split('T')[0] : '?';
      const planLabel = r.plan === '1-year' ? '1 yillik' : '6 oylik';
      const phone = r.phone || '📵 raqamsiz';
      return `${i + 1}. ${r.name} | ${phone} — ${planLabel} (${date})`;
    }).join('\n');

    await bot.sendMessage(ADMIN_ID,
      `📊 <b>PRO Foydalanuvchilar</b>\n\n` +
      `👥 Jami: <b>${total.c} ta</b>\n` +
      `📅 6 oylik: ${plan6.c} ta\n` +
      `🏆 1 yillik: ${plan1.c} ta\n\n` +
      `⏱ <b>Oxirgi 10 ta:</b>\n${recentList || 'Hali yo\'q'}\n\n` +
      `🎰 Qur\'a tashlash: /qura`,
      { parse_mode: 'HTML' }
    );
  });

  // /qura - tasodifiy g'olib tanlash (faqat admin)
  bot.onText(/\/qura/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const total = db.prepare('SELECT COUNT(*) as c FROM pro_purchases').get();
    if (total.c === 0) {
      await bot.sendMessage(ADMIN_ID, '❌ Hali PRO foydalanuvchi yo\'q!');
      return;
    }

    await bot.sendMessage(ADMIN_ID, `🎰 Qur'a boshlanmoqda... (${total.c} ta ishtirokchi)`);

    // 3 marta "tayyorlanish" effekti
    await new Promise(r => setTimeout(r, 1000));
    await bot.sendMessage(ADMIN_ID, '🔄 Aralashtirilyapdi...');
    await new Promise(r => setTimeout(r, 1500));
    await bot.sendMessage(ADMIN_ID, '⏳ Tanlanyapdi...');
    await new Promise(r => setTimeout(r, 1000));

    const winner = db.prepare('SELECT * FROM pro_purchases ORDER BY RANDOM() LIMIT 1').get();
    const date = winner.purchased_at ? winner.purchased_at.split('T')[0] : '?';
    const planLabel = winner.plan === '1-year' ? '1 yillik' : '6 oylik';

    const winnerPhone = winner.phone || '❌ Telefon raqam yo\'q (eski foydalanuvchi)';
    await bot.sendMessage(ADMIN_ID,
      `🏆 <b>G'OLIB ANIQLANDI!</b> 🚗\n\n` +
      `👤 Ism: <b>${winner.name}</b>\n` +
      `📱 Telefon: <b>${winnerPhone}</b>\n` +
      `💳 Tarif: ${planLabel}\n` +
      `📅 PRO olgan: ${date}\n\n` +
      `🎉 Ushbu raqamga qo'ng'iroq qiling!`,
      { parse_mode: 'HTML' }
    );
  });

  // /add_test_pro - test uchun PRO foydalanuvchi qo'shish (faqat admin)
  bot.onText(/\/add_test_pro(?:\s+(.+))?/, async (msg, match) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const name = match[1] || 'Test Foydalanuvchi';
    const fakeToken = 'test_' + Date.now();
    const plan = Math.random() > 0.5 ? '1-year' : '6-month';
    db.prepare(`
      INSERT INTO pro_purchases (name, flutter_token, plan)
      VALUES (?, ?, ?)
    `).run(name, fakeToken, plan);
    const total = db.prepare('SELECT COUNT(*) as c FROM pro_purchases').get();
    await bot.sendMessage(ADMIN_ID,
      `✅ Test PRO qo'shildi!\n` +
      `👤 Ism: ${name}\n` +
      `💳 Tarif: ${plan}\n` +
      `👥 Jami PRO: ${total.c} ta\n\n` +
      `Tekshirish: /pro_users`,
      { parse_mode: 'HTML' }
    );
  });

  // /getids - DB dagi barcha video file_id larini ko'rsatish (admin uchun)
  bot.onText(/\/getids/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const lessons = db.prepare('SELECT order_num, title, video_file_id FROM lessons WHERE is_active = 1 ORDER BY order_num').all();
    let text = '📋 <b>Video File IDlar (Render ENV uchun):</b>\n\n';
    for (const l of lessons) {
      const envId = process.env[`VIDEO_${l.order_num}`];
      if (l.video_file_id) {
        text += `✅ <b>${l.order_num}-dars:</b> ${l.title}\n`;
        text += `Key: <code>VIDEO_${l.order_num}</code>\n`;
        text += `Value: <code>${l.video_file_id}</code>\n`;
        if (envId) text += `[ENV da saqlangan ✅]\n`;
        else text += `[ENV da YO'Q ⚠️ — Render ga qo'shing!]\n`;
        text += '\n';
      } else {
        text += `❌ <b>${l.order_num}-dars:</b> ${l.title} — video yo'q\n\n`;
      }
    }
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML' });
  });

  // /resetme - foydalanuvchi o'z progressini tozalaydi (test uchun)
  bot.onText(/\/resetme/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUserByTgId(msg.from.id);
    if (!user) { await bot.sendMessage(chatId, 'Avval /start bosing'); return; }
    db.prepare('DELETE FROM user_progress WHERE user_id = ?').run(user.id);
    await bot.sendMessage(chatId, '🔄 Progressingiz tozalandi. /darslar bosing.');
  });

  // ==================== CALLBACK HANDLER ====================
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = getUserByTgId(query.from.id);

    if (!user) { await bot.answerCallbackQuery(query.id, { text: 'Avval /start bosing' }); return; }

    // lesson:start:ID
    if (data.startsWith('lesson:start:')) {
      const lessonId = parseInt(data.split(':')[2]);
      await handleStartLesson(chatId, user, lessonId, query);
    }

    // lesson:watched:ID
    else if (data.startsWith('lesson:watched:')) {
      const lessonId = parseInt(data.split(':')[2]);
      await handleLessonWatched(chatId, user, lessonId, query);
    }

    // next_video:ORDER_NUM
    else if (data.startsWith('next_video:')) {
      const orderNum = parseInt(data.split(':')[1]);
      const prevLesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum - 1);

      if (prevLesson) {
        const prevProgress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, prevLesson.id);
        const startedAt = prevProgress && prevProgress.watch_started_at ? new Date(prevProgress.watch_started_at + ' UTC') : null;
        const now = new Date();
        const diffMs = startedAt ? now - startedAt : Infinity;
        const diffMin = diffMs / 1000 / 60;
        const WAIT_MIN = 10;

        if (diffMin < WAIT_MIN) {
          const remaining = Math.ceil(WAIT_MIN - diffMin);
          await bot.answerCallbackQuery(query.id, {
            text: `⏳ Yana ${remaining} daqiqa kuting!`,
            show_alert: true
          });
          return;
        }
      }

      await bot.answerCallbackQuery(query.id);
      await sendLessonVideo(chatId, user, orderNum);
      return;
    }

    // quiz:answer:LESSONID:QUESTIONID:OPTION
    else if (data.startsWith('quiz:answer:')) {
      const parts = data.split(':');
      const lessonId = parseInt(parts[2]);
      const questionId = parseInt(parts[3]);
      const option = parts[4];
      await handleQuizAnswer(chatId, user, lessonId, questionId, option, query);
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  });

  return bot;
}

// ==================== HELPERS ====================

function getUserByTgId(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

async function sendLessonVideo(chatId, user, orderNum) {
  const lesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum);
  if (!lesson) {
    await bot.sendMessage(chatId, `✅ Barcha darslar tugadi! Siz elektr muhandisi bo'ldingiz! 🏆`);
    return;
  }

  // Progress yozish / yangilash
  const existing = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lesson.id);
  if (!existing) {
    db.prepare('INSERT INTO user_progress (user_id, lesson_id, status, watch_started_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(user.id, lesson.id, 'watching');
  } else {
    db.prepare('UPDATE user_progress SET status = ?, watch_started_at = CURRENT_TIMESTAMP WHERE user_id = ? AND lesson_id = ?').run('watching', user.id, lesson.id);
  }

  // Keyingi dars bormi?
  const nextLesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum + 1);
  const inlineKeyboard = nextLesson
    ? [[{ text: `▶️ ${orderNum + 1}-video bu yerda`, callback_data: `next_video:${orderNum + 1}` }]]
    : [];

  // Video yuborish
  if (lesson.video_file_id) {
    await bot.sendVideo(chatId, lesson.video_file_id, {
      caption: `📹 ${orderNum}-dars: ${lesson.title}`,
      reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
    });
  } else {
    await bot.sendMessage(chatId,
      `📹 *${orderNum}-dars: ${lesson.title}*\n\n🔗 ${lesson.video_url}\n\n_(Video tez orada yuklanadi)_`,
      {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
      }
    );
  }
}

async function handleStartLesson(chatId, user, lessonId, query) {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;

  // Progress tekshirish
  let progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lessonId);

  if (!progress) {
    db.prepare('INSERT INTO user_progress (user_id, lesson_id, status, watch_started_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(user.id, lessonId, 'watching');
    progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lessonId);
  } else if (progress.status === 'completed') {
    await bot.sendMessage(chatId, `✅ Bu darsni allaqachon tugatgansiz!\n\n/darslar ga qayting`);
    return;
  } else {
    db.prepare('UPDATE user_progress SET status = ?, watch_started_at = CURRENT_TIMESTAMP WHERE user_id = ? AND lesson_id = ?').run('watching', user.id, lessonId);
  }

  // Video yuborish
  await bot.sendMessage(chatId,
    `🎬 *${lesson.title}*\n\n${lesson.description || ''}\n\n📌 Videoni diqqat bilan ko'ring. Tugagandan so'ng test topshirasiz.`,
    { parse_mode: 'Markdown' }
  );

  // Video fayl ID bor bo'lsa — video yuboramiz, aks holda link
  if (lesson.video_file_id) {
    await bot.sendVideo(chatId, lesson.video_file_id, {
      caption: `📹 ${lesson.title}`
    });
  } else {
    await bot.sendMessage(chatId, `🔗 Video: ${lesson.video_url}\n\n_(Video tez orada yuklanadi)_`, { parse_mode: 'Markdown' });
  }

  // Kechikish: dars davomiyligining 50% yoki min 30 sekund
  const delay = Math.max(30, Math.floor(lesson.duration_seconds * 0.5)) * 1000;

  // "Ko'rdim" tugmasi DISABLED holda yuboriladi
  const disabledMsg = await bot.sendMessage(chatId,
    `⏳ Video ko'rilgandan keyin tugma faollashadi...`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '⏳ Kuting...', callback_data: 'disabled' }]]
      }
    }
  );

  // Kechikishdan keyin tugmani faollashtirish
  setTimeout(async () => {
    try {
      await bot.editMessageText(`✅ Video ko'rdingizmi? Test topshirishga tayyormisiz?`, {
        chat_id: chatId,
        message_id: disabledMsg.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Ko\'rdim, testni boshlash!', callback_data: `lesson:watched:${lessonId}` }]]
        }
      });
    } catch (e) {
      // Xabar o'chirilgan bo'lishi mumkin
    }
  }, delay);
}

async function handleLessonWatched(chatId, user, lessonId, query) {
  db.prepare('UPDATE user_progress SET status = ? WHERE user_id = ? AND lesson_id = ?').run('testing', user.id, lessonId);
  await sendNextQuestion(chatId, user, lessonId, 0);
}

async function sendNextQuestion(chatId, user, lessonId, questionIndex) {
  const questions = db.prepare('SELECT * FROM questions WHERE lesson_id = ? ORDER BY id').all(lessonId);

  if (questionIndex >= questions.length) {
    // Barcha savollar to'g'ri javoblangan
    await completedLesson(chatId, user, lessonId);
    return;
  }

  const q = questions[questionIndex];
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  const progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lessonId);

  await bot.sendMessage(chatId,
    `📝 *Savol ${questionIndex + 1}/${questions.length}*\n` +
    `📚 ${lesson.title}\n` +
    `❌ Xatolar: ${progress.wrong_count}/3\n\n` +
    `❓ ${q.question_text}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🅰️ ${q.option_a}`, callback_data: `quiz:answer:${lessonId}:${q.id}:A` }],
          [{ text: `🅱️ ${q.option_b}`, callback_data: `quiz:answer:${lessonId}:${q.id}:B` }],
          [{ text: `🅲 ${q.option_c}`, callback_data: `quiz:answer:${lessonId}:${q.id}:C` }],
          [{ text: `🅳 ${q.option_d}`, callback_data: `quiz:answer:${lessonId}:${q.id}:D` }],
        ]
      }
    }
  );
}

async function handleQuizAnswer(chatId, user, lessonId, questionId, selectedOption, query) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  const questions = db.prepare('SELECT * FROM questions WHERE lesson_id = ? ORDER BY id').all(lessonId);
  const qIndex = questions.findIndex(x => x.id === questionId);

  let progress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lessonId);

  if (selectedOption === q.correct_option) {
    // To'g'ri javob
    await bot.sendMessage(chatId, `✅ *To'g'ri!* Ajoyib!\n\n💡 ${getAnswerExplanation(q)}`, { parse_mode: 'Markdown' });

    // Keyingi savol
    setTimeout(() => sendNextQuestion(chatId, user, lessonId, qIndex + 1), 1500);

  } else {
    // Noto'g'ri javob
    const wrongCount = (progress.wrong_count || 0) + 1;
    db.prepare('UPDATE user_progress SET wrong_count = ? WHERE user_id = ? AND lesson_id = ?').run(wrongCount, user.id, lessonId);

    const optionTexts = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };

    if (wrongCount >= 3) {
      // 3 xato — videoni qayta yuborish
      db.prepare('UPDATE user_progress SET wrong_count = 0, status = ? WHERE user_id = ? AND lesson_id = ?').run('watching', user.id, lessonId);

      await bot.sendMessage(chatId,
        `❌ *Noto'g'ri!* (${wrongCount}/3 xato)\n\n` +
        `To'g'ri javob: *${q.correct_option}) ${optionTexts[q.correct_option]}*\n\n` +
        `⚠️ 3 ta xato qildingiz. Video qaytadan ko'ring!`,
        { parse_mode: 'Markdown' }
      );

      setTimeout(() => handleStartLesson(chatId, user, lessonId, null), 2000);

    } else {
      await bot.sendMessage(chatId,
        `❌ *Noto'g'ri!* (${wrongCount}/3 xato)\n\n` +
        `Qayta urinib ko'ring...`,
        { parse_mode: 'Markdown' }
      );

      setTimeout(() => sendNextQuestion(chatId, user, lessonId, qIndex), 1500);
    }
  }
}

async function completedLesson(chatId, user, lessonId) {
  db.prepare('UPDATE user_progress SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND lesson_id = ?').run('completed', user.id, lessonId);

  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  const nextLesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(lesson.order_num + 1);

  await bot.sendMessage(chatId,
    `🎉 *Tabriklaymiz!*\n\n` +
    `✅ "${lesson.title}" darsini muvaffaqiyatli tugatdingiz!\n\n` +
    (nextLesson ? `🔓 Keyingi dars ochildi: *${nextLesson.title}*\n\n/darslar` : `🏆 Barcha darslarni tugatdingiz! Siz elektr muhandisi!`),
    { parse_mode: 'Markdown' }
  );

  // Keyingi darsni ochish
  if (nextLesson) {
    db.prepare('INSERT OR IGNORE INTO user_progress (user_id, lesson_id, status) VALUES (?, ?, ?)').run(user.id, nextLesson.id, 'locked');
    db.prepare('UPDATE user_progress SET status = ? WHERE user_id = ? AND lesson_id = ? AND status = ?').run('locked', user.id, nextLesson.id, 'locked');
    // Aslida status ni ochiq qilish:
    db.prepare('UPDATE user_progress SET status = ? WHERE user_id = ? AND lesson_id = ?').run('watching', user.id, nextLesson.id);
  }
}

function getAnswerExplanation(q) {
  // Qisqa tushuntirish (keyinchalik kengaytirish mumkin)
  const optionTexts = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };
  return `To'g'ri javob: ${q.correct_option}) ${optionTexts[q.correct_option]}`;
}

function getBot() { return bot; }
module.exports = { initBot, getBot };
