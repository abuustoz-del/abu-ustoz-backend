// Deptor do'kon (jamoa) rejimi testlari:  node --test test/deptor_shop.test.js
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { create } = require('../src/deptor/sync');

const EGA = '+998901111111';     // do'kon egasi
const SOTUVCHI = '+998932222222'; // sotuvchi 1
const SOTUVCHI2 = '+998944444444';
const MIJOZ = '+998973333333';
const BEGONA = '+998955555555';

const opened = [];
after(async () => { for (const s of opened) await s.close(); });

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 'test-secret', testMode: true });
  const app = express();
  app.use('/dp', dp.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/dp`;
  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const login = async (phone) => (await call('POST', '/test/login', { body: { phone } })).json.token;
  const sync = async (token, ops = [], since = 0, name = '') =>
    (await call('POST', '/sync', { token, body: { since, name, ops } })).json;
  let closed = false;
  const h = {
    login, sync, call,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      dp.close();
    },
  };
  opened.push(h);
  return h;
}

// Do'kon + ikki faol sotuvchi
async function setup() {
  const s = await boot();
  const t = {
    ega: await s.login(EGA),
    s1: await s.login(SOTUVCHI),
    s2: await s.login(SOTUVCHI2),
    mijoz: await s.login(MIJOZ),
    begona: await s.login(BEGONA),
  };
  let r = await s.sync(t.ega, [{ op: 'shop_create', name: 'Temir do\'kon' }], 0, 'Ega');
  assert.deepEqual(r.rejected, []);
  await s.sync(t.s1, [], 0, 'Sardor');
  await s.sync(t.s2, [], 0, 'Jasur');
  r = await s.sync(t.ega, [
    { op: 'shop_invite', phone: SOTUVCHI },
    { op: 'shop_invite', phone: SOTUVCHI2 },
  ]);
  assert.deepEqual(r.rejected, []);
  await s.sync(t.s1, [{ op: 'shop_accept' }]);
  await s.sync(t.s2, [{ op: 'shop_accept' }]);
  return { s, t };
}

const debt = (over = {}) => ({
  op: 'debt', ref: 'SHOP0001', counter: MIJOZ, cname: 'Ali', dir: 'gave', kind: 'debt',
  amount: 100000000, currency: 'UZS', note: 'temir', date: 1760000000000, due: null, shop: true, ...over,
});

test('taklif: a\'zo qabul qilmaguncha do\'kon ma\'lumotini ko\'rmaydi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOTUVCHI);
  await s.sync(sot, [], 0, 'Sardor');
  await s.sync(ega, [{ op: 'shop_create', name: 'Temir do\'kon' }]);
  await s.sync(ega, [debt()]);
  const inv = await s.sync(ega, [{ op: 'shop_invite', phone: SOTUVCHI }]);
  assert.deepEqual(inv.rejected, []);
  let r = await s.sync(sot, [], 0);
  assert.equal(r.shop.status, 'invited');
  assert.equal(r.shop.name, 'Temir do\'kon');
  assert.equal(r.shop.members, undefined); // taklif bosqichida a'zolar ro'yxati yo'q
  assert.equal(r.debts.length, 0);
  r = await s.sync(sot, [{ op: 'shop_accept' }], 0);
  assert.equal(r.shop.status, 'active');
  assert.equal(r.debts.length, 1); // qabul qilgach avvalgi do'kon qarzlari ham keladi
  await s.close();
});

test('ro\'yxatdan o\'tmagan odamni taklif qilib bo\'lmaydi; faqat ega taklif qiladi', async () => {
  const { s, t } = await setup();
  let r = await s.sync(t.ega, [{ op: 'shop_invite', phone: '+998901234567' }]);
  assert.equal(r.rejected[0].reason, 'not_registered');
  r = await s.sync(t.s1, [{ op: 'shop_invite', phone: BEGONA }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test('bir sotuvchi yozgan qarz boshqasida va egada ko\'rinadi, mijoz do\'kon nomini ko\'radi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  const r2 = await s.sync(t.s2, [], 0);
  assert.equal(r2.debts.length, 1);
  assert.equal(r2.debts[0].creator, SOTUVCHI);
  assert.equal(r2.debts[0].authorName, 'Sardor');
  assert.equal(r2.debts[0].counterName, 'Ali'); // do'kondosh mijoz yorlig'ini ko'radi
  const re = await s.sync(t.ega, [], 0);
  assert.equal(re.debts.length, 1);
  const rm = await s.sync(t.mijoz, [], 0);
  assert.equal(rm.debts[0].creatorName, 'Temir do\'kon');
  assert.equal(rm.debts[0].counterName, ''); // mijoz uchun yorliq yashirin
  await s.close();
});

test('qisman qaytarishni istalgan sotuvchi kirita oladi - hammada ko\'rinadi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  const r = await s.sync(t.s2, [{ op: 'pay', uid: 'PAYUID0001', ref: 'SHOP0001', amount: 30000000, date: 1760100000000 }], 0);
  assert.deepEqual(r.rejected, []);
  const r1 = await s.sync(t.s1, [], 0);
  assert.equal(r1.payments.length, 1);
  assert.equal(r1.payments[0].by, SOTUVCHI2);
  const rm = await s.sync(t.mijoz, [], 0);
  assert.equal(rm.payments.length, 1); // mijoz ham ko'radi
  await s.close();
});

test('do\'kondosh qarzni tahrirlaydi va o\'chiradi; yaratuvchi nomi o\'zgarmaydi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  let r = await s.sync(t.s2, [debt({ note: 'tuzatildi' })], 0, 'Jasur');
  assert.deepEqual(r.rejected, []);
  const cur = r.debts.find((d) => d.ref === 'SHOP0001');
  assert.equal(cur.note, 'tuzatildi');
  assert.equal(cur.creator, SOTUVCHI); // yaratuvchi o'zgarmagan
  assert.equal(cur.creatorName, 'Temir do\'kon');
  assert.equal(cur.authorName, 'Sardor');
  r = await s.sync(t.s2, [{ op: 'del_debt', ref: 'SHOP0001' }], 0);
  assert.deepEqual(r.rejected, []);
  const r1 = await s.sync(t.s1, [], 0);
  assert.equal(r1.debts[0].deleted, true);
  await s.close();
});

test('shaxsiy (do\'konga kirmagan) qarzni do\'kondosh ko\'rmaydi va o\'zgartira olmaydi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt({ ref: 'PRIV0001', shop: false })], 0, 'Sardor');
  const r2 = await s.sync(t.s2, [debt({ ref: 'PRIV0001', shop: false, note: 'hack' })], 0);
  assert.equal(r2.rejected[0].reason, 'forbidden');
  assert.equal(r2.debts.length, 0);
  const re = await s.sync(t.ega, [], 0);
  assert.equal(re.debts.length, 0);
  await s.close();
});

test('begona odam do\'kon qarzini ko\'rmaydi va o\'zgartira olmaydi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  let r = await s.sync(t.begona, [{ op: 'pay', uid: 'PAYUID0002', ref: 'SHOP0001', amount: 1, date: 1 }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  assert.equal(r.debts.length, 0);
  r = await s.sync(t.begona, [{ op: 'del_debt', ref: 'SHOP0001' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test('do\'konsiz foydalanuvchi shop: true yubora olmaydi', async () => {
  const s = await boot();
  const t = await s.login(BEGONA);
  const r = await s.sync(t, [debt()], 0, 'Begona');
  assert.equal(r.rejected[0].reason, 'no_shop');
  await s.close();
});

test('ega sotuvchini olib tashlasa u do\'kon qarzlarini ko\'rmay qoladi, yozganlari do\'konda qoladi', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  let r = await s.sync(t.ega, [{ op: 'shop_remove', phone: SOTUVCHI }], 0);
  assert.deepEqual(r.rejected, []);
  r = await s.sync(t.s1, [], 0);
  assert.equal(r.shop, null);
  assert.equal(r.debts.length, 0); // o'zi yozgan do'kon qarzini ham endi ko'rmaydi
  r = await s.sync(t.s1, [{ op: 'pay', uid: 'PAYUID0009', ref: 'SHOP0001', amount: 1, date: 1 }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  const r2 = await s.sync(t.s2, [], 0);
  assert.equal(r2.debts.length, 1);
  await s.close();
});

test('ega ketolmaydi (a\'zolar bor); sotuvchi chiqa oladi; o\'zgacha do\'konga qo\'shilish tozalanadi', async () => {
  const { s, t } = await setup();
  let r = await s.sync(t.ega, [{ op: 'shop_leave' }], 0);
  assert.equal(r.rejected[0].reason, 'owner_cannot_leave');
  r = await s.sync(t.s1, [{ op: 'shop_leave' }], 0);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.shop, null);
  // Qayta taklif qilinib qabul qilishi mumkin
  r = await s.sync(t.ega, [{ op: 'shop_invite', phone: SOTUVCHI }], 0);
  assert.deepEqual(r.rejected, []);
  await s.close();
});

test('do\'kon a\'zolari ro\'yxati faqat faol a\'zolarga ko\'rinadi', async () => {
  const { s, t } = await setup();
  const r = await s.sync(t.s1, [], 0);
  assert.equal(r.shop.role, 'seller');
  assert.equal(r.shop.members.length, 3);
  assert.deepEqual(r.shop.members.map((m) => m.role).sort(), ['owner', 'seller', 'seller']);
  await s.close();
});

test('qarzdor (mijoz) tasdiqlashi do\'kondoshlarga ham yetib boradi; lender faqat do\'kon tomoni', async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  let r = await s.sync(t.mijoz, [{ op: 'respond', ref: 'SHOP0001', status: 'confirmed' }], 0);
  assert.deepEqual(r.rejected, []);
  r = await s.sync(t.s2, [], 0);
  assert.equal(r.debts[0].status, 'confirmed');
  // Do'kondosh "kechirdim" (close) qila oladi: qarz bergan tomon
  r = await s.sync(t.s2, [{ op: 'close', ref: 'SHOP0001', closed: true }], 0);
  assert.deepEqual(r.rejected, []);
  // Mijoz o'zi yopa olmaydi (u qarz bermagan)
  r = await s.sync(t.mijoz, [{ op: 'close', ref: 'SHOP0001', closed: false }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test("do'kon qarzida mijoz raqami bo'lmasa ham do'kondoshlarga ko'rinadi; shaxsiyda raqam shart", async () => {
  const { s, t } = await setup();
  let r = await s.sync(t.s1, [debt({ ref: 'NOPH0001', counter: '', cname: 'Nomalum' })], 0, 'Sardor');
  assert.deepEqual(r.rejected, []);
  r = await s.sync(t.s2, [], 0);
  const d = r.debts.find((x) => x.ref === 'NOPH0001');
  assert.equal(d.counter, '');
  assert.equal(d.status, 'confirmed'); // tasdiqlaydigan odam yo'q
  assert.equal(d.counterName, 'Nomalum');
  r = await s.sync(t.s1, [debt({ ref: 'NOPH0002', counter: '', shop: false })], 0);
  assert.equal(r.rejected[0].reason, 'bad_counter');
  await s.close();
});

test("tarix: kim nima qilgani yoziladi; faqat yaratuvchi tomon ko'ra oladi", async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  await s.sync(t.s2, [{ op: 'pay', uid: 'PAYUID0100', ref: 'SHOP0001', amount: 10000000, date: 1760100000000 }], 0, 'Jasur');
  await s.sync(t.s2, [debt({ note: 'tuzatildi' })], 0, 'Jasur');
  const h = await s.call('GET', '/history?ref=SHOP0001', { token: t.ega });
  assert.equal(h.status, 200);
  const acts = h.json.items.map((i) => `${i.action}:${i.name}`);
  assert.deepEqual(acts, ['edit:Jasur', 'pay:Jasur', 'create:Sardor']); // yangisi birinchi
  assert.equal((await s.call('GET', '/history?ref=SHOP0001', { token: t.mijoz })).status, 404);
  assert.equal((await s.call('GET', '/history?ref=SHOP0001', { token: t.begona })).status, 404);
  await s.close();
});

test("o'chirilgan do'kon qarzi 'o'chirilganlar'da ko'rinadi va do'kondosh tiklay oladi (qaytarishlari bilan)", async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  await s.sync(t.s1, [{ op: 'pay', uid: 'PAYUID0200', ref: 'SHOP0001', amount: 20000000, date: 1760100000000 }], 0, 'Sardor');
  await s.sync(t.s1, [{ op: 'del_debt', ref: 'SHOP0001' }], 0, 'Sardor');
  let tr = await s.call('GET', '/trash', { token: t.s2 });
  assert.equal(tr.json.debts.length, 1);
  assert.equal(tr.json.debts[0].ref, 'SHOP0001');
  assert.equal(tr.json.debts[0].by, 'Sardor');
  assert.equal((await s.call('GET', '/trash', { token: t.begona })).json.debts.length, 0);
  const since = (await s.sync(t.s2, [], 0)).rev;
  const r = await s.sync(t.s2, [{ op: 'restore_debt', ref: 'SHOP0001' }], since, 'Jasur');
  assert.deepEqual(r.rejected, []);
  const d = r.debts.find((x) => x.ref === 'SHOP0001');
  assert.equal(d.deleted, false);
  assert.equal(r.payments.length, 1); // qaytarish ham qayta keladi
  tr = await s.call('GET', '/trash', { token: t.s2 });
  assert.equal(tr.json.debts.length, 0);
  const hist = (await s.call('GET', '/history?ref=SHOP0001', { token: t.ega })).json.items;
  assert.equal(hist[0].action, 'restore');
  assert.equal(hist[0].name, 'Jasur');
  await s.close();
});

test("o'chirilgan qaytarishni tiklash mumkin; mijoz va begona qarzni tiklay olmaydi", async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt()], 0, 'Sardor');
  await s.sync(t.s1, [{ op: 'pay', uid: 'PAYUID0300', ref: 'SHOP0001', amount: 5000000, date: 1760100000000 }], 0);
  await s.sync(t.s1, [{ op: 'del_pay', uid: 'PAYUID0300' }], 0);
  let tr = await s.call('GET', '/trash', { token: t.ega });
  assert.equal(tr.json.payments.length, 1);
  let r = await s.sync(t.ega, [{ op: 'restore_pay', uid: 'PAYUID0300' }], 0);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.payments.find((p) => p.uid === 'PAYUID0300').deleted, false);
  await s.sync(t.s1, [{ op: 'del_debt', ref: 'SHOP0001' }], 0);
  r = await s.sync(t.mijoz, [{ op: 'restore_debt', ref: 'SHOP0001' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await s.sync(t.begona, [{ op: 'restore_debt', ref: 'SHOP0001' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test("shaxsiy qarzni yaratuvchi tiklay oladi; do'kondan chiqqan sotuvchi do'kon qarzini tiklay olmaydi", async () => {
  const { s, t } = await setup();
  await s.sync(t.s1, [debt({ ref: 'PRIV0100', shop: false, counter: BEGONA })], 0, 'Sardor');
  await s.sync(t.s1, [{ op: 'del_debt', ref: 'PRIV0100' }], 0);
  assert.equal((await s.call('GET', '/trash', { token: t.s1 })).json.debts.length, 1);
  let r = await s.sync(t.s1, [{ op: 'restore_debt', ref: 'PRIV0100' }], 0);
  assert.deepEqual(r.rejected, []);
  await s.sync(t.s1, [debt({ ref: 'SHOP0500' })], 0);
  await s.sync(t.s1, [{ op: 'del_debt', ref: 'SHOP0500' }], 0);
  await s.sync(t.ega, [{ op: 'shop_remove', phone: SOTUVCHI }], 0);
  r = await s.sync(t.s1, [{ op: 'restore_debt', ref: 'SHOP0500' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test("nasiya: meta (tovarlar va grafik) saqlanadi, do'kondosh va mijoz ko'radi; noto'g'ri meta rad etiladi", async () => {
  const { s, t } = await setup();
  const meta = JSON.stringify({ v: 1, type: 'sale', items: [{ n: 'Temir', q: 20, p: 5000000 }], plan: { mode: 'schedule', n: 3, first: 1762000000000, step: 'month' } });
  let r = await s.sync(t.s1, [debt({ ref: 'SALE0001', meta })], 0, 'Sardor');
  assert.deepEqual(r.rejected, []);
  r = await s.sync(t.s2, [], 0);
  assert.equal(r.debts.find((d) => d.ref === 'SALE0001').meta, meta); // do'kondosh
  r = await s.sync(t.mijoz, [], 0);
  assert.equal(r.debts.find((d) => d.ref === 'SALE0001').meta, meta); // mijoz chekni ko'radi
  // tahrirlansa yangilanadi
  const meta2 = JSON.stringify({ v: 1, type: 'sale', items: [{ n: 'Temir', q: 25, p: 5000000 }] });
  r = await s.sync(t.s2, [debt({ ref: 'SALE0001', meta: meta2 })], 0, 'Jasur');
  assert.deepEqual(r.rejected, []);
  assert.equal(r.debts.find((d) => d.ref === 'SALE0001').meta, meta2);
  // noto'g'ri meta
  r = await s.sync(t.s1, [debt({ ref: 'SALE0002', meta: 'bu json emas' })], 0);
  assert.equal(r.rejected[0].reason, 'bad_meta');
  r = await s.sync(t.s1, [debt({ ref: 'SALE0003', meta: '[1,2]' })], 0);
  assert.equal(r.rejected[0].reason, 'bad_meta');
  r = await s.sync(t.s1, [debt({ ref: 'SALE0004', meta: JSON.stringify({ x: 'a'.repeat(9000) }) })], 0);
  assert.equal(r.rejected[0].reason, 'bad_meta');
  await s.close();
});
