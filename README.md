# SpotSwap — neighborhood street-parking handoffs

SpotSwap takes the guesswork out of public street parking. Join your
neighborhood's list, register your car's make/model, and let nearby drivers
know when your spot is about to open up — either by pre-selecting a leaving
time or by flipping on **"warming up"** status during the grace window
(default 15 minutes) before you pull out. Drivers circling for a spot see a
live, soonest-first list of spots opening near them, with the car to look
for.

Built as a **Progressive Web App**: one codebase that runs in any desktop or
mobile browser and can be installed to a phone's home screen like a native
app.

## Do users or their info need to be stored on the app or server?

Short answer: **yes, a minimal amount on the server — matching strangers'
spots requires shared state — but far less than you'd think, and most of it
can be ephemeral.** See [docs/DATA_AND_PRIVACY.md](docs/DATA_AND_PRIVACY.md)
for the full breakdown of what must live server-side, what can stay on the
device, and what should be auto-deleted.

## Features (prototype)

- **Join a neighborhood** with a pseudonym, your car's make/model/color, and
  a neighborhood code (e.g. `maplewood-north`). No email, phone, or real
  name required.
- **Announce a departure** two ways:
  - *Scheduled*: "I'm leaving at 5:40 PM" — pre-selected leaving time.
  - *Warming up*: one tap starts the grace-period countdown (default
    15 minutes, configurable — see below) so people know the spot is
    opening imminently.
- **Live spot feed** for your neighborhood, sorted soonest-first, showing
  the departing car's description and approximate location (block-level
  free-text like "Elm St between 3rd & 4th" — never a GPS pin of a home).
- **Claiming**: an arriving driver can tap *"I'm heading there"* so the
  departing driver knows someone is coming, reducing wasted holds.
- **Auto-expiry**: every announcement has a TTL. Expired spots vanish from
  the feed and from the server.

## Experimenting with the grace period

The 15-minute "warming the car" window is a hypothesis, not a constant. It
is set via the `GRACE_PERIOD_MINUTES` env var, and the server logs an event
for every announcement lifecycle transition (created → claimed → completed /
expired). Those logs are the raw material for tuning the window per
neighborhood based on real traffic: if spots routinely expire unclaimed,
lengthen it; if claimers arrive to find the car long gone, shorten it.

## Running the prototype

Zero runtime dependencies — only Node.js 18+ is required.

```bash
npm start          # serves app + API on http://localhost:3000
```

Open it on your phone by visiting your machine's LAN IP on port 3000, or
deploy anywhere Node runs. Configuration via env vars:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GRACE_PERIOD_MINUTES` | `15` | "Warming up" window length |
| `SCHEDULED_TTL_MINUTES` | `240` | How far ahead a scheduled departure may be posted |

## Repository layout

```
server/server.js   Zero-dependency Node HTTP server: static files + JSON API
server/store.js    In-memory data store with TTL sweeper (swap for a DB later)
public/            Mobile-first PWA frontend (vanilla HTML/CSS/JS)
docs/              Architecture & privacy decisions
```

## Roadmap

- Real neighborhood geofencing (opt-in coarse geolocation) instead of codes
- Push notifications when a spot opens near a saved search
- Reputation lite: completion rate, not identity
- Native wrappers (Capacitor) if PWA install friction proves too high
