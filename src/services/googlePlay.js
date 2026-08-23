// Google Play xaridini SERVER tomonda haqiqiy tekshirish (A2).
// Service account JSON kaliti GOOGLE_SERVICE_ACCOUNT_JSON env var da bo'ladi.
// Kalit yo'q bo'lsa — { configured: false } qaytadi va eski (yumshoq) tekshiruv ishlaydi.
const { google } = require('googleapis');

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.abuustoz.elektrik';

let _publisher = null;
let _triedInit = false;

function getPublisher() {
  if (_publisher) return _publisher;
  if (_triedInit) return null;
  _triedInit = true;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.trim().length < 20) {
    console.log('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON yo\'q — xaridlar eski usulda tekshiriladi');
    return null;
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    console.error('❌ GOOGLE_SERVICE_ACCOUNT_JSON noto\'g\'ri JSON:', e.message);
    return null;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    _publisher = google.androidpublisher({ version: 'v3', auth });
    console.log('✅ Google Play tekshiruvi yoqildi (service account)');
    return _publisher;
  } catch (e) {
    console.error('❌ Google Play auth xatosi:', e.message);
    return null;
  }
}

// Obuna purchase_token ni Google dan tekshiradi.
// Qaytaradi: { configured, valid, plan, state, error }
async function verifySubscription(purchaseToken) {
  const publisher = getPublisher();
  if (!publisher) return { configured: false };

  try {
    const res = await publisher.purchases.subscriptionsv2.get({
      packageName: PACKAGE_NAME,
      token: purchaseToken,
    });
    const data = res.data || {};
    const state = data.subscriptionState || 'UNKNOWN';
    const valid = state === 'SUBSCRIPTION_STATE_ACTIVE'
      || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';

    // Haqiqiy reja (base plan) — Google dan
    let plan = null;
    const li = Array.isArray(data.lineItems) && data.lineItems.length ? data.lineItems[0] : null;
    if (li && li.offerDetails && li.offerDetails.basePlanId) {
      plan = li.offerDetails.basePlanId;
    }
    return { configured: true, valid, plan, state };
  } catch (e) {
    // 400/404 = token noto'g'ri/topilmadi -> valid emas
    console.error('Google Play verify xatosi:', e.message);
    return { configured: true, valid: false, error: e.message };
  }
}

module.exports = { verifySubscription, PACKAGE_NAME };
