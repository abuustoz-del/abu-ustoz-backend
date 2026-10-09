// AbuElectric: admin xabarnomalari, botga yozganlar (lead) ro'yxati, ulashish sahifalari (OG preview).
// Ma'lumot Render persistent diskida saqlanadi (/var/data/abuelectric.json), lokalda ./data/.
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const DIR = fs.existsSync('/var/data') ? '/var/data' : path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'abuelectric.json');
const MAX_LEADS = 5000;
const SITE = () => process.env.AE_SITE_URL || 'https://abuelectric.uz';
const ADMIN_PHONE = () => process.env.AE_ADMIN_PHONE || '+998971719600';
const FIREBASE_PROJECT = 'abuelectric-536b3';
const FIREBASE_WEB_KEY = 'AIzaSyCZ5EL3T11s8FNeHrDxGzaIaDL6XM660nY'; // ochiq web kalit (saytda ham bor)

// ---------- Saqlash ----------
let state = { admins: {}, leads: {}, notified: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.error('[AE] saqlash:', e.message); }
  }, 300);
}

const adminUid = () => 'p' + ADMIN_PHONE().replace(/\D/g, '');
const isAdminUid = (uid) => uid === adminUid() || (process.env.AE_ADMIN_UIDS || '').split(',').map((s) => s.trim()).includes(uid);
const isAdminPhone = (phone) => phone === ADMIN_PHONE();

function addAdminChat(chatId, phone) {
  state.admins[String(chatId)] = { phone, at: Date.now() };
  save();
}

function recordLead({ phone, tgId, name, username }) {
  const now = Date.now();
  const l = state.leads[phone] || { phone, firstAt: now, count: 0, registered: false };
  Object.assign(l, { tgId: String(tgId), name: name || l.name || '', username: username || l.username || '', lastAt: now, count: l.count + 1 });
  state.leads[phone] = l;
  const keys = Object.keys(state.leads);
  if (keys.length > MAX_LEADS) {
    keys.sort((a, b) => state.leads[a].lastAt - state.leads[b].lastAt).slice(0, keys.length - MAX_LEADS).forEach((k) => delete state.leads[k]);
  }
  save();
}

// ---------- Firebase ID token tekshiruvi (firebase-admin'siz) ----------
let certs = null, certsExp = 0;
async function getCerts() {
  if (certs && Date.now() < certsExp) return certs;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  certs = await r.json();
  certsExp = Date.now() + (m ? Number(m[1]) * 1000 : 3600e3);
  return certs;
}
async function verifyIdToken(req) {
  const tok = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const dec = jwt.decode(tok, { complete: true });
  if (!dec || !dec.header || !dec.header.kid) throw new Error('bad_token');
  const cert = (await getCerts())[dec.header.kid];
  if (!cert) throw new Error('bad_kid');
  return jwt.verify(tok, cert, { algorithms: ['RS256'], audience: FIREBASE_PROJECT, issuer: `https://securetoken.google.com/${FIREBASE_PROJECT}` });
}

// ---------- Firestore'dan ochiq profilni o'qish (REST, ochiq kalit bilan) ----------
const val = (f) => (f == null ? undefined : f.stringValue ?? (f.integerValue != null ? Number(f.integerValue) : f.doubleValue ?? f.booleanValue ?? (f.arrayValue ? (f.arrayValue.values || []).map(val) : undefined)));
async function fetchProfile(id) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/electricians/${id}?key=${FIREBASE_WEB_KEY}`);
  if (!r.ok) return null;
  const d = await r.json();
  const f = d.fields || {};
  const out = {};
  for (const k of ['name', 'viloyat', 'tuman', 'services', 'experience', 'ratingSum', 'ratingCount', 'photoURL', 'status', 'about', 'price']) out[k] = val(f[k]);
  return out.status === 'blocked' ? null : out;
}

const REGIONS = {
  qoraqalpogiston: "Qoraqalpog'iston", andijon: 'Andijon', buxoro: 'Buxoro', fargona: "Farg'ona", jizzax: 'Jizzax', xorazm: 'Xorazm',
  namangan: 'Namangan', navoiy: 'Navoiy', qashqadaryo: 'Qashqadaryo', samarqand: 'Samarqand', sirdaryo: 'Sirdaryo',
  surxondaryo: 'Surxondaryo', 'toshkent-viloyati': 'Toshkent viloyati', 'toshkent-shahri': 'Toshkent shahri',
};
const SERVICES = { rozetka: 'rozetka', avtomat: 'avtomat va shchit', sim: 'sim tortish', yoritish: 'yoritish', kamera: 'kamera', texnika: 'maishiy texnika', avariya: 'avariya', boshqa: 'boshqa ishlar' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const shareCache = new Map(); // id → { at, profile }
async function cachedProfile(id) {
  const c = shareCache.get(id);
  if (c && Date.now() - c.at < 10 * 60e3) return c.profile;
  const profile = await fetchProfile(id).catch(() => null);
  shareCache.set(id, { at: Date.now(), profile });
  if (shareCache.size > 2000) shareCache.delete(shareCache.keys().next().value);
  return profile;
}

function mount(router, getBot) {
  const send = (chatId, text, extra) => { const b = getBot(); return b ? b.sendMessage(chatId, text, extra).catch((e) => console.error('[AE] send:', e.message)) : null; };

  // Sayt: yangi usta ro'yxatdan o'tdi → adminlarga xabar
  router.post('/notify/registered', async (req, res) => {
    try {
      const t = await verifyIdToken(req);
      const uid = t.user_id || t.sub;
      if (state.notified[uid]) return res.json({ ok: true, dup: true });
      const p = await fetchProfile(uid);
      if (!p || !p.name) return res.status(404).json({ error: 'no_profile' });
      state.notified[uid] = Date.now();
      const phone = t.tel || t.phone_number || '';
      if (phone && state.leads[phone]) state.leads[phone].registered = true;
      save();
      const where = [p.tuman, REGIONS[p.viloyat]].filter(Boolean).join(', ');
      const svc = (p.services || []).map((k) => SERVICES[k] || k).join(', ');
      const text = `🆕 Yangi usta ro'yxatdan o'tdi\n\n👤 ${p.name}\n📍 ${where}\n📞 ${phone}\n🔧 ${svc}\n⏳ Tajriba: ${p.experience ?? '—'} yil`;
      const kb = { reply_markup: { inline_keyboard: [[{ text: '👁 Profil', url: `${SITE()}/usta/?id=${uid}` }, { text: '🛠 Admin panel', url: `${SITE()}/admin/` }]] } };
      Object.keys(state.admins).forEach((chatId) => send(chatId, text, kb));
      res.json({ ok: true });
    } catch (e) {
      res.status(401).json({ error: 'unauthorized' });
    }
  });

  // Admin panel: botga raqam yuborganlar
  router.get('/admin/leads', async (req, res) => {
    try {
      const t = await verifyIdToken(req);
      if (!isAdminUid(t.user_id || t.sub)) return res.status(403).json({ error: 'forbidden' });
      const leads = Object.values(state.leads).sort((a, b) => b.lastAt - a.lastAt);
      res.json({ leads, admins: Object.keys(state.admins).length });
    } catch (e) {
      res.status(401).json({ error: 'unauthorized' });
    }
  });

  // Ulashish sahifasi: abuelectric.uz/u/<id> → (Render rewrite) → shu yer. Telegram/Instagram OG preview uchun.
  router.get('/share/:id', async (req, res) => {
    const id = String(req.params.id || '');
    const target = `${SITE()}/usta/?id=${encodeURIComponent(id)}`;
    if (!/^[A-Za-z0-9]{6,64}$/.test(id)) return res.redirect(302, `${SITE()}/elektriklar/`);
    const p = await cachedProfile(id);
    const name = p?.name || 'Elektrik usta';
    const where = p ? [p.tuman, REGIONS[p.viloyat]].filter(Boolean).join(', ') : "O'zbekiston";
    const rating = p?.ratingCount ? ` · ★ ${(p.ratingSum / p.ratingCount).toFixed(1)} (${p.ratingCount})` : '';
    const title = `${name} — elektrik, ${where}`;
    const desc = p
      ? `${(p.services || []).map((k) => SERVICES[k] || k).join(', ')}${p.experience ? ` · ${p.experience} yil tajriba` : ''}${rating}. AbuElectric orqali to'g'ridan-to'g'ri qo'ng'iroq qiling.`
      : "O'zbekiston bo'ylab elektriklar katalogi — AbuElectric";
    const img = p && /^data:image\//.test(p.photoURL || '') ? `${SITE()}/u/${id}/photo` : `${SITE()}/assets/img/og-katalog.png`;
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!doctype html><html lang="uz"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(target)}">
<meta property="og:type" content="profile"><meta property="og:site_name" content="AbuElectric">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${SITE()}/u/${id}`)}"><meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head><body><script>location.replace(${JSON.stringify(target)})</script><a href="${esc(target)}">${esc(title)}</a></body></html>`);
  });

  router.get('/share/:id/photo', async (req, res) => {
    const id = String(req.params.id || '');
    const p = /^[A-Za-z0-9]{6,64}$/.test(id) ? await cachedProfile(id) : null;
    const m = /^data:(image\/(?:webp|jpeg));base64,(.+)$/.exec(p?.photoURL || '');
    if (!m) return res.redirect(302, `${SITE()}/assets/img/og-katalog.png`);
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(m[1]).send(Buffer.from(m[2], 'base64'));
  });
}

module.exports = { mount, addAdminChat, recordLead, isAdminPhone, _state: () => state };
