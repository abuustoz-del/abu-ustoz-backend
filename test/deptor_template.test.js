// Deptor shartnoma shabloni:  node --test test/deptor_template.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { create } = require('../src/deptor/sync');

async function boot(templateFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-'));
  const dp = create({ dbFile: path.join(dir, 't.db'), secret: 'x', testMode: true, templateFile });
  const app = express();
  app.use('/dp', dp.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/dp/contract-template`, close: () => new Promise((r) => server.close(r)) };
}

test("shablon: yo'q bo'lsa 404, to'g'ri bo'lsa qaytadi, buzuq bo'lsa 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-f-'));
  const f = path.join(dir, 'ct.json');
  let s = await boot(f);
  assert.equal((await fetch(s.url)).status, 404);
  const good = { version: 2, uz: { title: 'A', sections: [] }, ru: { title: 'B', sections: [] } };
  fs.writeFileSync(f, JSON.stringify(good));
  const r = await fetch(s.url);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), good);
  fs.writeFileSync(f, JSON.stringify({ version: 2, uz: { title: 'A', sections: [] } }));
  assert.equal((await fetch(s.url)).status, 404);
  fs.writeFileSync(f, 'not json');
  assert.equal((await fetch(s.url)).status, 404);
  await s.close();
});
