const http = require('http');

const allowedOrigin =
  'https://cerood-stage14-test.susikumar0123.workers.dev';

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;

  res.setHeader('Vary', 'Origin');

  if (origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.writeHead(204).end();
  }

  if (req.method === 'GET' && req.url === '/api/hero-banners') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    return res.end(JSON.stringify({
      success: true,
      banners: []
    }));
  }

  res.writeHead(404, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify({
    success: false,
    error: 'Not found'
  }));
});

const PORT = process.env.PORT || 31014;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stage 14 isolated test API running on port ${PORT}`);
});