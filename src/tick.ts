import { reservePct } from "./reserve";
import {
  AMP_STEP,
  BANK_RUN_MINS,
  BATTERY_KWH,
  DERATE_IMPORT_W,
  EXPORT_MARGIN_W,
  FLOOR_IMPORT_W,
  MAX_AMPS,
  MAX_SOLAR_RESUMES,
  MIN_AMPS,
  RECOVER_IMPORT_W,
  RESERVE_BLEED_W,
  RESERVE_REFILL_PCT,
  RESUME_STREAK_TICKS,
  RESUME_SURPLUS_W,
  SOAK_DISCHARGE_W,
  SOAK_END_MINS,
  SOAK_LAST_START_MINS,
  SOAK_LOW_TICKS,
  SOAK_MAX_STARTS,
  SOAK_MIN_SOC,
  SOAK_RESTART_HOLD_TICKS,
  SOAK_START_SOC,
  SOAK_STEP_HOLD_TICKS,
  START_CONFIRM_TICKS,
  STOP_IMPORT_W,
  SUSTAINED_IMPORT_TICKS,
  SUSTAINED_IMPORT_W,
  W_PER_AMP,
  WINDOW_END_MINS,
  WINDOW_START_MINS,
} from "./constants";

/**
 * Pure decision function of (inputs, stored state) -> (actions, new state).
 * No I/O, no clock, no randomness — see SPEC.md "State machine".
 * Orchestration (reads, command execution, persistence) lives in src/index.ts.
 */

export type StateName = "IDLE" | "DUMPING" | "SOLAR_TRACK" | "FREE_WINDOW" | "SOLAR_SOAK" | "DONE";

export interface StoredState {
  date: string; // YYYY-MM-DD Brisbane
  state: StateName;
  reservePct: number;
  /** Who started the running charge session (invariant 6). */
  sessionOwner: "system" | "owner" | null;
  /** Ticks since start_charging was sent; -1 = no start pending (invariant 4). */
  startPending: number;
  /** Set after a failed start or an external stop: no more auto-starts until
   *  the free window (which resets it). */
  startBlocked: boolean;
  /** Last amps target we commanded; null when not charging. */
  lastAmps: number | null;
  surplusStreak: number; // consecutive ticks with pv-load >= resume threshold
  solarResumes: number; // SOLAR_TRACK restarts today (wear cap)
  manualNoted: boolean; // one ntfy per owner session
  solarVarsAlerted: boolean; // one ntfy per day for missing pv/feedin
  highImportTicks: number; // SOLAR_TRACK sustained-import failsafe
  soakStarts: number; // SOLAR_SOAK starts today (wear cap)
  soakHold: number; // SOLAR_SOAK ticks to wait before probing up / restarting
  soakLowTicks: number; // SOLAR_SOAK consecutive ticks at MIN_AMPS with battery discharging
}

/** Fields added after go-live; a state row persisted by an older build lacks
 *  them, so they are defaulted when the row is loaded mid-day. */
const LATE_FIELDS = { soakStarts: 0, soakHold: 0, soakLowTicks: 0 };

export interface DecideInputs {
  date: string;
  nowMins: number; // minutes since midnight Brisbane
  car: {
    pluggedIn: boolean;
    chargingState: string; // "Charging" | "Stopped" | "Complete" | "Disconnected" | ...
    socPct: number;
    limitPct: number; // car's own charge limit = the target (invariant 3)
    chargeAmps: number;
    atHome: boolean; // geofence, unknown location = false (invariant 7)
  };
  house: {
    socPct: number;
    loadW: number;
    gridImportW: number;
    pvW: number | null; // null = inverter doesn't report it
    feedinW: number | null;
  };
  cfg: {
    safetyFactor: number;
    strandedMinPct: number;
    solarTrack: boolean;
    solarSoak: boolean; // afternoon PV -> car after the window (default on)
    shadowMode: boolean;
  };
  /** Half-hour load history for PLAN; only read on the first tick of a day. */
  samples: { slot: number; loadKwh: number }[];
  /** FoxESS minSocOnGrid, read (read-only) at PLAN. 10% is the manufacturer
   *  BMS minimum; the owner may raise it in the FoxESS app, and an owner-set
   *  floor above the forecast reserve becomes the day's effective reserve —
   *  so the software stops dumping AT the hardware floor instead of planning
   *  through it (the inverter would stop discharging and the shortfall would
   *  be paid grid import). null = read failed or not the first tick of a day;
   *  falls back to the forecast reserve (hardware still enforces the floor). */
  floorPct: number | null;
  stored: StoredState | null;
}

export type Action =
  | { kind: "start_charging"; amps: number }
  | { kind: "stop_charging"; reason: string }
  | { kind: "set_amps"; amps: number }
  | { kind: "notify"; message: string };

export function decide(i: DecideInputs): { actions: Action[]; next: StoredState } {
  const a: Action[] = [];

  // PLAN: first tick of a new day.
  const s: StoredState =
    i.stored && i.stored.date === i.date
      ? { ...LATE_FIELDS, ...i.stored }
      : {
          date: i.date,
          state: "IDLE",
          // Owner-raised hardware floor wins over the forecast (see
          // DecideInputs.floorPct); the drift alert covers the other drift.
          reservePct: Math.max(
            reservePct({
              nowSlot: Math.floor(i.nowMins / 30),
              samples: i.samples,
              safetyFactor: i.cfg.safetyFactor,
              batteryKwh: BATTERY_KWH,
            }),
            i.floorPct ?? 0,
          ),
          sessionOwner: null,
          startPending: -1,
          startBlocked: false,
          lastAmps: null,
          surplusStreak: 0,
          solarResumes: 0,
          manualNoted: false,
          solarVarsAlerted: false,
          highImportTicks: 0,
          ...LATE_FIELDS,
        };

  const charging = i.car.chargingState === "Charging";
  const full = i.car.chargingState === "Complete" || i.car.socPct >= i.car.limitPct;

  const stop = (reason: string) => {
    a.push({ kind: "stop_charging", reason });
    s.sessionOwner = null;
    s.lastAmps = null;
  };
  const start = (amps: number) => {
    a.push({ kind: "start_charging", amps });
    s.sessionOwner = "system";
    s.startPending = 0;
    s.lastAmps = amps;
  };
  const canStart = () => !s.startBlocked && s.startPending < 0;
  // Grid import while the car runs above reserve means the battery would not
  // discharge at this SoC (hardware floor above the planned reserve — e.g. the
  // PLAN floor read failed — or a derated battery). Adopt that SoC as today's
  // effective reserve so no path (bank restart, reserve + 5 re-entry) starts
  // the car on paid grid again. Only ever raises: conservative, like the
  // owner-raised-floor rule at PLAN.
  const learnFloor = () => {
    s.reservePct = Math.min(100, Math.max(s.reservePct, i.house.socPct));
  };

  // --- Session bookkeeping (invariants 4 + 6) ---
  if (charging && s.sessionOwner === null) {
    if (i.nowMins >= WINDOW_START_MINS && i.nowMins < WINDOW_END_MINS && i.car.atHome) {
      // The car's native 11:00 Tesla schedule (kept as the dead-controller
      // backstop) or any fresh in-window start wants exactly what we want:
      // free charge until 14:00. Adopt it so the 14:00 stop applies.
      // Ownership is sticky, so a session the owner started BEFORE the
      // window stays theirs all the way through.
      s.sessionOwner = "system";
      if (s.lastAmps === null) s.lastAmps = i.car.chargeAmps;
    } else {
      s.sessionOwner = "owner"; // the deliberate manual override
      if (!s.manualNoted && i.car.atHome) {
        a.push({ kind: "notify", message: "manual charge detected — not interfering" });
        s.manualNoted = true;
      }
    }
  }
  if (s.startPending >= 0) {
    if (charging) {
      s.startPending = -1; // confirmed
    } else if (++s.startPending >= START_CONFIRM_TICKS) {
      s.startPending = -1;
      s.sessionOwner = null;
      s.lastAmps = null;
      a.push({
        kind: "notify",
        message: `start_charging sent but car not Charging after ${START_CONFIRM_TICKS} ticks`,
      });
      if (!i.cfg.shadowMode) s.startBlocked = true; // shadow never really starts
    }
  } else if (!charging && s.sessionOwner === "system") {
    // Our session ended without our stop command. Unplug and Complete are
    // natural ends; anything else (owner pressed stop in the Tesla app, car
    // fault) means stand down — restarting would fight the owner.
    s.sessionOwner = null;
    s.lastAmps = null;
    if (!full && i.car.pluggedIn && !i.cfg.shadowMode) {
      a.push({ kind: "notify", message: "charging stopped externally — standing down until the free window" });
      s.startBlocked = true;
    }
  }
  if (!charging && s.sessionOwner === "owner") {
    s.sessionOwner = null;
    s.manualNoted = false; // next manual session gets its own note
  }

  // No command ever leaves while away/unknown (invariant 7) or during an
  // owner session (invariant 6).
  const canAct = i.car.atHome && s.sessionOwner !== "owner";

  if (!i.car.pluggedIn) {
    s.state = "IDLE"; // unplugging ends everything naturally
    s.lastAmps = null;
    s.surplusStreak = 0;
    return { actions: a, next: s };
  }

  const phase = i.nowMins >= WINDOW_END_MINS ? "after" : i.nowMins >= WINDOW_START_MINS ? "window" : "morning";

  if (phase === "after") {
    const soakOn = i.cfg.solarSoak && i.nowMins < SOAK_END_MINS;
    if (s.state !== "DONE" && s.state !== "SOLAR_SOAK") {
      // First after-window tick (or a re-plug after an unplug reset to IDLE).
      if (charging && s.sessionOwner === "system" && canAct) {
        if (i.car.socPct < i.cfg.strandedMinPct) {
          // never strand the owner: leave the (now paid) charge running
          a.push({
            kind: "notify",
            message: `free window ended with car at ${i.car.socPct}% (< stranded min ${i.cfg.strandedMinPct}%) — leaving paid charge running`,
          });
          s.state = "DONE";
          return { actions: a, next: s };
        }
        if (soakOn && !full && i.house.pvW !== null && i.house.feedinW !== null) {
          // Throttle to the PV the meter can see instead of stopping: no
          // contactor cycle, and the soak loop probes up from here.
          const houseW = i.house.loadW - i.car.chargeAmps * W_PER_AMP;
          const target = clampAmps(Math.floor((i.house.pvW - houseW - EXPORT_MARGIN_W) / W_PER_AMP));
          if (target !== s.lastAmps) a.push({ kind: "set_amps", amps: target });
          s.lastAmps = target;
          s.state = "SOLAR_SOAK";
          return { actions: a, next: s };
        }
        stop("window_end");
      }
      s.state = soakOn ? "SOLAR_SOAK" : "DONE";
    }
    if (s.state === "SOLAR_SOAK") soak(i, s, a, { charging, full, canAct, stop, start, canStart, soakOn });
    return { actions: a, next: s };
  }

  if (phase === "window") {
    if (s.state !== "FREE_WINDOW") s.startBlocked = false; // free power: always worth one fresh attempt
    s.state = "FREE_WINDOW";
    if (!full && canAct) {
      if (!charging) {
        if (canStart()) start(MAX_AMPS);
      } else if (s.sessionOwner === "system") {
        if (s.lastAmps === null) s.lastAmps = i.car.chargeAmps;
        if (s.lastAmps !== MAX_AMPS) {
          a.push({ kind: "set_amps", amps: MAX_AMPS });
          s.lastAmps = MAX_AMPS;
        }
      }
    }
    return { actions: a, next: s };
  }

  // --- morning: IDLE / DUMPING / SOLAR_TRACK ---
  // Transition first, then act as the resulting state in the same tick (so a
  // floor-hit at 16 A throttles immediately instead of a tick later).
  let st: StateName = s.state === "FREE_WINDOW" || s.state === "DONE" ? "IDLE" : s.state;
  if (full || s.sessionOwner === "owner" || !i.car.atHome) {
    st = "IDLE";
  } else if (st === "IDLE") {
    st = i.house.socPct > s.reservePct ? "DUMPING" : "SOLAR_TRACK";
  } else if (st === "DUMPING") {
    if (i.house.gridImportW > FLOOR_IMPORT_W) {
      learnFloor(); // floor hit before a SoC read caught it: reserve_hit stops the car this tick
      st = "SOLAR_TRACK";
    } else if (i.house.socPct <= s.reservePct) {
      st = "SOLAR_TRACK";
    }
  } else if (st === "SOLAR_TRACK") {
    if (i.house.socPct > s.reservePct + RESERVE_REFILL_PCT) st = "DUMPING"; // PV refilled the battery: recover it at full rate
  }
  s.state = st;

  if (st === "DUMPING" && canAct) {
    if (!charging) {
      if (canStart()) start(MAX_AMPS);
    } else if (s.sessionOwner === "system") {
      if (s.lastAmps === null) s.lastAmps = i.car.chargeAmps;
      let target = s.lastAmps;
      if (i.house.gridImportW > DERATE_IMPORT_W) {
        target = Math.max(MIN_AMPS, target - AMP_STEP); // battery derated/limiting
      } else if (i.house.gridImportW < RECOVER_IMPORT_W && target < MAX_AMPS) {
        target = Math.min(MAX_AMPS, target + AMP_STEP);
      }
      if (target !== s.lastAmps) {
        a.push({ kind: "set_amps", amps: target });
        s.lastAmps = target;
      }
    }
  }

  if (st === "SOLAR_TRACK" && canAct) {
    const varsOk = i.house.pvW !== null && i.house.feedinW !== null;
    if (!varsOk) {
      // degrade to floor-hold: stop, wait for the free window (SPEC fallback)
      if (!s.solarVarsAlerted) {
        a.push({ kind: "notify", message: "pvPower/feedinPower missing — solar tracking disabled, floor-hold" });
        s.solarVarsAlerted = true;
      }
      if (charging && s.sessionOwner === "system") stop("solar_vars_missing");
    } else if (charging && s.sessionOwner === "system") {
      if (s.lastAmps === null) s.lastAmps = i.car.chargeAmps;
      if (i.house.socPct <= s.reservePct && i.house.loadW - i.house.pvW! > RESERVE_BLEED_W) {
        // Self-Use keeps the meter at ~0 while the battery covers the car, so
        // the amp loop below is blind to battery drain until the hardware
        // floor. At/below reserve anything PV doesn't cover comes from the
        // battery or paid grid — stop now (2026-07-08: the 1 A/tick ramp
        // bled the battery from reserve to the 10% floor, then imported).
        stop("reserve_hit");
      } else {
        // failsafe: if amp commands are failing and import persists, stop
        if (i.house.gridImportW > SUSTAINED_IMPORT_W) {
          if (++s.highImportTicks >= SUSTAINED_IMPORT_TICKS) {
            stop("sustained_import");
            learnFloor();
            a.push({ kind: "notify", message: "SOLAR_TRACK: sustained grid import — stopped charge" });
            s.highImportTicks = 0;
          }
        } else {
          s.highImportTicks = 0;
        }
        if (s.sessionOwner === "system") {
          // Closed loop on the meter; floor() + margin bias errors toward
          // export. Below the battery's own reserve Self-Use routes spare PV
          // into the battery and the meter reads ~0, so PV beyond house+car
          // (loadW includes the car) also counts: the car follows the sun
          // instead of the battery soaking it up. The larger of the two is
          // never import-side, so this cannot push the car onto paid grid.
          const surplusW = Math.max(i.house.feedinW! - i.house.gridImportW, i.house.pvW! - i.house.loadW);
          const delta = Math.floor((surplusW - EXPORT_MARGIN_W) / W_PER_AMP);
          const target = Math.min(MAX_AMPS, Math.max(MIN_AMPS, s.lastAmps + delta));
          if (target === MIN_AMPS && s.lastAmps === MIN_AMPS && i.house.gridImportW > STOP_IMPORT_W) {
            stop("below_solar_min"); // surplus can't sustain the car's 3.45 kW minimum
            learnFloor();
          } else if (target !== s.lastAmps) {
            a.push({ kind: "set_amps", amps: target });
            s.lastAmps = target;
          }
        }
      }
    } else if (!charging) {
      // resume throttle: 15 min of sustained surplus, capped per day (wear)
      const surplus = i.cfg.solarTrack && i.house.pvW !== null ? i.house.pvW - i.house.loadW : 0;
      s.surplusStreak = surplus >= RESUME_SURPLUS_W ? s.surplusStreak + 1 : 0;
      // Solar bank: PV the battery absorbed above reserve (loadsPower is
      // house-only while the car is off). Resume as soon as that bank plus
      // today's surplus carries the car's minimum for BANK_RUN_MINS, rather
      // than waiting for reserve + RESERVE_REFILL_PCT — less morning PV is
      // left stranded in the battery when the owner drives off, and the run
      // ends at reserve via reserve_hit (battery above reserve covers any
      // shortfall, so no import).
      const bankWh = (i.house.socPct - s.reservePct) * BATTERY_KWH * 10;
      const needWh = (Math.max(0, MIN_AMPS * W_PER_AMP - surplus) * BANK_RUN_MINS) / 60;
      const banked = i.cfg.solarTrack && bankWh > 0 && bankWh >= needWh;
      if (
        (s.surplusStreak >= RESUME_STREAK_TICKS || banked) &&
        s.solarResumes < MAX_SOLAR_RESUMES &&
        canStart()
      ) {
        s.surplusStreak = 0;
        s.solarResumes++;
        start(MIN_AMPS);
      }
    }
  }

  return { actions: a, next: s };
}

const clampAmps = (a: number) => Math.min(MAX_AMPS, Math.max(MIN_AMPS, a));

/**
 * SOLAR_SOAK (after the free window, see SPEC): the battery is full and
 * Self-Use curtails the PV it can't place, so the car soaks it up. The meter
 * can't see curtailed headroom, so the loop runs on the battery instead:
 *   batteryW = feedin - import - (pv - load)   (energy balance, + = discharging)
 * Discharging -> the car outran the sun: step down. Otherwise take visible
 * surplus (export, or PV into the battery), and while the battery is full
 * probe up 1 A per tick — the inverter un-curtails to meet the new load, or
 * the battery shows it next tick. The full battery is only a buffer:
 * SOAK_MIN_SOC is the hard stop, so the evening export and next morning's
 * dump are untouched.
 */
function soak(
  i: DecideInputs,
  s: StoredState,
  a: Action[],
  h: {
    charging: boolean;
    full: boolean;
    canAct: boolean;
    soakOn: boolean;
    stop: (reason: string) => void;
    start: (amps: number) => void;
    canStart: () => boolean;
  },
): void {
  const own = h.charging && s.sessionOwner === "system";
  if (!h.soakOn) {
    if (own && h.canAct) h.stop("soak_end");
    s.state = "DONE";
    return;
  }
  if (!h.canAct || h.full) return;
  if (i.house.pvW === null || i.house.feedinW === null) {
    if (!s.solarVarsAlerted) {
      a.push({ kind: "notify", message: "pvPower/feedinPower missing — afternoon solar soak disabled" });
      s.solarVarsAlerted = true;
    }
    if (own) h.stop("solar_vars_missing");
    s.state = "DONE";
    return;
  }
  if (s.soakHold > 0) s.soakHold--;
  const spareW = i.house.pvW - i.house.loadW; // PV beyond house + car
  const batteryW = i.house.feedinW - i.house.gridImportW - spareW;

  if (own) {
    if (s.lastAmps === null) s.lastAmps = i.car.chargeAmps;
    const stopSoak = (reason: string) => {
      h.stop(reason);
      s.soakHold = SOAK_RESTART_HOLD_TICKS;
      s.soakLowTicks = 0;
    };
    if (i.house.socPct < SOAK_MIN_SOC) {
      stopSoak("soak_battery_low");
    } else if (batteryW > SOAK_DISCHARGE_W) {
      if (s.lastAmps <= MIN_AMPS) {
        if (++s.soakLowTicks >= SOAK_LOW_TICKS) stopSoak("soak_below_min");
      } else {
        s.soakLowTicks = 0;
        const target = clampAmps(s.lastAmps - Math.ceil(batteryW / W_PER_AMP));
        a.push({ kind: "set_amps", amps: target });
        s.lastAmps = target;
        s.soakHold = SOAK_STEP_HOLD_TICKS;
      }
    } else {
      s.soakLowTicks = 0;
      const visibleW = Math.max(i.house.feedinW - i.house.gridImportW, spareW);
      let target = s.lastAmps + Math.max(0, Math.floor((visibleW - EXPORT_MARGIN_W) / W_PER_AMP));
      if (target === s.lastAmps && s.soakHold === 0 && i.house.socPct >= SOAK_START_SOC) target++; // probe
      target = clampAmps(target);
      if (target !== s.lastAmps) {
        a.push({ kind: "set_amps", amps: target });
        s.lastAmps = target;
      }
    }
  } else if (
    !h.charging &&
    i.house.socPct >= SOAK_START_SOC &&
    i.nowMins < SOAK_LAST_START_MINS &&
    s.soakHold === 0 &&
    s.soakStarts < SOAK_MAX_STARTS &&
    h.canStart()
  ) {
    // Full battery = PV is (probably) being curtailed. A failed probe costs
    // at most SOAK_LOW_TICKS of the car's minimum from a full battery.
    s.soakStarts++;
    s.soakLowTicks = 0;
    h.start(MIN_AMPS);
  }
}
