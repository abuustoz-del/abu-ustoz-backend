// Deptor jonli aloqa (SSE) testlari:  node --test test/deptor_live.test.js
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

const opened = [];
after(async () => { for (const s of opened) await s.close(); });

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpl-'));
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 'test-secret', testMode: true });
  const app = express();
  app.use('/dp', dp.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/dp`;
  const post = async (url, token, body) => (await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  })).json();
  const login = async (phone) => (await (await fetch(base + '/test/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json()).token;
  const sync = (token, ops, name = '') => post('/sync', token, { since: 0, name, ops });

  /** Oqimga ulanadi; kelgan "change" hodisalari sonini sanaydi. */
  async function listen(token) {
    const ac = new AbortController();
    const res = await fetch(base + '/events', { headers: { authorization: 'Bearer ' + token }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const state = { changes: 0, hello: false };
    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          const t = dec.decode(chunk);
          if (t.includes('event: hello')) state.hello = true;
          state.changes += (t.match(/event: change/g) || []).length;
        }
      } catch {}
    })();
    const waitFor = async (n, ms = 1500) => {
      const end = Date.now() + ms;
      while (state.changes < n && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      return state.changes;
    };
    for (let i = 0; i < 40 && !state.hello; i++) await new Promise((r) => setTimeout(r, 25));
    return { state, waitFor, stop: () => ac.abort() };
  }

  const h = {
    login, sync, post, listen,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      dp.close();
    },
  };
  opened.push(h);
  return h;
}

const debt = (over = {}) => ({
  op: 'debt', ref: 'LIVE0001', counter: BOTIR, dir: 'gave', kind: 'debt', amount: 5000000,
  currency: 'UZS', note: 'x', date: 1760000000000, due: null, ...over,
});

test('Abu qarz yozsa Botir\'ning oqimiga darhol "change" keladi, Ali\'ga kelmaydi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  const ali = await s.login(ALI);
  const lb = await s.listen(botir);
  const la = await s.listen(ali);
  const lAbu = await s.listen(abu);

  const t0 = Date.now();
  await s.sync(abu, [debt()], 'Abu');
  assert.equal(await lb.waitFor(1), 1);
  assert.ok(Date.now() - t0 < 1000, 'xabar 1 soniyadan tez kelishi kerak');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(la.state.changes, 0); // begona odamga bildirilmaydi
  assert.equal(lAbu.state.changes, 0); // yuboruvchining o'ziga ham yo'q
  [lb, la, lAbu].forEach((l) => l.stop());
  await s.close();
});

test('Botir tasdiqlasa Abu\'ga, qaytarish kiritilsa ikkinchi tomonga xabar boradi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  await s.sync(abu, [debt()], 'Abu');
  const la = await s.listen(abu);
  const lb = await s.listen(botir);
  await s.sync(botir, [{ op: 'respond', ref: 'LIVE0001', status: 'confirmed' }]);
  assert.equal(await la.waitFor(1), 1);
  await s.sync(abu, [{ op: 'pay', uid: 'LIVEPAY0001', ref: 'LIVE0001', amount: 1000000, date: 1 }]);
  assert.equal(await lb.waitFor(1), 1);
  [la, lb].forEach((l) => l.stop());
  await s.close();
});

test('rad etilgan amal (xato) bildirishnoma yubormaydi', async () => {
  const s = await boot();
  const abu = await s.login(ABU);
  const botir = await s.login(BOTIR);
  const lb = await s.listen(botir);
  await s.sync(abu, [debt({ amount: -5 })]); // noto'g'ri summa
  assert.equal(await lb.waitFor(1, 400), 0);
  lb.stop();
  await s.close();
});

test('do\'kon: sotuvchi qarz yozsa do\'kondoshlarga xabar boradi, taklif qilingan odamga ham', async () => {
  const s = await boot();
  const ega = await s.login(ABU);
  const sot = await s.login(BOTIR);
  await s.sync(sot, [], 'Sardor');
  const le = await s.listen(ega);
  const ls = await s.listen(sot);
  await s.sync(ega, [{ op: 'shop_create', name: 'Temir do\'kon' }]);
  await s.sync(ega, [{ op: 'shop_invite', phone: BOTIR }]);
  assert.ok((await ls.waitFor(1)) >= 1); // taklif keldi
  await s.sync(sot, [{ op: 'shop_accept' }]);
  assert.ok((await le.waitFor(1)) >= 1);
  const before = le.state.changes;
  await s.sync(sot, [debt({ ref: 'LIVE0099', counter: ALI, shop: true })], 'Sardor');
  assert.ok((await le.waitFor(before + 1)) > before); // ega yangi do'kon qarzini darhol bilib oladi
  [le, ls].forEach((l) => l.stop());
  await s.close();
});
