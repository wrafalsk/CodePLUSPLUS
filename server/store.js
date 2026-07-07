'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Fires 'change' with the neighborhood name whenever matching state mutates,
// so the server can push live updates to connected clients.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const GRACE_PERIOD_MINUTES = Number(process.env.GRACE_PERIOD_MINUTES) || 15;
const SCHEDULED_TTL_MINUTES = Number(process.env.SCHEDULED_TTL_MINUTES) || 240;
const SWEEP_INTERVAL_MS = 30 * 1000;

// Tier 2: pseudonymous profiles. id -> { id, name, car, neighborhood, createdAt }
const users = new Map();

// Tier 1: ephemeral matching state. id -> announcement
// { id, userId, neighborhood, car, locationText, mode: 'scheduled'|'warming',
//   leavingAt, expiresAt, claimedBy, status: 'open'|'claimed'|'completed' }
const announcements = new Map();

function id() {
  return crypto.randomBytes(9).toString('base64url');
}

// Anonymous lifecycle log — the raw material for tuning the grace period.
// In production this would go to an analytics sink; here it goes to stdout.
function logEvent(event, ann) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    event, // created | claimed | unclaimed | completed | expired
    mode: ann.mode,
    neighborhood: ann.neighborhood,
    gracePeriodMinutes: GRACE_PERIOD_MINUTES,
    msSinceCreated: Date.now() - ann.createdAt,
    wasClaimed: !!ann.claimedBy,
  }));
}

function registerUser({ name, car, neighborhood }) {
  const user = {
    id: id(),
    name: String(name).slice(0, 40),
    car: String(car).slice(0, 60),
    neighborhood: normalizeNeighborhood(neighborhood),
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  return user;
}

function normalizeNeighborhood(n) {
  return String(n).toLowerCase().trim().replace(/\s+/g, '-').slice(0, 60);
}

function getUser(userId) {
  return users.get(userId) || null;
}

function createAnnouncement(user, { mode, leavingAt, locationText }) {
  // One active announcement per user — replace any existing one.
  for (const ann of announcements.values()) {
    if (ann.userId === user.id) announcements.delete(ann.id);
  }

  const now = Date.now();
  let leaving, expires;
  if (mode === 'warming') {
    leaving = now + GRACE_PERIOD_MINUTES * 60 * 1000;
    expires = leaving;
  } else {
    leaving = Number(leavingAt);
    if (!Number.isFinite(leaving) || leaving <= now) {
      throw Object.assign(new Error('leavingAt must be a future timestamp'), { status: 400 });
    }
    if (leaving - now > SCHEDULED_TTL_MINUTES * 60 * 1000) {
      throw Object.assign(
        new Error(`leavingAt must be within ${SCHEDULED_TTL_MINUTES} minutes`),
        { status: 400 }
      );
    }
    // Keep it visible through the grace window after the stated time.
    expires = leaving + GRACE_PERIOD_MINUTES * 60 * 1000;
  }

  const ann = {
    id: id(),
    userId: user.id,
    neighborhood: user.neighborhood,
    car: user.car,
    ownerName: user.name,
    locationText: String(locationText || '').slice(0, 100),
    mode: mode === 'warming' ? 'warming' : 'scheduled',
    leavingAt: leaving,
    expiresAt: expires,
    createdAt: now,
    claimedBy: null,
    claimerName: null,
    status: 'open',
  };
  announcements.set(ann.id, ann);
  logEvent('created', ann);
  bus.emit('change', ann.neighborhood);
  return ann;
}

function listAnnouncements(neighborhood) {
  const hood = normalizeNeighborhood(neighborhood);
  return [...announcements.values()]
    .filter((a) => a.neighborhood === hood)
    .sort((a, b) => a.leavingAt - b.leavingAt);
}

function claimAnnouncement(annId, claimer) {
  const ann = announcements.get(annId);
  if (!ann) throw Object.assign(new Error('announcement not found'), { status: 404 });
  if (ann.userId === claimer.id) {
    throw Object.assign(new Error("you can't claim your own spot"), { status: 400 });
  }
  if (ann.claimedBy && ann.claimedBy !== claimer.id) {
    throw Object.assign(new Error('spot already claimed'), { status: 409 });
  }
  ann.claimedBy = claimer.id;
  ann.claimerName = claimer.name;
  ann.status = 'claimed';
  logEvent('claimed', ann);
  bus.emit('change', ann.neighborhood);
  return ann;
}

function completeAnnouncement(annId, userId) {
  const ann = announcements.get(annId);
  if (!ann) throw Object.assign(new Error('announcement not found'), { status: 404 });
  if (ann.userId !== userId) {
    throw Object.assign(new Error('only the announcer can complete a handoff'), { status: 403 });
  }
  ann.status = 'completed';
  logEvent('completed', ann);
  announcements.delete(ann.id); // Tier 1 data: gone the moment it's done.
  bus.emit('change', ann.neighborhood);
  return ann;
}

function cancelAnnouncement(annId, userId) {
  const ann = announcements.get(annId);
  if (!ann) return;
  if (ann.userId !== userId) {
    throw Object.assign(new Error('only the announcer can cancel'), { status: 403 });
  }
  logEvent('unclaimed', ann);
  announcements.delete(ann.id);
  bus.emit('change', ann.neighborhood);
}

// TTL sweeper — deletion is the default state of Tier 1 data.
function sweep() {
  const now = Date.now();
  for (const ann of announcements.values()) {
    if (ann.expiresAt <= now) {
      logEvent('expired', ann);
      announcements.delete(ann.id);
      bus.emit('change', ann.neighborhood);
    }
  }
}

const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
sweeper.unref();

module.exports = {
  GRACE_PERIOD_MINUTES,
  bus,
  registerUser,
  getUser,
  createAnnouncement,
  listAnnouncements,
  claimAnnouncement,
  completeAnnouncement,
  cancelAnnouncement,
  sweep, // exported for tests
};
