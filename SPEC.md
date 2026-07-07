# Design specification

## Problem

Owner has a 42 kWh FoxESS battery + 15 kW hybrid inverter and a Tesla MY LR
(11 kW three-phase AC charging). Grid power is free 11:00–14:00 AEST every
day. The owner usually drives to work and cannot charge the car during the
free window. Goal: each morning, transfer surplus home-battery energy into
the car before departure, while guaranteeing the house has enough battery to
reach 11:00, at which point the battery refills to 100% for free. If the car
is still home during the window it charges directly from free grid power.

## Why dumping is always correct

Energy moved battery→car costs nothing: the battery refills to 100% during
the free window regardless (owner-verified; 15 kW inverter easily refills
42 kWh in 3 h). The ~12–15% round-trip loss (battery DC→AC, car AC→DC) is a
loss of free energy. Therefore: always dump the maximum available above the
house reserve. There is no marginal-cost optimisation to do pre-window.

During the window there is no contention: the car's 11 kW comes from the
grid directly, the battery force-charges in parallel through the inverter.

The owner's evening export (18:00–21:00, see "Owner operating facts") does
not change this: it sells energy from the same free 11:00–14:00 refill, so a
morning dump never competes with export revenue.

## Control strategy

No attempt to predict "is the owner going to work today". The system reacts:
charge whenever (plugged in at HOME ∧ car SoC < car's charge limit ∧ battery
above reserve). Unplugging ends the session naturally. Same logic works
weekends and holidays with zero calendar awareness.

Home gate (promoted from "optional" to hard gate 2026-07-05): NO car command
is ever sent unless the cached drive_state lat/lon is within 150 m
(haversine) of home_lat/home_lon (config). Without this, DUMPING would start
a PAID session at a work AC charger — invariant 6 only protects sessions
already running (a supercharger auto-starts, so it's covered by accident),
not an idle away plug. Location missing or malformed → treat as NOT home,
do nothing, log; alert once if that persists 3+ ticks while the car reports
plugged in. "Plugged in" everywhere in this spec means plugged in at home.

The house reserve is enforced in HARDWARE: `minSocOnGrid` on the FoxESS
Self-Use scheduler group (statically set by the owner — see PLAN). A dead
controller cannot drain the house. The software detects "battery hit the
floor" by battery SoC ≤ reserve or grid import jumping to ~11 kW, then
throttles the car to the live PV surplus (SOLAR_TRACK), stopping it only
when the surplus cannot sustain the car's 3.45 kW three-phase minimum.
Missed ticks cost a few minutes of paid grid power — bounded downside.

Manual override (owner-confirmed design, 2026-07-04): the system NEVER stops
a charging session it did not start. If a tick sees the car Charging without
the system having sent start_charging — e.g. the owner pressed start in the
Tesla app after a floor-stop to deliberately grid-charge before a long drive
(home grid ≈ half supercharger price) — the controller backs off for that
session and sends ONE ntfy note ("manual grid charge detected, not
interfering"). The Tesla app start button is the escape hatch; no pause
endpoint. Raising the car's charge limit is the "big drive tomorrow" knob.
Session ownership is tracked in `sessions` (step 4 adds started_by).

## State machine (ticks every 5 min, 05:30–14:15 Brisbane)

States: IDLE ⇄ DUMPING ⇄ SOLAR_TRACK → FREE_WINDOW → DONE. PLAN is the
first-tick-of-day event (creates the day's stored state), not a state.

PLAN (first tick of day, ~05:30)
  reserve_kwh = forecast_house_load(now → 11:00) × safety_factor(1.3)
  reserve_pct = clamp(ceil(reserve_kwh / 42 × 100) + 10 /*BMS floor*/, 10, 100)
  Floor strategy (decided 2026-07-04, confirm with ~2 weeks of data): the
  house load is flat (~0.4 kW), so reserve_pct is expected to be near-constant
  (~17–20%). Plan of record: the owner sets minSocOnGrid ONCE, manually, in
  the FoxESS app at step-5 go-live; the controller stays READ-ONLY on the
  inverter — PLAN computes reserve_pct for the decision log, uses it for the
  software-side dump cutoff, and VERIFIES the configured hardware floor
  (alert on drift). Revert to daily writes only if the computed reserve
  varies by more than a few points day-to-day.
  Fallback: if FoxESS unreachable at PLAN, use the last known reserve; alert.

  forecast_house_load: rolling mean of same-half-hour load over last 5
  weekdays (or all days — configurable) from stored telemetry samples.
  Bootstrap with flat 1.0 kW until 7 days of history exist.

DUMPING (car plugged in, car_soc < car_limit, battery_soc > reserve_pct)
  Send start_charging, set_charging_amps to 16 (max).
  Each tick verify charging_state == "Charging"; if command sent but not
  charging after 2 ticks → alert.
  If grid import > 500 W while dumping (battery derated/limiting): step amps
  down by 2 A per tick until import ~0. Step back up likewise when headroom
  returns.
  Exit → SOLAR_TRACK when battery_soc ≤ reserve_pct (predictive, the normal
  path) or grid import > 8 kW (floor hit before a SoC read caught it:
  inverter stopped discharging, car now on grid). SOLAR_TRACK's first tick
  throttles or stops the car — no separate stop here.
  Exit → FREE_WINDOW at 11:00. Exit → IDLE if unplugged.

SOLAR_TRACK (battery at reserve; car follows PV surplus — added 2026-07-05)
  Replaces FLOOR_HOLD. Rationale: on stay-home mornings the dump reaches the
  reserve well before 11:00. Stopping outright wastes the morning PV — the
  battery it would otherwise charge refills for free at 11:00 anyway — and
  without this state a car left charging at the floor pulls the shortfall
  from the PAID grid until the owner notices. Load-follow the car instead:
  grid import stays ~0, house battery holds at reserve.
  Entered from DUMPING at the floor, or directly from PLAN if the battery
  is already ≤ reserve at 05:30. System-started sessions only — invariant 6
  applies to throttling exactly as to stopping.

  Constants (code, not config): 690 W per amp (three-phase 230 V),
  min 5 A ≈ 3.45 kW (the car refuses lower), max 16 A, export margin 250 W.

  While charging:
    Stop IMMEDIATELY (reserve_hit) when battery_soc ≤ reserve AND
    load_W − pv_W > 250: the meter reads ~0 while the battery covers the
    car in Self-Use, so the amp loop below is blind to battery drain above
    the hardware floor. Without this rule the 1 A/tick ramp-down bled the
    battery from reserve (16%) to the 10% floor in ~10 min and the car
    then ran on PAID grid until below_solar_min caught it (2026-07-08,
    ~1 kWh paid import). At/below reserve a charge may only run on PV
    that covers the whole load; otherwise:
    amps += floor((feedin_W − import_W − 250) / 690), clamped to [5, 16].
    Closed loop on the METER, not pv−load arithmetic: mains-voltage error
    (~3%) and car-side taper make an open-loop estimate drift into
    sustained import; the meter is ground truth. floor() plus the 250 W
    margin bias rounding error toward export, never import. Converges in
    1–2 ticks after a floor-hit or a cloud edge (e.g. entry from DUMPING
    at 16 A with 6 kW PV: import ≈ 5.4 kW → step −9 → 7 A ≈ 4.8 kW ✓).
    Stop when clamped at 5 A AND import > 250 W (surplus can't sustain the
    car's minimum) → stop_charging. Worst case one tick ≈ 25 Wh of import.
  While stopped:
    Resume at 5 A only when the last 3 ticks (15 min) ALL showed
    pvPower − loadsPower ≥ 4.5 kW, capped at 4 solar resumes per day —
    past the cap stay stopped until FREE_WINDOW, log it. The 3-in-a-row
    rule gives dwell time and sustained-sun in one condition: flickering
    cloud never passes it, so worst-case cycling is ~3/hr and the daily
    cap bounds the pathological day. The meter can't see surplus here —
    at the floor Self-Use routes spare PV into the battery, so feedin
    reads 0 — hence PV arithmetic for resume only (loadsPower is
    house-only while the car is off).
  Practical note for THIS house (owner-confirmed 2026-07-08): the array is
  6.6 kW split east/west and rarely nears rated output, so pre-11:00 PV can
  almost never cover house + the car's 3.45 kW minimum. Expect reserve_hit
  to be the normal exit for a running charge at the reserve, the 4.5 kW
  resume threshold to essentially never fire, and SOLAR_TRACK to behave as
  floor-hold: car stopped, battery holding at reserve, waiting for 11:00.
  The tracking/resume logic stays — it is the correct behaviour on the
  days the sun does deliver — but do not expect it to run often, and do
  not "fix" quiet mornings by lowering the resume threshold below what
  sustains the car's minimum draw.
  Wear asymmetry (owner-requested 2026-07-05): stops stay IMMEDIATE — at
  the floor a deficit is paid grid import, and an extra stop costs less
  than the import it prevents. Only restarts are throttled, because
  cycling, not stopping, wears the contactor. Amp changes are contactor-
  free (pilot-signal PWM) and need no throttle beyond no-op dedupe: never
  send set_charging_amps when target == current amps.
  Throttle counters (consecutive-surplus ticks, resumes today) live in
  stored state like everything else the pure tick reads.
  Battery absorption while charging masks surplus the same way and the
  loop under-feeds the car; the battery creeps up instead. Recovered by the
  FLOOR_HOLD rule carried over: SoC > reserve + 5 → re-enter DUMPING.
  Exit → FREE_WINDOW at 11:00. Exit → IDLE if unplugged.
  Fallback: if feedinPower/pvPower are absent from the real-time response
  (the device's missing variables are silently omitted), degrade to the old
  FLOOR_HOLD behaviour — stop at floor, wait — and alert once. Confirm both
  variables exist for this inverter during the step-5 shadow week.
  Config: solar_track flag, default on; off = FLOOR_HOLD behaviour.

FREE_WINDOW (11:00–14:00)
  If car present: ensure charging at 16 A (free grid). FoxESS ForceCharge
  group (static config) refills battery in parallel.
  Adoption rule (2026-07-05): unclaimed charging observed in-window at home
  (typically the KEPT native 11:00 Tesla schedule firing) is adopted as a
  system session — same goal, and adoption restores the 14:00 stop. Sticky
  pre-window owner sessions are untouched.
  At 14:00: stop_charging unless car_soc < stranded_min (config, default 30%)
  → in that case alert and leave charging (paid) — never strand the owner.

DONE (post 14:00) → optional EVENING_DUMP if enabled in config: same as
DUMPING but reserve horizon = house load until 11:00 TOMORROW. Off by
default (trades overnight house autonomy for car charge).

## FoxESS integration

- Open API, key from foxesscloud.com (User Profile → API Management).
- Auth VERIFIED 2026-07-04 against the official doc (v1.1.18) and the
  TonyM1958 reference, and proven live: headers token / timestamp (ms, as
  string) / signature / lang=en, plus Content-Type: application/json and a
  browser-like User-Agent (the WAF blocks default library UAs).
  signature = lowercase-hex MD5 of path + "\r\n" + key + "\r\n" + timestamp
  where the separator is the LITERAL four characters backslash-r-backslash-n,
  NOT a real CRLF (both the doc's own example and the reference hash Python
  raw strings — do not "fix" this). Path only: no host, query string, or
  body. Envelope { errno, msg?, result }; errno 0 = success.
  Implementation: src/clients/foxess.ts.
- Verified endpoints: real-time = POST /op/v1/device/real/query with
  {sns: [sn], variables} (v0 is deprecated; SoC in %, loadsPower /
  gridConsumptionPower in kW; variables the device lacks are silently
  omitted from the response). Battery variables carry a bank-index suffix on
  our inverter — SoC_1 not SoC (live-verified 2026-07-06; cost the first
  shadow morning to "real-time missing SoC" every tick) — the client requests
  and accepts both. Raw dump for diagnosis: GET /debug/foxess (admin bearer).
  SOLAR_TRACK adds pvPower + feedinPower to the SAME call — no extra
  API-budget cost; presence confirmed live 2026-07-06. History = POST /op/v0/device/history/query,
  begin/end in ms, span ≤ 24 h; sample times are inverter-LOCAL strings
  ("2026-07-03 00:02:33 AEST+1000") at ~5-min cadence, may over-run the
  requested day, values may be null. The client fails loud if timestamps are
  not +1000 — a wrong cloud-side device timezone would otherwise silently
  phase-shift every slot.
- Error codes: 40256 bad headers/signature, 40257 bad body, 40400 rate
  limit, 44096 "cannot update settings when schedule is active" — any future
  setting write must go through the scheduler endpoints while a schedule is
  enabled. Rate limit 1,440 calls/day (queries ≤ 1/s, writes ≤ 1 per 2 s).
  Budget: 1 read per tick (~105/day) + nightly history pull. Ample headroom.
- ACTUAL scheduler config (owner-managed in the FoxESS app; the controller
  does not write it — verify-and-alert only):
    11:00–14:00 ForceCharge (free-window refill, as designed)
    18:00–21:00 ForceDischarge to grid, NO fdSoC floor — owner duration-tunes
                it to export ~15 kWh (feed-in tariff pays well only on the
                first 15 kWh/day); battery ends ~50% by 21:00
    otherwise   Self-Use, minSocOnGrid currently 10% (owner raises it to the
                static reserve, ~18–20%, at step-5 go-live)
  The owner may manually skip the evening export before a long drive; that
  stays a manual FoxESS-app action (no calendar awareness).
- Nightly job (LIVE since 2026-07-04, cron 0 15 * * * UTC = 01:00 Brisbane):
  pull yesterday's loadsPower into half-hour `load_samples`.
  NOTE: loadsPower INCLUDES the EV charger (verified: the owner's manual
  midnight charge showed as ~10 kW in slot 0 on 2026-07-03). Charge
  exclusion happens AT INGEST (2026-07-05, src/charges.ts): both the
  nightly pull and the backfill fetch Tessie charge history and DROP any
  half-hour slot overlapping a home charge session before insert. Tessie
  history sees ALL charges — including the owner's midnight habit, which
  happens outside the tick window and is therefore invisible to the
  sessions table; the earlier plan to filter via recorded sessions is
  superseded. Unknown charge location counts as home (wrongly excluding a
  slot only pushes that slot toward other days' mean or the conservative
  bootstrap; wrongly keeping one bakes ~10 kW of charger into the house
  forecast). Away charges are filtered by the same 150 m haversine as the
  command geofence. Ingest fails loud if the charges call fails — a day
  with unfilterable EV load must not enter the forecast.
- Backfill (added 2026-07-05): POST /backfill?from=YYYY-MM-DD&to=YYYY-MM-DD
  (Authorization: Bearer ADMIN_KEY) seeds load_samples from FoxESS history,
  ≤ 21 days per call (Workers 50-subrequest limit), 1.1 s between FoxESS
  calls (rate limit), one Tessie charges call for the whole range. Same
  charge exclusion as the nightly pull. After seeding, sanity-check morning
  slots with SQL for residual EV-shaped spikes (> ~1 kWh/slot).
- Reference implementation of endpoint quirks: TonyM1958/foxesscloud (PyPI) —
  Python, but documents API behaviour; port patterns, don't depend on it.

## Tessie integration

- Base https://api.tessie.com, bearer token, per-VIN paths.
- Reads: GET /{vin}/state — served from Tessie's cache; does NOT wake the car.
  GET /{vin}/charges?from=&to= (unix seconds) — charge session history, used
  for forecast charge-exclusion at ingest; response shape unverified until
  the first backfill run, client fails loud on surprises (timestamps are
  normalised sec/ms defensively — a wrong unit would silently exclude
  nothing).
  Needed fields: charge_state.battery_level, charging_state,
  charge_port_latch/conn status, charge_amps, drive_state lat/lon (home
  geofence — hard gate on every command, see Control strategy).
- Commands: POST /{vin}/command/start_charging | stop_charging |
  set_charging_amps (query param: amps). Tessie handles virtual-key signing
  and retries.
- Tessie does have saved locations (a separate /{vin}/location endpoint can
  resolve a named "Home"), and the Tesla app has its own Home — neither is
  used: the first costs an extra API call per tick and both depend on
  app-side config that can drift. The geofence is a haversine on the
  drive_state lat/lon already present in the one /state read.
- Poll only during operating window; nothing outside it.
- The owner's native 11:00–14:00 Tesla charge schedule is KEPT permanently
  (decided 2026-07-05, reversing the earlier disable-at-go-live plan): it is
  the dead-controller backstop — if the Worker never ticks again, the car
  still charges free every day at 11:00. The two-schedulers conflict is
  resolved by the ADOPTION RULE instead: charging that appears inside the
  free window, at home, with no existing session claim is adopted as a
  SYSTEM session (native schedule and controller want the same thing there),
  which restores the 14:00 stop. Ownership is sticky: a session the owner
  started before 11:00 stays an owner session through the window and is
  never stopped. The owner's app schedule has an END time too (owner-
  confirmed 2026-07-05: the Tesla app supports charge windows), so the
  dead-controller backstop is bounded at 14:00 — no paid overrun.
- The account has TWO vehicles; the TESSIE_VIN secret selects "VICTORY".
  Token + VIN verified live 2026-07-04: cached /{vin}/state returned
  battery_level, charge_limit_soc, charging_state, charge_port_latch and
  charge_amps without waking the car.

## Owner operating facts (confirmed 2026-07-04)

- Leaves for work 07:00–08:00 → the dump must effectively finish by ~07:00
  (it does: ~11 kWh surplus at 11 kW ≈ 1 h from a 05:30 start).
- House load is flat, ~0.4 kW baseline; 05:30→11:00 ≈ 2.2 kWh, so
  reserve_pct ≈ 17% with the 1.3 safety factor.
- Typical day: ~50% SoC at 21:00 (post-export), ~2.4 kWh overnight load,
  ~44% at 05:30, ~11 kWh dumpable → ~9–10 kWh (~60 km) into the car, free.
- Owner sometimes charges the car manually at odd hours (e.g. midnight, to
  sleep in) — both the manual-override rule and the ingest-time charge
  exclusion exist because of this.
- Feed-in pays well only on the first 15 kWh/day → the 18:00–21:00 export is
  deliberately ~15 kWh, duration-tuned by the owner, no fdSoC floor.
- Solar array: 6.6 kW rated, split across east and west roofs, so combined
  output is rarely near rated (owner-confirmed 2026-07-08). Consequence: PV
  alone can almost never cover house load + the car's 3.45 kW minimum,
  especially before 11:00 (east panels only) — see the SOLAR_TRACK note.
- Home geofence centre: kept out of the repo — seed the D1 config keys
  home_lat/home_lon at go-live (owner-supplied 2026-07-05).

## Data model (D1)

- config(key TEXT PK, value TEXT) — reserve safety factor, stranded_min,
  evening_dump flag, solar_track flag (default on), shadow_mode flag
  (default ON — commands only sent when explicitly 'false'), home_lat/
  home_lon (geofence), operating window
- days(date TEXT PK, reserve_pct INT, planned_at TEXT, state TEXT)
- decisions(id, ts, state_from, state_to, action, inputs_json) — every tick
  that does anything writes a row
- load_samples(date, slot_half_hour INT, load_kwh REAL) — forecast input
- sessions(id, date, started_at, ended_at, kwh_est REAL, end_reason TEXT) —
  step 4 adds started_by (system|owner) so manual sessions are never stopped
  by the controller (forecast hygiene is handled at ingest via Tessie charge
  history, not this table)

## Failure modes → behaviour

- Controller dead: inverter minSocOnGrid floor protects house; car charges
  until its own limit or until floor forces grid draw (owner alerted next
  successful tick). Bounded cost. The kept native Tesla 11:00 schedule
  still delivers the free-window charge with zero working software.
- FoxESS API down at PLAN: reuse yesterday's reserve; alert.
- Tessie down: cannot start/stop car. House protected by floor. Alert.
- Command accepted but car not charging: alert after 2 ticks.
- Car plugged in away from home (work, supercharger, anywhere): geofence
  gate → no commands at all; away sessions are the owner's business.
- Location missing from cached state: treated as away (fail-safe, no
  commands); alert once if persistent.
- pvPower/feedinPower missing from real-time response: SOLAR_TRACK degrades
  to stop-at-floor (old FLOOR_HOLD); alert once.
- set_charging_amps fails mid-SOLAR_TRACK: import persists → next tick steps
  down again; if import > 2 kW for 3 consecutive ticks → stop_charging +
  alert (never sit on sustained paid import).
- Every alert via ntfy.sh POST (topic in secrets).

## Costs

- Cloudflare Workers free tier: 288 cron invocations/day, trivial CPU. $0.
- Tessie: already subscribed. FoxESS API: free. ntfy.sh: free.

## Build order

1. ✅ DONE 2026-07-04 — FoxESS client (auth verified against the official
   doc and live-tested), reserve calc + tests, nightly history pull DEPLOYED
   (the only cron registered; the */5 tick cron returns at step 5). Now
   soaking: validate forecast against reality (SQL over load_samples).
2. RESCOPED — no scheduler writes. Pick the static reserve floor from ~2
   weeks of load_samples; owner sets minSocOnGrid manually at go-live. The
   controller gets read-only daily schedule verification + drift alert.
3. ✅ DONE 2026-07-05 — typed Tessie state read (getCarState), manual
   start/stop via POST /car/start | /car/stop (Bearer ADMIN_KEY; an API
   start is an OWNER action — the next tick backs off per invariant 6),
   GET /status.
4. ✅ DONE 2026-07-05 — decide() in src/tick.ts, pure (inputs, stored) →
   (actions, next state); 50+ vitest cases. Session ownership, SOLAR_TRACK
   amp controller (clamp edges, stop/resume hysteresis, restart throttle +
   daily cap, no-op amp dedupe, missing-variable fallback, sustained-import
   failsafe), home geofence (unknown location = away), external-stop
   stand-down (owner stopping a SYSTEM session via the app blocks
   auto-starts until the free window, one alert; owner stopping their OWN
   session hands control back). Forecast charge-exclusion ships at ingest
   (src/charges.ts). Persisted state = days.state_json (migration 0002).
   PLAN forecast uses all days of the last 14 (spec offered 5-weekday or
   all-days; all-days chosen — owner's load is flat). Sessions-table
   bookkeeping dropped: ownership lives in state_json, audit in decisions;
   the table stays for a future dashboard.
5. ✅ DONE 2026-07-05 — */5 cron live, gated 05:30–14:15 in code. SHADOW
   MODE ON (config shadow_mode, default true — commands sent only when
   explicitly 'false'): decisions logged with "shadow:" prefix, no car
   commands, no ntfy from actions. Read-failure alerts throttled to one
   per 3 h (every failure still logged to decisions). PLAN verifies
   minSocOnGrid read-only via /op/v0/device/battery/soc/get (endpoint
   shape unverified — fails soft with an alert). GO-LIVE checklist after
   the shadow week: review decisions log → owner raises minSocOnGrid to
   the static reserve → set config shadow_mode='false'. The Tesla native
   11:00–14:00 schedule stays ON as the dead-controller backstop (adoption
   rule, see Tessie integration).
6. Dashboard last (TanStack Start reading D1 via the Worker, or just
   wrangler d1 execute queries until it hurts).
