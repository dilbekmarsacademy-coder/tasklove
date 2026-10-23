'use strict';

// Vercel Function: barcha /api/* so'rovlari vercel.json rewrite orqali shu yerga keladi.

const { handleRequest } = require('../lib/app');

module.exports = (req, res) => {
  // Rewrite asl yo'lni ?__path= orqali uzatadi.
  const url = new URL(req.url || '/', 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const query = url.searchParams.toString();
    req.url = `/api/${original}${query ? `?${query}` : ''}`;
  }
  return handleRequest(req, res);
};
