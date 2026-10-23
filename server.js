'use strict';

// Lokal ishga tushirish uchun server. Vercelda esa api/index.js ishlatiladi.

const http = require('node:http');
const { handleRequest, pool } = require('./lib/app');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => handleRequest(req, res, { serveFiles: true }));

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  tasklove. tayyor — http://${shownHost}:${PORT}\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} band. Boshqa PORT bilan urinib ko'ring.`);
  } else {
    console.error('Server xatosi:', error);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n  Server yopilmoqda…');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
