'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.GRACE_PERIOD_MINUTES = '15';
const store = require('../server/store');

function makeUser(name, neighborhood = 'testville') {
  return store.registerUser({ name, car: `${name}'s car`, neighborhood });
}

test('register normalizes neighborhood and returns a pseudonymous id', () => {
  const u = store.registerUser({ name: 'Jess', car: 'Blue Honda Fit', neighborhood: '  Maple Wood North ' });
  assert.ok(u.id.length > 8);
  assert.strictEqual(u.neighborhood, 'maple-wood-north');
  assert.deepStrictEqual(store.getUser(u.id), u);
});

test('warming announcement expires exactly at the grace period', () => {
  const u = makeUser('Warmer', 'hood-a');
  const before = Date.now();
  const ann = store.createAnnouncement(u, { mode: 'warming', locationText: 'Elm & 3rd' });
  assert.strictEqual(ann.mode, 'warming');
  const graceMs = 15 * 60 * 1000;
  assert.ok(ann.leavingAt >= before + graceMs && ann.leavingAt <= Date.now() + graceMs);
  assert.strictEqual(ann.expiresAt, ann.leavingAt);
});

test('scheduled announcement rejects past and too-distant times', () => {
  const u = makeUser('Scheduler', 'hood-b');
  assert.throws(() => store.createAnnouncement(u, { mode: 'scheduled', leavingAt: Date.now() - 1000 }), /future/);
  assert.throws(
    () => store.createAnnouncement(u, { mode: 'scheduled', leavingAt: Date.now() + 999 * 60 * 60 * 1000 }),
    /within/
  );
  const ann = store.createAnnouncement(u, { mode: 'scheduled', leavingAt: Date.now() + 30 * 60 * 1000 });
  assert.ok(ann.expiresAt > ann.leavingAt, 'stays visible through grace window after stated time');
});

test('feed is scoped to the neighborhood and sorted soonest-first', () => {
  const a = makeUser('A', 'hood-feed');
  const b = makeUser('B', 'hood-feed');
  const outsider = makeUser('C', 'other-hood');
  store.createAnnouncement(a, { mode: 'scheduled', leavingAt: Date.now() + 60 * 60 * 1000 });
  store.createAnnouncement(b, { mode: 'warming' });
  store.createAnnouncement(outsider, { mode: 'warming' });

  const feed = store.listAnnouncements('hood-feed');
  assert.strictEqual(feed.length, 2);
  assert.strictEqual(feed[0].ownerName, 'B', 'warming (sooner) sorts first');
  assert.ok(feed.every((s) => s.neighborhood === 'hood-feed'));
});

test('claim lifecycle: no self-claim, no double-claim, complete deletes', () => {
  const owner = makeUser('Owner', 'hood-claim');
  const claimer = makeUser('Claimer', 'hood-claim');
  const rival = makeUser('Rival', 'hood-claim');
  const ann = store.createAnnouncement(owner, { mode: 'warming' });

  assert.throws(() => store.claimAnnouncement(ann.id, owner), /own spot/);
  const claimed = store.claimAnnouncement(ann.id, claimer);
  assert.strictEqual(claimed.status, 'claimed');
  assert.throws(() => store.claimAnnouncement(ann.id, rival), /already claimed/);

  assert.throws(() => store.completeAnnouncement(ann.id, claimer.id), /only the announcer/);
  store.completeAnnouncement(ann.id, owner.id);
  assert.strictEqual(store.listAnnouncements('hood-claim').length, 0, 'Tier 1 data deleted on completion');
});

test('a new announcement replaces the user\'s previous one', () => {
  const u = makeUser('Replacer', 'hood-replace');
  store.createAnnouncement(u, { mode: 'warming' });
  store.createAnnouncement(u, { mode: 'scheduled', leavingAt: Date.now() + 20 * 60 * 1000 });
  assert.strictEqual(store.listAnnouncements('hood-replace').length, 1);
});

test('sweeper hard-deletes expired announcements', () => {
  const u = makeUser('Expirer', 'hood-expire');
  const ann = store.createAnnouncement(u, { mode: 'warming' });
  ann.expiresAt = Date.now() - 1; // simulate the grace period elapsing
  store.sweep();
  assert.strictEqual(store.listAnnouncements('hood-expire').length, 0);
});
