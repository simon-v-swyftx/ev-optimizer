# EV + Home Battery Charge Optimiser

Cloudflare Worker that optimises charging of a Tesla (via Tessie) from a
FoxESS home battery, exploiting a daily free grid-power window (11:00–14:00
on the reference install; configurable).

Read SPEC.md before making design changes. It contains the full control logic,
decision maths, API integration details, and failure-mode analysis. This file
is the operational summary.

## The one-sentence model

The EV charger is just a big house load: when the FoxESS is in Self-Use mode,
starting the car at 11 kW makes the inverter discharge the home battery to
cover it. So the controller manipulates the CAR (start/stop/amps via Tessie)
and relies on one static, owner-set FoxESS floor (`minSocOnGrid`, read-only,
once at PLAN) as the hardware backstop. The house's forecast energy until
11:00 is reserved ON TOP of that floor (10% BMS minimum unless the owner
raised it), so the house never runs on grid because the battery hit its
minimum. That reserve decays through the morning as the house uses its
need, and anything above it glides into the car by 11:00.

## Site facts (configuration, do not guess)

Per-install facts are Worker `vars` in wrangler.jsonc, parsed and validated
by src/site.ts and passed into the pure state machine as `DecideInputs.site`.
Never hard-code them in logic: UTC_OFFSET, FREE_WINDOW_START/END, DAY_START,
SOLAR_SOAK_END, BATTERY_KWH, CHARGER_VOLTS/PHASES/MIN_AMPS/MAX_AMPS,
HOME_RADIUS_M. All are required — a missing var stops the controller with
an alert rather than defaulting to another site's values.

The reference install (the numbers in SPEC.md and the test suite,
src/testing.ts):

- Home battery: FoxESS, 42 kWh usable, 10% BMS floor
- Inverter: 15 kW hybrid (car 11 kW + house ~1 kW fits within it)
- Car: Tesla Model Y LR, three-phase 11 kW AC charging (16 A/phase; 1 A step ≈ 690 W)
- Solar: 6.6 kW rated, split east/west roofs — rarely near rated output; PV
  alone can almost never cover house load + the car's 3.45 kW minimum
- Free grid window: 11:00–14:00 local, UTC+10 with NO daylight saving
- Battery always reaches 100% by end of the free window (owner-verified)

## Non-negotiable safety invariants

1. The house reserve sits on top of FoxESS `minSocOnGrid` (never below the
   10% BMS minimum); the controller never writes inverter settings. If the
   grid is offline, stop the system's charge immediately and start nothing
   until it's back — the house battery is for the house.
2. Every failure mode must degrade to "slightly suboptimal", never "flat house
   battery" or "car misses charge with no alert". The inverter floor and the
   car's own charge limit are the backstops — the software must never remove
   them.
3. The car's built-in charge limit is the single source of truth for target
   SoC. Do not track a separate target.
4. After sending `start_charging`, verify on the next tick that the car
   reports Charging. Commands are not confirmations.
5. All time handling in local time at the fixed UTC_OFFSET, no DST — do not
   add DST logic or timezone libraries.
6. Never stop a charging session the system did not start. The owner's
   Tesla-app start button is the deliberate manual override (e.g. paid grid
   charge before a long drive); back off and send one ntfy note.
7. No car command unless the car is at home (cached location within
   HOME_RADIUS_M).
   Unknown or missing location counts as NOT home.

## Architecture

- Runtime: Cloudflare Worker. One cron, `*/5 * * * *`; gated in code to
  DAY_START..SOLAR_SOAK_END+15 min local for the tick, and 01:00 local for
  the nightly load pull. SHADOW MODE until config shadow_mode='false' — see
  SPEC step 5
- State: D1 (SQLite) — see migrations/0001_init.sql
- Car: Tessie API (https://api.tessie.com, bearer token) — handles command
  signing and retries; state reads are served from Tessie's cache and do not
  wake the car
- Inverter: FoxESS Open API (https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html)
  — API-key auth with an MD5 request signature; rate limit 1,440 calls/day
- Alerts: ntfy.sh topic (push to phone)

## Commands

The repo is pnpm-managed (since 2026-07-04) — use `pnpm add`, never
`npm install`.

- `pnpm run dev` — wrangler dev with local cron testing
  (`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`; it acts on
  the real local time)
- `pnpm run deploy` — wrangler deploy (manual; merging to main deploys
  automatically via .github/workflows/ci-deploy.yml after tests pass)
- `pnpm test` — vitest (state machine and reserve calc are pure functions;
  test them exhaustively, they run unattended at 5:30am)
- `pnpm run migrate` — apply D1 migrations

## Secrets (wrangler secret put …)

- `TESSIE_TOKEN`, `TESSIE_VIN`
- `FOXESS_API_KEY`, `FOXESS_DEVICE_SN`
- `NTFY_TOPIC` (optional var `NTFY_URL` for a self-hosted ntfy server)
- `ADMIN_KEY` — bearer for admin HTTP routes (/backfill, step-3 endpoints);
  local copy in .dev.vars (gitignored)

## Conventions

- TypeScript strict. No classes where a function will do.
- The state machine (src/tick.ts) must stay a pure function of
  (inputs, stored state) → (actions, new state) so it is trivially testable.
  All I/O lives in src/clients/ and src/index.ts.
- Log every decision to the `decisions` table with the inputs it acted on.
  When the system does something odd at 6am we read the log, not guess.
- Verify FoxESS endpoint shapes against the official Open API document before
  relying on them — community docs drift. The auth scheme IS verified
  (2026-07-04) and live-tested: the MD5 signature hashes the LITERAL four
  characters \r\n between path/key/timestamp — do not "fix" it to CRLF.
  Details in src/clients/foxess.ts and SPEC.md "FoxESS integration".
