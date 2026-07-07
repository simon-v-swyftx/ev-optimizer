/**
 * Every hardware- and site-specific tunable in one place.
 *
 * Three configuration layers, least to most dynamic:
 *  1. This file — physical facts and control-loop tuning, fixed at deploy.
 *  2. D1 `config` table — per-install runtime settings changed without a
 *     redeploy: home_lat/home_lon, shadow_mode, safety_factor,
 *     stranded_min_pct, solar_track (see migrations/0001_init.sql).
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
export const TICK_END_MINS = 14 * 60 + 15; // 14:15, a few ticks past window end so the stop lands

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
export const RESERVE_REFILL_PCT = 5; // SOLAR_TRACK -> DUMPING once SoC > reserve + this
export const START_CONFIRM_TICKS = 2; // invariant 4: ticks to see "Charging" after a start
