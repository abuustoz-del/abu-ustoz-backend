// Deptor zaxira nusxasini ochadi:
//   DP_BACKUP_KEY=<kalit> node scripts/dp_restore.js <zaxira.db.enc> <natija.db>
// Mahalliy (shifrlanmagan) nusxa kerak bo'lsa, uni to'g'ridan-to'g'ri nusxalash kifoya.
const fs = require('fs');
const { decrypt } = require('../src/deptor/backup');

const [src, out] = process.argv.slice(2);
const key = process.env.DP_BACKUP_KEY;
if (!src || !out || !key) {
  console.error('Foydalanish: DP_BACKUP_KEY=... node scripts/dp_restore.js <zaxira.db.enc> <natija.db>');
  process.exit(1);
}
try {
  fs.writeFileSync(out, decrypt(fs.readFileSync(src), key));
  console.log('Tayyor: ' + out);
} catch (e) {
  console.error("Ochib bo'lmadi (kalit noto'g'ri yoki fayl buzilgan): " + e.message);
  process.exit(2);
}
