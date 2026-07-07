'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server/server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function register(name, neighborhood = 'api-test-hood') {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, car: `${name}'s car`, neighborhood }),
  });
  assert.strictEqual(res.status, 201);
  return (await res.json()).user;
}

function authed(user) {
  return { 'Content-Type': 'application/json', 'X-User-Id': user.id };
}

test('rejects unauthenticated and malformed requests', async () => {
  assert.strictEqual((await fetch(`${base}/api/spots`)).status, 401);

  const bad = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NoCar' }),
  });
  assert.strictEqual(bad.status, 400);

  const invalid = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assert.strictEqual(invalid.status, 400);
});

test('full handoff over HTTP: announce → feed → claim → complete', async () => {
  const owner = await register('Owner', 'http-hood');
  const claimer = await register('Claimer', 'http-hood');

  const created = await fetch(`${base}/api/spots`, {
    method: 'POST',
    headers: authed(owner),
    body: JSON.stringify({ mode: 'warming', locationText: 'Oak & 5th' }),
  });
  assert.strictEqual(created.status, 201);
  const { spot } = await created.json();

  const feed = await (await fetch(`${base}/api/spots`, { headers: authed(claimer) })).json();
  const seen = feed.spots.find((s) => s.id === spot.id);
  assert.ok(seen, 'claimer sees the announcement');
  assert.strictEqual(seen.isMine, false);

  const claim = await fetch(`${base}/api/spots/${spot.id}/claim`, {
    method: 'POST',
    headers: authed(claimer),
  });
  assert.strictEqual(claim.status, 200);

  const complete = await fetch(`${base}/api/spots/${spot.id}/complete`, {
    method: 'POST',
    headers: authed(owner),
  });
  assert.strictEqual(complete.status, 200);

  const after = await (await fetch(`${base}/api/spots`, { headers: authed(claimer) })).json();
  assert.ok(!after.spots.some((s) => s.id === spot.id), 'completed spot is gone');
});

test('SSE stream pushes an update when a spot is announced', async () => {
  const watcher = await register('Watcher', 'sse-hood');
  const announcer = await register('Announcer', 'sse-hood');

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/stream?u=${watcher.id}`, {
    signal: controller.signal,
  });
  assert.strictEqual(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();

  const gotUpdate = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: update')) return true;
    }
  })();

  await fetch(`${base}/api/spots`, {
    method: 'POST',
    headers: authed(announcer),
    body: JSON.stringify({ mode: 'warming' }),
  });

  const result = await Promise.race([
    gotUpdate,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
  ]);
  controller.abort();
  assert.strictEqual(result, true, 'update event arrived over the stream');
});

test('stream requires a known user', async () => {
  assert.strictEqual((await fetch(`${base}/api/stream?u=nope`)).status, 401);
});

test('static app shell is served', async () => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /SpotSwap/);
  assert.strictEqual((await fetch(`${base}/../etc/passwd`)).status, 404);
});
