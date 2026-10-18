// Faqat Deptor sinxronlash modulini ishga tushiradi (Flutter e2e testi uchun).
//   DP_TEST_MODE=1 DATA_DIR=<papka> PORT=<port> node test/dp_server.js
const express = require('express');
const { create } = require('../src/deptor/sync');

const dp = create({ secret: 'e2e-secret', testMode: true });
const app = express();
app.use('/dp', dp.router);
const port = Number(process.env.PORT) || 3999;
app.listen(port, '127.0.0.1', () => console.log('READY ' + port));
