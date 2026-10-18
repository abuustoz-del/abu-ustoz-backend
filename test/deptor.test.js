// Deptor sinxronlash serveri testlari:  node --test test/
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { create } = require('../src/deptor/sync');

const ABU = '+998901111111';
const BOTIR = '+998932222222';
const ALI = '+998973333333';

// Test yiqilsa ham serverlar yopilsin - aks holda jarayon chiqmay qoladi.
const opened = [];
after(async () => { for (const s of opened) await s.close(); });

async function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 'test-secret', testMode: true, ...opts });
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
  const handle = {
    dp, call, login, sync,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections(); // fetch keep-alive ulanishlari serverni yopishga to'sqinlik qilmasin
      await new Promise((r) => server.close(r));
      dp.close();
    },
  };
  opened.push(handle);
  return handle;
}

const debtOp = (over = {}) => ({
  op: 'debt', ref: 'REF00001', counter: BOTIR, dir: 'gave', kind: 'debt',
  amount: 50000000, currency: 'UZS', note: 'shashlik', date: 1760000000000, due: null, ...over,
});

test('tokensiz so\'rov rad etiladi', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/sync', { body: { ops: [] } })).status, 401);
  assert.equal((await s.call('POST', '/sync', { token: 'yolgon', body: { ops: [] } })).status, 401);
  await s.close();
});

test('Abu qarz yozadi - Botirning ilovasida paydo bo\'ladi (kutilmoqda)', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);

  const r = await s.sync(abu, [debtOp()], 0, 'Abu');
  assert.deepEqual(r.rejected, []);
  assert.equal(r.debts.length, 1);
  assert.equal(r.debts[0].status, 'pending');
  assert.equal(r.debts[0].creatorName, 'Abu');

  const b = await s.sync(botir, [], 0, 'Botir');
  assert.equal(b.debts.length, 1);
  assert.equal(b.debts[0].creator, ABU);
  assert.equal(b.debts[0].counter, BOTIR);
  assert.equal(b.debts[0].amount, 50000000);
  assert.deepEqual(b.registered, [ABU]);
  await s.close();
});

test('Botir hali kirmagan bo\'lsa ham, keyin kirganda qarzni ko\'radi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const r = await s.sync(abu, [debtOp({ counter: ALI })], 0, 'Abu');
  assert.deepEqual(r.registered, []); // Ali Deptor'da yo'q
  const ali = await s.login(ALI);
  const a = await s.sync(ali, [], 0, 'Ali');
  assert.equal(a.debts.length, 1);
  await s.close();
});

test('Botir tasdiqlaydi yoki rad etadi; begona tasdiqlay olmaydi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  const ali = await s.login(ALI);
  await s.sync(abu, [debtOp()], 0, 'Abu');

  // Yaratuvchining o'zi tasdiqlay olmaydi
  let r = await s.sync(abu, [{ op: 'respond', ref: 'REF00001', status: 'confirmed' }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  // Begona ham
  r = await s.sync(ali, [{ op: 'respond', ref: 'REF00001', status: 'confirmed' }]);
  assert.ok(['forbidden', 'not_found'].includes(r.rejected[0].reason));

  r = await s.sync(botir, [{ op: 'respond', ref: 'REF00001', status: 'confirmed' }]);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.debts[0].status, 'confirmed');

  // Abu keyingi sinxronlashda tasdiqni ko'radi
  const a = await s.sync(abu, [], 0);
  assert.equal(a.debts[0].status, 'confirmed');
  await s.close();
});

test('faqat yaratuvchi summani o\'zgartira oladi; o\'zgarsa tasdiq qaytadan so\'raladi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debtOp()], 0, 'Abu');
  await s.sync(botir, [{ op: 'respond', ref: 'REF00001', status: 'confirmed' }]);

  // Botir summani o'zgartira olmaydi
  let r = await s.sync(botir, [debtOp({ amount: 1 })]);
  assert.equal(r.rejected[0].reason, 'forbidden');

  // Abu faqat izohni o'zgartirsa - tasdiq saqlanadi
  r = await s.sync(abu, [debtOp({ note: 'yangi izoh' })], 0);
  assert.equal(r.debts[0].status, 'confirmed');
  assert.equal(r.debts[0].note, 'yangi izoh');

  // Summani o'zgartirsa - yana "kutilmoqda"
  r = await s.sync(abu, [debtOp({ amount: 70000000 })], 0);
  assert.equal(r.debts[0].status, 'pending');
  assert.equal(r.debts[0].amount, 70000000);
  await s.close();
});

test('qaytarish: ikkala tomon qo\'sha oladi, ikkinchi tomonda ham ko\'rinadi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debtOp()], 0, 'Abu');

  // Botir "250 000 qaytardim" yozadi
  let r = await s.sync(botir, [{ op: 'pay', uid: 'PAYAAAAA1', ref: 'REF00001', amount: 25000000, date: 1760100000000 }]);
  assert.deepEqual(r.rejected, []);
  // Abu ko'radi
  const a = await s.sync(abu, [], 0);
  assert.equal(a.payments.length, 1);
  assert.equal(a.payments[0].by, BOTIR);
  assert.equal(a.payments[0].amount, 25000000);

  // Takroriy yuborish ikki marta hisoblanmaydi
  r = await s.sync(botir, [{ op: 'pay', uid: 'PAYAAAAA1', ref: 'REF00001', amount: 25000000, date: 1760100000000 }], 0);
  assert.equal(r.payments.length, 1);
  await s.close();
});

test('begona odam qarzga qaytarish qo\'sha olmaydi va qarzni ko\'rmaydi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const ali = await s.login(ALI);
  await s.sync(abu, [debtOp()], 0, 'Abu');
  const r = await s.sync(ali, [{ op: 'pay', uid: 'PAYBBBBB1', ref: 'REF00001', amount: 100, date: 1 }], 0);
  assert.equal(r.rejected[0].reason, 'forbidden');
  assert.equal(r.debts.length, 0);
  assert.equal(r.payments.length, 0);
  await s.close();
});

test('"kechirdim" faqat qarz bergan tomondan', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debtOp()], 0, 'Abu'); // Abu qarz bergan
  let r = await s.sync(botir, [{ op: 'close', ref: 'REF00001', closed: true }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await s.sync(abu, [{ op: 'close', ref: 'REF00001', closed: true }], 0);
  assert.equal(r.debts[0].closed, true);
  const b = await s.sync(botir, [], 0);
  assert.equal(b.debts[0].closed, true);
  await s.close();
});

test('o\'chirish: faqat yaratuvchi; ikkinchi tomon o\'chirilganini ko\'radi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debtOp()], 0, 'Abu');
  const first = await s.sync(botir, [], 0);
  let r = await s.sync(botir, [{ op: 'del_debt', ref: 'REF00001' }], first.rev);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await s.sync(abu, [{ op: 'del_debt', ref: 'REF00001' }], 0);
  assert.equal(r.debts[0].deleted, true);
  const b = await s.sync(botir, [], first.rev);
  assert.equal(b.debts[0].deleted, true);
  await s.close();
});

test('qaytarishni o\'chirish: muallif yoki ikkinchi tomon', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  const ali = await s.login(ALI);
  await s.sync(abu, [debtOp()], 0, 'Abu');
  await s.sync(botir, [{ op: 'pay', uid: 'PAYCCCCC1', ref: 'REF00001', amount: 100, date: 1 }]);
  let r = await s.sync(ali, [{ op: 'del_pay', uid: 'PAYCCCCC1' }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await s.sync(abu, [{ op: 'del_pay', uid: 'PAYCCCCC1' }], 0);
  assert.equal(r.payments[0].deleted, true);
  await s.close();
});

test('inkremental sinxronlash: faqat yangi o\'zgarishlar keladi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const r1 = await s.sync(abu, [debtOp()], 0, 'Abu');
  const r2 = await s.sync(abu, [], r1.rev);
  assert.equal(r2.debts.length, 0);
  assert.equal(r2.payments.length, 0);
  const r3 = await s.sync(abu, [debtOp({ ref: 'REF00002', amount: 100 })], r1.rev);
  assert.equal(r3.debts.length, 1);
  assert.equal(r3.debts[0].ref, 'REF00002');
  await s.close();
});

test('noto\'g\'ri ma\'lumotlar rad etiladi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const bad = [
    debtOp({ ref: 'x' }),                 // qisqa ref
    debtOp({ counter: ABU }),             // o'ziga qarz
    debtOp({ counter: '+1555' }),         // O'zbekiston raqami emas
    debtOp({ dir: 'xxx' }),
    debtOp({ amount: 0 }),
    debtOp({ amount: -5 }),
    debtOp({ amount: 1.5 }),
    debtOp({ date: 'kecha' }),
    { op: 'nomalum' },
    null,
  ];
  const r = await s.sync(abu, bad, 0);
  assert.equal(r.rejected.length, bad.length);
  assert.equal(r.debts.length, 0);
  await s.close();
});

test('bir xil ref ikki xil yaratuvchi tomonidan egallanmaydi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const ali = await s.login(ALI);
  await s.sync(abu, [debtOp()], 0, 'Abu');
  const r = await s.sync(ali, [debtOp({ counter: BOTIR, amount: 999 })], 0, 'Ali');
  assert.equal(r.rejected[0].reason, 'forbidden');
  const a = await s.sync(abu, [], 0);
  assert.equal(a.debts[0].amount, 50000000);
  await s.close();
});

test('lookup: Deptor\'da bor-yo\'qligini aytadi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  await s.login(BOTIR);
  assert.equal((await s.call('GET', '/lookup?phone=' + encodeURIComponent(BOTIR), { token: abu })).json.registered, true);
  assert.equal((await s.call('GET', '/lookup?phone=' + encodeURIComponent(ALI), { token: abu })).json.registered, false);
  assert.equal((await s.call('GET', '/lookup?phone=123', { token: abu })).json.registered, false);
  await s.close();
});

test('chiqish: eski token ishlamay qoladi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  assert.equal((await s.call('POST', '/logout', { token: abu })).status, 200);
  assert.equal((await s.call('POST', '/sync', { token: abu, body: { ops: [] } })).status, 401);
  const again = await s.login(ABU);
  assert.equal((await s.call('POST', '/sync', { token: again, body: { ops: [] } })).status, 200);
  await s.close();
});

test('kirish: bot orqali tasdiqlangach token bir marta beriladi', async () => {
  const s = await boot();
  const st = (await s.call('POST', '/login/start')).json;
  assert.ok(st.code);
  assert.equal((await s.call('GET', '/login/poll?code=' + st.code)).json.status, 'pending');
  s.dp._test.completeLogin(s.dp.sessions.get(st.code), ABU, 12345);
  const done = (await s.call('GET', '/login/poll?code=' + st.code)).json;
  assert.equal(done.status, 'done');
  assert.equal(done.phone, ABU);
  const ok = await s.call('POST', '/sync', { token: done.token, body: { ops: [] } });
  assert.equal(ok.status, 200);
  assert.equal((await s.call('GET', '/login/poll?code=' + st.code)).json.status, 'expired');
  await s.close();
});

test('juda ko\'p amal bitta so\'rovda rad etiladi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const ops = Array.from({ length: 501 }, (_, i) => debtOp({ ref: 'REFX' + String(i).padStart(5, '0') }));
  const res = await s.call('POST', '/sync', { token: abu, body: { ops } });
  assert.equal(res.status, 413);
  await s.close();
});

test("yaratuvchining yorlig'i (cname) faqat o'ziga qaytadi", async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debtOp({ cname: 'Botir aka' })], 0, 'Abu');
  const a = await s.sync(abu, [], 0);
  const b = await s.sync(botir, [], 0);
  assert.equal(a.debts[0].counterName, 'Botir aka');
  assert.equal(b.debts[0].counterName, ''); // Botir bu yorliqni ko'rmaydi
  assert.equal(b.debts[0].creatorName, 'Abu');
  await s.close();
});

test("katta natija sahifalanadi: hech narsa yo'qolmaydi va takrorlanmaydi", async () => {
  const s = await boot({ pullDebts: 2, pullPays: 3 });
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  const ops = [];
  for (let i = 1; i <= 5; i++) ops.push(debtOp({ ref: 'PAGE000' + i, amount: i * 100 }));
  await s.sync(abu, ops, 0, 'Abu');
  // 7 ta qaytarish ham qo'shamiz
  const pays = [];
  for (let i = 1; i <= 7; i++) pays.push({ op: 'pay', uid: 'PAYPAGE' + String(i).padStart(2, '0'), ref: 'PAGE0001', amount: 1, date: i });
  await s.sync(botir, pays, 0, 'Botir');

  const seenDebts = new Set();
  const seenPays = new Set();
  let since = 0;
  let rounds = 0;
  for (;;) {
    const r = await s.sync(botir, [], since);
    for (const d of r.debts) { assert.ok(!seenDebts.has(d.ref), 'takror qarz'); seenDebts.add(d.ref); }
    for (const p of r.payments) { assert.ok(!seenPays.has(p.uid), 'takror qaytarish'); seenPays.add(p.uid); }
    since = r.rev;
    rounds++;
    assert.ok(rounds < 20, 'cheksiz sikl');
    if (!r.more) break;
  }
  assert.equal(seenDebts.size, 5);
  assert.equal(seenPays.size, 7);
  assert.ok(rounds > 1, 'sahifalash ishlamadi');
  await s.close();
});
