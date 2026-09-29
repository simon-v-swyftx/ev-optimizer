/**
 * Every hardware- and site-specific tunable in one place.
 *
 * Three configuration layers, least to most dynamic:
 *  1. This file — physical facts and control-loop tuning, fixed at deploy.
 *  2. D1 `config` table — per-install runtime settings changed without a
 *     redeploy: home_lat/home_lon, shadow_mode, safety_factor,
 *     stranded_min_pct, solar_track, solar_soak (see migrations/0001_init.sql).
 *  3. Wrangler secrets — credentials (see .dev.vars.example).
 *
 * Values here document the reference install (SPEC.md). A fork should only
 * need to edit this file, the D1 config rows, and wrangler.jsonc — never
 * the control logic in src/tick.ts.
 */

// --- Timezone (invariant 5) ---
/** Local-time offset from UTC. Reference install: Australia/Brisbane,
 *  UTC+10 with NO daylight saving. The whole design assumes a FIXED offset;
 *  if your region observes DST, changing this number is not enough. */
export const TZ_OFFSET_MS = 10 * 60 * 60 * 1000;

// --- Free grid window (minutes since local midnight) ---
export const WINDOW_START_MINS = 11 * 60; // 11:00
export const WINDOW_END_MINS = 14 * 60; // 14:00
/** Half-hour slot of window start — the reserve forecast horizon end. */
export const WINDOW_START_SLOT = WINDOW_START_MINS / 30;

// --- Tick operating window (the 5-min cron is gated to this range) ---
export const TICK_START_MINS = 5 * 60 + 30; // 05:30
export const TICK_END_MINS = 17 * 60 + 45; // 17:45, a few ticks past SOAK_END_MINS so the stop lands

// --- Home battery ---
export const BATTERY_KWH = 42; // usable capacity

// --- Car / charger ---
export const W_PER_AMP = 690; // three-phase 230 V: 1 A step ≈ 690 W
export const MIN_AMPS = 5; // the car refuses lower
export const MAX_AMPS = 16;
export const AMP_STEP = 2; // DUMPING derate/recover step per tick

// --- Geofence (invariant 7) ---
export const HOME_RADIUS_M = 150;

// --- Reserve forecast (src/reserve.ts) ---
export const BOOTSTRAP_SLOT_KWH = 0.5; // flat 1.0 kW where a slot has no history
export const LOAD_LOOKBACK_DAYS = 14; // history window for the forecast
export const DEFAULT_SAFETY_FACTOR = 1.3; // fallback for config safety_factor
export const DEFAULT_STRANDED_MIN_PCT = 30; // fallback for config stranded_min_pct

// --- Control-loop tuning (src/tick.ts; _W values are watts at the grid meter) ---
export const EXPORT_MARGIN_W = 250; // bias tracking error toward export, never import
export const STOP_IMPORT_W = 250; // clamped at MIN_AMPS and still importing -> stop
export const DERATE_IMPORT_W = 500; // DUMPING: battery limiting -> step down
export const RECOVER_IMPORT_W = 100; // DUMPING: headroom back -> step up
export const FLOOR_IMPORT_W = 8000; // floor hit before a SoC read caught it
export const RESUME_SURPLUS_W = 4500; // pv - house load needed to resume
export const RESUME_STREAK_TICKS = 3; // 15 min of sustained sun before a restart
export const MAX_SOLAR_RESUMES = 4; // contactor-wear cap per day
export const RESERVE_BLEED_W = 250; // at/below reserve: load beyond pv+this = battery/grid feeding the car
export const SUSTAINED_IMPORT_W = 2000; // SOLAR_TRACK failsafe (amp commands failing)
export const SUSTAINED_IMPORT_TICKS = 3;
export const START_CONFIRM_TICKS = 2; // invariant 4: ticks to see "Charging" after a start

// --- Grid-offline guard (src/tick.ts) ---
/** FoxESS runningState meaning off-grid (community docs; 163 = on-grid).
 *  Also reported when the datalogger drops offline — stopping then is still
 *  right: the readings are stale and we're flying blind. */
export const OFF_GRID_RUNNING_STATE = 164;
/** Fallback detector: in the free window ForceCharge feeds the car from the
 *  grid, so a battery discharging this hard means the grid isn't there. */
export const WINDOW_DRAIN_W = 2000;
/** Skip the first ticks of the window: cloud readings can lag the 11:00
 *  switch into ForceCharge by a few minutes. */
export const WINDOW_DRAIN_GRACE_MINS = 10;

// --- Morning solar bank (SOLAR_TRACK, src/tick.ts) ---
/** Resume at MIN_AMPS once the energy banked above reserve plus the current
 *  PV surplus can carry the car's minimum for this long. */
export const BANK_RUN_MINS = 20;
/** Glide: spend the bank above the reserve over (minutes to 11:00 + this),
 *  so the final tick before the window can't overshoot into the floor. */
export const GLIDE_BUFFER_MINS = 5;

// --- Afternoon solar soak (SOLAR_SOAK, src/tick.ts) ---
// After 14:00 the battery is full and Self-Use curtails the PV it can't
// place. The car soaks it up; the full battery is only a short-term buffer.
export const SOAK_END_MINS = 17 * 60 + 30; // hard stop, well before the 18:00 export
export const SOAK_LAST_START_MINS = 16 * 60 + 30; // no fresh starts after this
export const SOAK_START_SOC = 97; // battery "full" (PV likely curtailed): start / probe up
export const SOAK_MIN_SOC = 90; // hard stop: never lend the car more than ~4 kWh
export const SOAK_DISCHARGE_W = 300; // battery discharge beyond this = car outrunning PV
export const SOAK_LOW_TICKS = 2; // at MIN_AMPS and discharging this long -> stop (rides out a cloud)
export const SOAK_STEP_HOLD_TICKS = 3; // after a step down, wait before probing up again
export const SOAK_RESTART_HOLD_TICKS = 6; // 30 min between a soak stop and a restart
export const SOAK_MAX_STARTS = 3; // contactor-wear cap per afternoon
