# Deptor zaxira nusxalari

**Nima saqlanadi:** `deptor_sync.db` (ulangan qarzlar, qaytarishlar, do'konlar, tarix).

**Kunlik nusxa (mahalliy):** `<DATA_DIR>/backups/deptor_sync-YYYY-MM-DD.db`, oxirgi 14 kun.
Server ishga tushganda 2 daqiqadan keyin, keyin har soatda "bugungi nusxa bormi" tekshiriladi.
Bu tasodifiy o'chirish yoki bazadagi xatodan himoya qiladi. Disk yo'qolsa, nusxa ham yo'qoladi.

**Tashqi nusxa (Telegram):** `DP_BACKUP_CHAT_ID` va `DP_BACKUP_KEY` o'rnatilsa, nusxa siqiladi,
AES-256-GCM bilan shifrlanadi va shaxsiy chatga `deptor_sync-YYYY-MM-DD.db.enc` nomi bilan
yuboriladi. Yuborilmasa (tarmoq xatosi) keyingi soatda qayta uriniladi.

## Render sozlamalari
| Kalit | Qiymat |
|---|---|
| `DP_BACKUP_KEY` | uzun tasodifiy matn. **Yo'qotmang: kalitsiz nusxani ochib bo'lmaydi.** |
| `DP_BACKUP_CHAT_ID` | botga `/id` yozing, u chat raqamini qaytaradi |

## Tiklash
1. Telegramdan `.enc` faylni yuklab oling.
2. `DP_BACKUP_KEY=<kalit> node scripts/dp_restore.js zaxira.db.enc tiklangan.db`
3. Render'da xizmatni to'xtating (yoki Shell'da) va `/var/data/deptor_sync.db` o'rniga
   `tiklangan.db` ni qo'ying (`-wal` va `-shm` fayllarini o'chirib), xizmatni qayta ishga tushiring.
4. Mahalliy nusxa kerak bo'lsa: `/var/data/backups/` dagi `.db` faylni to'g'ridan-to'g'ri nusxalang.

Ilova ma'lumotni qayta tortib oladi: telefonlar `since` kursori bo'yicha so'raydi. Agar baza
eskirgan nusxaga qaytarilsa, kursori undan oldinda turgan telefonlar yangilarini serverga
qayta yubormaydi. Bunday holatda foydalanuvchilar Telegramdan chiqib qayta kirsin
(Sozlamalar → Chiqish → Kirish): bu kursorni nolga qaytaradi va barcha qarzlar qayta tortiladi.
