const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const apiHandler = require('./api/submit');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_BODY_BYTES = 1024 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function createResponseAdapter(res) {
  return {
    setHeader: (name, value) => res.setHeader(name, value),
    status: code => {
      res.statusCode = code;
      return {
        json: payload => sendJson(res, code, payload),
        end: () => res.end()
      };
    },
    json: payload => sendJson(res, res.statusCode || 200, payload),
    end: () => res.end()
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { success: false, message: 'Not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (parsedUrl.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (parsedUrl.pathname === '/api/submit') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req) : {};
      await apiHandler(req, createResponseAdapter(res));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, parsedUrl.pathname);
      return;
    }
    sendJson(res, 405, { success: false, message: 'Method not allowed' });
  } catch (error) {
    console.error('Request failed:', error);
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { success: false, message: error.statusCode === 413 ? '请求体过大' : '服务器错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Takeaway Theft server listening on port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
