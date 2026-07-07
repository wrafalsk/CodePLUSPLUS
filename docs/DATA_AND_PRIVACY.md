# Do users or their info need to be stored on the app or server?

The one-sentence answer: **some shared state must live on a server, because
the whole point is matching strangers to each other — but it can be
pseudonymous, coarse, and mostly ephemeral.** A pure client-only design
cannot work, and a heavyweight accounts-with-PII design is unnecessary.

## Why a server is unavoidable

Two users who have never met need to see each other's state:

- Driver A announces "spot opening on Elm St at 5:40."
- Driver B, circling three blocks away, needs that announcement to appear
  on their phone within seconds.

There is no practical way for B's browser to discover A's browser directly.
Peer-to-peer approaches (WebRTC mesh, local Bluetooth) fail here because
the users aren't co-located when it matters, browsers can't listen for
inbound connections in the background, and someone still has to run a
discovery/signaling service — which is a server. So the matching state
(who is leaving, where-ish, when) must transit and briefly rest on a
server.

## What must be stored, and for how long

The useful framing is not "server vs. no server" but **which tier each
piece of data belongs in**:

### Tier 1 — Server, ephemeral (TTL-deleted)
The live matching data. This is the only data the service *functionally*
needs, and none of it needs to outlive the parking event:

| Data | Why the server needs it | Lifetime |
|---|---|---|
| Departure announcements (time, status, block-level location text) | Other users must see them | Minutes; hard TTL, then deleted |
| "Warming up" status | The core real-time signal | Grace period (default 15 min) |
| Claims ("I'm heading there") | Coordinates the handoff | Until completion/expiry |
| Car description (make/model/color) *attached to an active announcement* | The arriving driver must recognize the car | Same TTL as the announcement |

### Tier 2 — Server, persistent but pseudonymous
The minimum to make the app usable across sessions and abuse-resistant:

| Data | Why | Notes |
|---|---|---|
| Pseudonymous user ID + display name | Rejoin without re-registering; rate-limiting; kicking bad actors | Random ID; no email/phone/real name required for MVP |
| Neighborhood membership | Scopes what you see and who sees you | A code/name, not your address |
| Car make/model/color (profile default) | Convenience — prefills announcements | **Could** live only on-device (Tier 3) and be sent per-announcement; storing it server-side is a convenience trade-off, not a requirement |
| Aggregate stats (completion rate, expired-unclaimed counts) | Tuning the grace period; reputation-lite | Aggregates only, no location history |

### Tier 3 — Device only (never sent)
Everything else stays in the browser's local storage:

- Session token / "remember me"
- UI preferences, saved neighborhood, prefill values
- Notification preferences

## What should *never* be collected

These are tempting but are liabilities, not features:

- **Precise GPS home/parking coordinates.** Block-level text ("Elm between
  3rd & 4th") is enough to find a car and doesn't build a map of where
  anyone lives. If geofencing is added later, store coarse (~100 m)
  snapped locations and still TTL them.
- **License plates.** Make/model/color suffices for recognition.
- **Location history.** Delete announcements on expiry; keep only
  anonymous aggregates for grace-period tuning.
- **Real identity (email/phone) for MVP.** Add optional verification later
  only if abuse demands it, and store a salted hash, not the raw value.

## Consequences for the prototype in this repo

- The server (`server/store.js`) keeps everything **in memory** with a TTL
  sweeper — deletion is the default, persistence is the exception. A real
  deployment would swap in a small DB for Tier 2 only.
- Registration asks for a pseudonym, car description, and neighborhood
  code. Nothing else.
- Every announcement carries an `expiresAt`; the sweeper hard-deletes
  expired records and logs an anonymous lifecycle event
  (`created/claimed/completed/expired`) for grace-period experiments.

## Regulatory footnote

Even pseudonymous IDs + coarse locations are "personal data" under
GDPR/CCPA once real users arrive. The tiering above makes compliance cheap:
honoring a deletion request means removing one Tier 2 row, because Tier 1
data self-destructs and Tier 3 data never left the phone.
