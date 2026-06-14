// Video file_id larni olish — Render bilan conflict bo'lmaydi
// Ishlatish: node get_file_ids.js
// Keyin botga video yuboring

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

const https = require('https');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function apiCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let offset = 0;
let count = 0;
const fileIds = [];

console.log('✅ Ishga tushdi. Telegram da @abu_ustoz_bot ga video yuboring!');
console.log('📋 Har bir video file_id quyida chiqadi:\n');

async function poll() {
  try {
    const res = await apiCall('getUpdates', { offset, timeout: 10, allowed_updates: ['message'] });
    if (!res.ok) {
      // Conflict bo'lsa — Render polling ni to'xtatishini kutamiz
      setTimeout(poll, 3000);
      return;
    }

    for (const update of res.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.video) continue;

      count++;
      const fileId = msg.video.file_id;
      const duration = msg.video.duration;
      const size = Math.round((msg.video.file_size || 0) / 1024 / 1024 * 10) / 10;

      fileIds.push({ num: count, file_id: fileId, duration_seconds: duration, size_mb: size });

      console.log(`📹 Video #${count}:`);
      console.log(`   file_id: ${fileId}`);
      console.log(`   Davomiylik: ${duration} sekund`);
      console.log(`   Hajm: ${size} MB`);
      console.log('');

      // Confirm xabar yuborish
      await apiCall('sendMessage', {
        chat_id: msg.chat.id,
        text: `✅ Video #${count} qabul qilindi!\n${10 - count > 0 ? `Yana ${10 - count} ta video yuboring.` : '🎉 Hammasi tayyor!'}`,
      });

      if (count >= 10) {
        fs.writeFileSync(path.join(__dirname, 'file_ids.json'), JSON.stringify(fileIds, null, 2));
        console.log('\n✅ 10 ta video qabul qilindi!');
        console.log('💾 file_ids.json ga saqlandi!\n');
        console.log('Barcha file_id lar:');
        fileIds.forEach(v => console.log(`  Dars #${v.num}: ${v.file_id}`));
        process.exit(0);
      }
    }
  } catch (e) {
    // Xato bo'lsa 3 sekunddan keyin qayta urinish
  }
  setTimeout(poll, 1000);
}

poll();
