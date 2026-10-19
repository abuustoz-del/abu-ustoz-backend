// Deptor SMS havolalari: /r sahifasi va Android App Links tasdig'i (assetlinks.json).
//   DP_ASSETLINKS_SHA - qo'shimcha imzo barmoq izlari (vergul bilan), masalan Play
//   "App signing" sertifikati SHA-256 qiymati.
const UPLOAD_SHA = 'A8:6B:B6:58:11:2F:0C:02:20:99:A3:12:69:10:33:6B:2C:86:06:81:66:75:43:26:62:4B:5C:3D:7D:48:A7:A2';

function mount(app) {
  app.get('/.well-known/assetlinks.json', (req, res) => {
    const extra = (process.env.DP_ASSETLINKS_SHA || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'uz.deptor.app',
        sha256_cert_fingerprints: [UPLOAD_SHA, ...extra],
      },
    }]);
  });

  // Ilova o'rnatilmagan bo'lsa shu sahifa ochiladi.
  app.get('/r', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Deptor</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:32px 20px;text-align:center;background:#f6f8f6;color:#1d2b22}
h1{margin:8px 0}p{line-height:1.5}a.b{display:inline-block;margin-top:16px;padding:14px 24px;border-radius:12px;background:#2e7d32;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><h1>Deptor</h1>
<p>Sizga qarz/to'lov haqida xabar yuborildi.<br>Uni ko'rish uchun Deptor ilovasi kerak.</p>
<a class="b" href="https://play.google.com/store/apps/details?id=uz.deptor.app">Google Play'dan o'rnatish</a>
<p style="font-size:14px;opacity:.7;margin-top:28px">Ilova o'rnatilgan bo'lsa, SMS'dagi havolani qayta bosing.</p>
</body></html>`);
  });
}

module.exports = { mount };
