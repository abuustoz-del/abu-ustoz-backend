// Deptor rasm testlari:  node --test test/deptor_photo.test.js
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { create } = require('../src/deptor/sync');

const EGA = '+998901111111';
const SOT = '+998932222222';
const MIJOZ = '+998973333333';
const BEGONA = '+998955555555';

const opened = [];
after(async () => { for (const s of opened) await s.close(); });

/** Kichik, lekin JPEG belgisi (FF D8 FF) bor soxta rasm. */
const jpeg = (n = 400, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpp-'));
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 'test-secret', testMode: true });
  const app = express();
  app.use('/dp', dp.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/dp`;
  const login = async (phone) => (await (await fetch(base + '/test/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json()).token;
  const sync = async (token, ops = [], since = 0, name = '') => (await (await fetch(base + '/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ since, name, ops }),
  })).json());
  const put = (uid, token, buf) => fetch(`${base}/photo/${uid}`, {
    method: 'PUT', headers: { 'content-type': 'image/jpeg', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: buf,
  });
  const get = (uid, token) => fetch(`${base}/photo/${uid}`, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  const h = { login, sync, put, get, dp, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); dp.close(); } };
  opened.push(h);
  return h;
}

const debt = (over = {}) => ({
  op: 'debt', ref: 'PHOTO001', counter: SOT, dir: 'gave', kind: 'debt', amount: 5000000,
  currency: 'UZS', note: 'x', date: 1760000000000, due: null, ...over,
});
const photoOp = (over = {}) => ({ op: 'photo', uid: 'PHUID0001', ref: 'PHOTO001', kind: 'proof', ...over });

test('rasm: metadata + fayl yuklanadi, ikkinchi tomon ko\'radi va yuklab oladi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOT);
  await s.sync(ega, [debt(), photoOp()], 0, 'Ega');
  // Metadata keldi, fayl hali yo'q
  let r = await s.sync(sot, [], 0);
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].hasFile, false);
  assert.equal((await s.get('PHUID0001', sot)).status, 404); // fayl hali yo'q
  // Yuklash
  const img = jpeg();
  const up = await s.put('PHUID0001', ega, img);
  assert.equal(up.status, 200);
  r = await s.sync(sot, [], 0);
  assert.equal(r.photos[0].hasFile, true);
  const dl = await s.get('PHUID0001', sot);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), img);
  await s.close();
});

test('rasm: tokensiz, begona va muallif bo\'lmaganlar uchun yopiq', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOT);
  const beg = await s.login(BEGONA);
  await s.sync(ega, [debt(), photoOp()], 0, 'Ega');
  await s.put('PHUID0001', ega, jpeg());
  assert.equal((await s.get('PHUID0001')).status, 401);
  assert.equal((await s.get('PHUID0001', beg)).status, 404);
  assert.equal((await s.put('PHUID0001', sot, jpeg())).status, 404); // faqat muallif yuklaydi
  assert.equal((await s.put('PHUID0001', beg, jpeg())).status, 404);
  const r = await s.sync(beg, [photoOp({ uid: 'PHUID0002' })], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  assert.equal(r.photos.length, 0);
  await s.close();
});

test('rasm: faqat JPEG va hajm chegarasi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  await s.sync(ega, [debt(), photoOp()], 0, 'Ega');
  assert.equal((await s.put('PHUID0001', ega, Buffer.from('<?php echo 1; ?>'.repeat(20)))).status, 415);
  assert.equal((await s.put('PHUID0001', ega, Buffer.from([0xff, 0xd8, 0xff, 1, 2]))).status, 413); // juda kichik
  assert.equal((await s.put('PHUID0001', ega, jpeg(2 * 1024 * 1024))).status, 413); // juda katta
  assert.equal((await s.put('PHUID0001', ega, jpeg())).status, 200);
  await s.close();
});

test('rasm: mijoz va hujjat rasmlari faqat do\'kon tomoniga ko\'rinadi, mijozga yuborilmaydi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOT);
  const mijoz = await s.login(MIJOZ);
  await s.sync(sot, [], 0, 'Sardor');
  await s.sync(ega, [{ op: 'shop_create', name: 'Temir do\'kon' }]);
  await s.sync(ega, [{ op: 'shop_invite', phone: SOT }]);
  await s.sync(sot, [{ op: 'shop_accept' }]);
  await s.sync(sot, [debt({ ref: 'SHOP0001', counter: MIJOZ, shop: true }),
    photoOp({ uid: 'DOCUID001', ref: 'SHOP0001', kind: 'document' }),
    photoOp({ uid: 'PRFUID001', ref: 'SHOP0001', kind: 'proof' })], 0, 'Sardor');
  await s.put('DOCUID001', sot, jpeg(300, 1));
  await s.put('PRFUID001', sot, jpeg(300, 2));
  // Ega (do'kondosh) ikkalasini ko'radi
  let r = await s.sync(ega, [], 0);
  assert.deepEqual(r.photos.map((p) => p.uid).sort(), ['DOCUID001', 'PRFUID001']);
  assert.equal((await s.get('DOCUID001', ega)).status, 200);
  // Mijoz faqat dalil rasmini ko'radi, hujjatni emas
  r = await s.sync(mijoz, [], 0);
  assert.deepEqual(r.photos.map((p) => p.uid), ['PRFUID001']);
  assert.equal((await s.get('DOCUID001', mijoz)).status, 404);
  assert.equal((await s.get('PRFUID001', mijoz)).status, 200);
  // Mijoz hujjat rasmini qo'sha olmaydi
  r = await s.sync(mijoz, [photoOp({ uid: 'DOCUID002', ref: 'SHOP0001', kind: 'document' })], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  // Lekin o'zi dalil rasmini qo'sha oladi
  r = await s.sync(mijoz, [photoOp({ uid: 'PRFUID002', ref: 'SHOP0001', kind: 'proof' })], 0);
  assert.deepEqual(r.rejected, []);
  await s.close();
});

test('rasm: o\'chirish faylni olib tashlaydi; muallif yoki yaratuvchi tomon o\'chira oladi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOT);
  const beg = await s.login(BEGONA);
  await s.sync(ega, [debt(), photoOp()], 0, 'Ega');
  await s.put('PHUID0001', ega, jpeg());
  let r = await s.sync(beg, [{ op: 'del_photo', uid: 'PHUID0001' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  // Qarshi tomon (mijoz) o'zi qo'shmagan rasmni o'chira olmaydi
  r = await s.sync(sot, [{ op: 'del_photo', uid: 'PHUID0001' }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await s.sync(ega, [{ op: 'del_photo', uid: 'PHUID0001' }], 0);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.photos.find((p) => p.uid === 'PHUID0001').deleted, true);
  assert.equal((await s.get('PHUID0001', ega)).status, 404);
  await s.close();
});

test('rasm: bitta qarzga 8 tadan ko\'p qo\'shib bo\'lmaydi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  await s.sync(ega, [debt()], 0, 'Ega');
  const ops = [];
  for (let i = 0; i < 9; i++) ops.push(photoOp({ uid: 'MANYPH' + String(i).padStart(4, '0') }));
  const r = await s.sync(ega, ops, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, 'too_many_photos');
  assert.equal(r.photos.length, 8);
  await s.close();
});

test('rasm: qarz o\'chirilib tiklansa rasmlar qayta yuboriladi', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  await s.sync(ega, [debt(), photoOp()], 0, 'Ega');
  await s.put('PHUID0001', ega, jpeg());
  await s.sync(ega, [{ op: 'del_debt', ref: 'PHOTO001' }], 0);
  const since = (await s.sync(ega, [], 0)).rev;
  const r = await s.sync(ega, [{ op: 'restore_debt', ref: 'PHOTO001' }], since);
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].hasFile, true);
  await s.close();
});

test('rasm: boshqa qarzning rasmi uchun uid takrorlanmaydi; takroriy yuborish zararsiz', async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  await s.sync(ega, [debt(), debt({ ref: 'PHOTO002' }), photoOp()], 0, 'Ega');
  let r = await s.sync(ega, [photoOp()], 0); // aynan o'sha - zararsiz
  assert.deepEqual(r.rejected, []);
  r = await s.sync(ega, [photoOp({ ref: 'PHOTO002' })], 0); // boshqa qarzga shu uid
  assert.equal(r.rejected[0].reason, 'forbidden');
  await s.close();
});

test("hujjat turlari (ID, chet el pasporti, guvohnoma, texnik pasport) faqat do'kon tomoniga ko'rinadi", async () => {
  const s = await boot();
  const ega = await s.login(EGA);
  const sot = await s.login(SOT);
  const mijoz = await s.login(MIJOZ);
  await s.sync(sot, [], 0, 'Sardor');
  await s.sync(ega, [{ op: 'shop_create', name: "Avto qismlar" }]);
  await s.sync(ega, [{ op: 'shop_invite', phone: SOT }]);
  await s.sync(sot, [{ op: 'shop_accept' }]);
  const kinds = ['id', 'passport', 'license', 'techpass'];
  const ops = [debt({ ref: 'DOCS0001', counter: MIJOZ, shop: true })];
  kinds.forEach((k, i) => ops.push(photoOp({ uid: 'DOCK00' + (i + 1) + 'XXXX', ref: 'DOCS0001', kind: k })));
  const r = await s.sync(sot, ops, 0, 'Sardor');
  assert.deepEqual(r.rejected, []);
  for (let i = 0; i < kinds.length; i++) await s.put('DOCK00' + (i + 1) + 'XXXX', sot, jpeg(300, i + 1));
  // do'kondosh to'rttasini ham ko'radi
  const re = await s.sync(ega, [], 0);
  assert.equal(re.photos.length, 4);
  assert.deepEqual(re.photos.map((p) => p.kind).sort(), [...kinds].sort());
  // mijozga hech biri yuborilmaydi va yuklab bo'lmaydi
  const rm = await s.sync(mijoz, [], 0);
  assert.equal(rm.photos.length, 0);
  for (let i = 0; i < kinds.length; i++) assert.equal((await s.get('DOCK00' + (i + 1) + 'XXXX', mijoz)).status, 404);
  // mijoz bunday hujjat qo'sha olmaydi
  const bad = await s.sync(mijoz, [photoOp({ uid: 'DOCBAD0001', ref: 'DOCS0001', kind: 'techpass' })], 0);
  assert.equal(bad.rejected[0].reason, 'forbidden');
  await s.close();
});
