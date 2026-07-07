'use strict';

// Grace-period experiment harness.
//
// The 15-minute "warming up" window is a hypothesis. This simulator generates
// synthetic neighborhood traffic — drivers announcing departures and seekers
// hunting for spots — and sweeps a range of grace-period lengths to show how
// the window changes handoff outcomes. Once the app has real users, feed the
// anonymous lifecycle logs (created/claimed/completed/expired) through the
// same metrics instead of the synthetic generator.
//
// Usage:
//   node tools/simulate.js [--hours 12] [--departures 20] [--seekers 24] [--seed 42]
//     --hours       simulated span in hours
//     --departures  departure announcements per hour
//     --seekers     spot-seeking drivers per hour
//     --seed        RNG seed (results are reproducible for a given seed)

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
}

const HOURS = arg('hours', 12);
const DEPARTURES_PER_HOUR = arg('departures', 20);
const SEEKERS_PER_HOUR = arg('seekers', 24);
const SEED = arg('seed', 42);
const GRACE_PERIODS = [5, 10, 15, 20, 30];

// Deterministic PRNG (mulberry32) so experiments are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand, mean, sd) {
  const u = 1 - rand();
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Behavioral assumptions (minutes). Tune these against real traffic later.
const BEHAVIOR = {
  // How long after tapping "warming up" the driver *actually* pulls out —
  // independent of what the app promises. Mean 12, sd 5, clamped 2–40.
  actualLeave: (rand) => clamp(normal(rand, 12, 5), 2, 40),
  // Seeker's drive time to a claimed spot.
  travel: (rand) => 2 + rand() * 6,
  // How long a seeker will idle next to a still-occupied spot.
  patience: (rand) => 3 + rand() * 7,
  // How long a vacated spot survives before a random member of the public
  // takes it (exponential, mean 4).
  vacancyLife: (rand) => -4 * Math.log(1 - rand()),
};

function simulate(graceMinutes, rand) {
  const spanMin = HOURS * 60;

  const departures = Array.from({ length: Math.round(DEPARTURES_PER_HOUR * HOURS) }, () => {
    const announcedAt = rand() * spanMin;
    return {
      announcedAt,
      expiresAt: announcedAt + graceMinutes,
      actualLeaveAt: announcedAt + BEHAVIOR.actualLeave(rand),
      claimed: false,
    };
  }).sort((a, b) => a.announcedAt - b.announcedAt);

  const seekers = Array.from({ length: Math.round(SEEKERS_PER_HOUR * HOURS) }, () => ({
    searchAt: rand() * spanMin,
    travel: BEHAVIOR.travel(rand),
    patience: BEHAVIOR.patience(rand),
  })).sort((a, b) => a.searchAt - b.searchAt);

  const outcomes = { success: 0, gaveUp: 0, lostToPublic: 0 };
  let totalWait = 0;

  for (const seeker of seekers) {
    // Pick the live announcement expiring soonest (the app's soonest-first feed).
    const spot = departures
      .filter((d) => !d.claimed && d.announcedAt <= seeker.searchAt && seeker.searchAt < d.expiresAt)
      .sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (!spot) continue; // nothing on the feed; seeker parks the old way

    spot.claimed = true;
    const arriveAt = seeker.searchAt + seeker.travel;

    if (arriveAt >= spot.actualLeaveAt) {
      // Car already gone — was the spot still vacant?
      const vacantFor = arriveAt - spot.actualLeaveAt;
      if (vacantFor <= BEHAVIOR.vacancyLife(rand)) {
        outcomes.success++;
      } else {
        outcomes.lostToPublic++;
      }
    } else {
      // Car still there — will the seeker outwait it?
      const wait = spot.actualLeaveAt - arriveAt;
      if (wait <= seeker.patience) {
        outcomes.success++;
        totalWait += wait;
      } else {
        outcomes.gaveUp++;
      }
    }
  }

  const claims = outcomes.success + outcomes.gaveUp + outcomes.lostToPublic;
  const expiredUnclaimed = departures.filter((d) => !d.claimed).length;
  return {
    graceMinutes,
    claims,
    claimRate: claims / departures.length,
    successRate: claims ? outcomes.success / claims : 0,
    gaveUpRate: claims ? outcomes.gaveUp / claims : 0,
    lostRate: claims ? outcomes.lostToPublic / claims : 0,
    avgWaitMin: outcomes.success ? totalWait / outcomes.success : 0,
    expiredUnclaimed,
  };
}

const pct = (x) => `${(100 * x).toFixed(0)}%`;

console.log(`SpotSwap grace-period sweep — ${HOURS}h, ${DEPARTURES_PER_HOUR} departures/h, ${SEEKERS_PER_HOUR} seekers/h, seed ${SEED}\n`);
console.log('grace  claimed  handoff-ok  gave-up  lost-to-public  avg-wait  expired-unclaimed');
for (const g of GRACE_PERIODS) {
  const r = simulate(g, rng(SEED + g));
  console.log(
    `${String(g).padStart(4)}m` +
    `  ${pct(r.claimRate).padStart(7)}` +
    `  ${pct(r.successRate).padStart(10)}` +
    `  ${pct(r.gaveUpRate).padStart(7)}` +
    `  ${pct(r.lostRate).padStart(14)}` +
    `  ${r.avgWaitMin.toFixed(1).padStart(6)}m` +
    `  ${String(r.expiredUnclaimed).padStart(17)}`
  );
}
console.log(
  '\nReading the table: short windows expire before drivers actually leave' +
  '\n(fewer claims, more give-ups); long windows get claimed early and strand' +
  '\nseekers waiting. The sweet spot maximizes handoff-ok without inflating' +
  '\navg-wait. Swap the BEHAVIOR distributions for measurements from real' +
  '\nlifecycle logs as traffic arrives.'
);
