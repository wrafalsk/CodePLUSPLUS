'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireUser(req) {
  const userId = req.headers['x-user-id'];
  const user = userId && store.getUser(userId);
  if (!user) {
    throw Object.assign(new Error('unknown user — register first'), { status: 401 });
  }
  return user;
}

function publicAnnouncement(a) {
  return {
    id: a.id,
    car: a.car,
    ownerName: a.ownerName,
    locationText: a.locationText,
    mode: a.mode,
    leavingAt: a.leavingAt,
    expiresAt: a.expiresAt,
    status: a.status,
    claimerName: a.claimerName,
    isMine: undefined, // filled per-request
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/config') {
    return sendJson(res, 200, { gracePeriodMinutes: store.GRACE_PERIOD_MINUTES });
  }

  // Live updates. EventSource can't set headers, so the user id rides in the
  // query string; it's the same pseudonymous token the header carries.
  if (route === 'GET /api/stream') {
    const userId = url.searchParams.get('u');
    const user = userId && store.getUser(userId);
    if (!user) {
      throw Object.assign(new Error('unknown user — register first'), { status: 401 });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    const onChange = (neighborhood) => {
      if (neighborhood === user.neighborhood) res.write('event: update\ndata: {}\n\n');
    };
    store.bus.on('change', onChange);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25 * 1000);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.bus.off('change', onChange);
    });
    return;
  }

  if (route === 'POST /api/register') {
    const body = await readBody(req);
    for (const field of ['name', 'car', 'neighborhood']) {
      if (!body[field] || !String(body[field]).trim()) {
        return sendJson(res, 400, { error: `${field} is required` });
      }
    }
    const user = store.registerUser(body);
    return sendJson(res, 201, { user });
  }

  if (route === 'GET /api/spots') {
    const user = requireUser(req);
    const spots = store.listAnnouncements(user.neighborhood).map((a) => ({
      ...publicAnnouncement(a),
      isMine: a.userId === user.id,
      claimedByMe: a.claimedBy === user.id,
    }));
    return sendJson(res, 200, { neighborhood: user.neighborhood, spots });
  }

  if (route === 'POST /api/spots') {
    const user = requireUser(req);
    const body = await readBody(req);
    const ann = store.createAnnouncement(user, body);
    return sendJson(res, 201, { spot: { ...publicAnnouncement(ann), isMine: true } });
  }

  const claimMatch = url.pathname.match(/^\/api\/spots\/([\w-]+)\/(claim|complete|cancel)$/);
  if (req.method === 'POST' && claimMatch) {
    const user = requireUser(req);
    const [, spotId, action] = claimMatch;
    if (action === 'claim') {
      const ann = store.claimAnnouncement(spotId, user);
      return sendJson(res, 200, { spot: publicAnnouncement(ann) });
    }
    if (action === 'complete') {
      store.completeAnnouncement(spotId, user.id);
      return sendJson(res, 200, { ok: true });
    }
    store.cancelAnnouncement(spotId, user.id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(PUBLIC_DIR, filePath);
  if (!absolute.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(absolute, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(absolute)] || 'application/octet-stream',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SpotSwap listening on http://localhost:${PORT}`);
    console.log(`Grace period: ${store.GRACE_PERIOD_MINUTES} minutes`);
  });
}

module.exports = { server };
