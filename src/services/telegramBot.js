const TelegramBot = require('node-telegram-bot-api');
const db = require('../db/database');

let bot = null;

function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token_here') {
    console.log('⚠️  Telegram bot token yo\'q — bot ishlamaydi');
    return null;
  }

  // Webhook mode — polling yo'q, Express /webhook route orqali update keladi
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  console.log('✅ Telegram bot ishga tushdi (webhook mode)');

  // ==================== /start ====================
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const name = msg.from.first_name || 'Foydalanuvchi';

    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user) {
      const r = db.prepare('INSERT INTO users (telegram_id, name, username) VALUES (?, ?, ?)').run(
        telegramId, name, msg.from.username || null
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);

      // Birinchi darsni ochish
      const firstLesson = db.prepare('SELECT * FROM lessons WHERE order_num = 1 AND is_active = 1').get();
      if (firstLesson) {
        db.prepare(`
          INSERT OR IGNORE INTO user_progress (user_id, lesson_id, status)
          VALUES (?, ?, 'locked')
        `).run(user.id, firstLesson.id);
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
  const ADMIN_ID = '2107969128';

  bot.on('video', async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return; // Faqat admin uchun
    const fileId = msg.video.file_id;
    const duration = msg.video.duration;
    const caption = msg.caption || '';

    // Dars raqamini caption dan olish (masalan: "1" yoki "dars 3")
    const num = caption.match(/\d+/)?.[0] || '?';

    // Bazadagi darslarni ko'rsatish
    const lessons = db.prepare('SELECT id, order_num, title FROM lessons WHERE is_active = 1 ORDER BY order_num').all();
    let lessonsList = lessons.map(l =>
      `${l.order_num}. ${l.title} (id=${l.id})${l.order_num == num ? ' ← BU DARS' : ''}`
    ).join('\n');

    await bot.sendMessage(ADMIN_ID,
      `📹 <b>Video qabul qilindi!</b>\n\n` +
      `🔑 <code>file_id: ${fileId}</code>\n` +
      `⏱ Davomiylik: ${duration} sek\n\n` +
      `📚 Darslar:\n${lessonsList}\n\n` +
      `✅ Ulash uchun:\n<code>/setvideo ${num} ${fileId}</code>`,
      { parse_mode: 'HTML' }
    );
  });

  // /setvideo komandasi: /setvideo 1 BAACAgI...
  bot.onText(/\/setvideo (\d+) (.+)/, async (msg, match) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const orderNum = parseInt(match[1]);
    const fileId = match[2].trim();

    const lesson = db.prepare('SELECT * FROM lessons WHERE order_num = ? AND is_active = 1').get(orderNum);
    if (!lesson) {
      await bot.sendMessage(ADMIN_ID, `❌ ${orderNum}-dars topilmadi!`);
      return;
    }

    db.prepare('UPDATE lessons SET video_file_id = ? WHERE id = ?').run(fileId, lesson.id);

    // file_ids.json ga ham saqlaymiz (Render restart bo'lsa qayta yuklanadi)
    const fs = require('fs');
    const path = require('path');
    const fPath = path.join(__dirname, '../../file_ids.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch {}
    saved[orderNum] = fileId;
    fs.writeFileSync(fPath, JSON.stringify(saved, null, 2));

    await bot.sendMessage(ADMIN_ID,
      `✅ <b>${orderNum}-dars yangilandi!</b>\n📚 ${lesson.title}\n🎬 Video ulandi!\n\n` +
      `Jami: ${Object.keys(saved).length} ta video saqlandi.`,
      { parse_mode: 'HTML' }
    );
  });

  // /darslar_admin - barcha darslarni video holati bilan ko'rish
  bot.onText(/\/darslar_admin/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;
    const lessons = db.prepare('SELECT order_num, title, video_file_id FROM lessons WHERE is_active = 1 ORDER BY order_num').all();
    const list = lessons.map(l =>
      `${l.video_file_id ? '✅' : '❌'} ${l.order_num}. ${l.title}`
    ).join('\n');
    await bot.sendMessage(ADMIN_ID, `📚 <b>Darslar holati:</b>\n\n${list}`, { parse_mode: 'HTML' });
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
