'use strict';

/**
 * BUNCA HACCP — Static Server for Pure HTML+JS SPA
 * ------------------------------------------------
 * - Serves index.html, app.js and other static files
 * - No auth, no CSRF, no sessions — everything happens in the browser
 * - Health check: /healthz
 * - SPA fallback: unknown routes → index.html
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'index.html');

const app = express();
app.disable('x-powered-by');

// Security headers (allow inline styles for our CSS-in-HTML)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(morgan('combined'));

// Serve index at root without caching (so updates show up immediately)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(INDEX);
});

// Static files with light caching
app.use(express.static(ROOT, {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(js|css|svg|png|jpg|jpeg|gif|webp|ico|txt|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// Health check for Render
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// SPA fallback (not strictly required for hash routes, but safe)
app.get('*', (req, res) => {
  // If a request looks like a file (has an extension) and wasn't found → 404
  if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(INDEX);
});

app.listen(PORT, () => {
  console.log(`✅ Static server running at http://localhost:${PORT}`);
});
