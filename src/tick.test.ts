import { describe, expect, it } from "vitest";
import { decide, type Action, type DecideInputs, type StoredState } from "./tick";

/** 06:00 Brisbane, car plugged in at home below limit, battery above reserve,
 *  no sun, fresh day (stored = null -> PLAN runs). */
function base(): DecideInputs {
  return {
    date: "2026-07-06",
    nowMins: 6 * 60,
    car: { pluggedIn: true, chargingState: "Stopped", socPct: 50, limitPct: 80, chargeAmps: 16, atHome: true },
    house: { socPct: 44, loadW: 400, gridImportW: 0, pvW: 0, feedinW: 0 },
    cfg: { safetyFactor: 1.3, strandedMinPct: 30, solarTrack: true, solarSoak: true, shadowMode: false },
    samples: [],
    floorPct: 10,
    stored: null,
  };
}

/** Stored state as a fresh PLAN would create it, with overrides. */
function stored(over: Partial<StoredState> = {}): StoredState {
  return {
    date: "2026-07-06",
    state: "IDLE",
    reservePct: 17,
    sessionOwner: null,
    startPending: -1,
    startBlocked: false,
    lastAmps: null,
    surplusStreak: 0,
    solarResumes: 0,
    manualNoted: false,
    solarVarsAlerted: false,
    highImportTicks: 0,
    soakStarts: 0,
    soakHold: 0,
    soakLowTicks: 0,
    ...over,
  };
}

const kinds = (a: Action[]) => a.map((x) => x.kind);

describe("PLAN (first tick of day)", () => {
  it("computes bootstrap reserve with no samples (06:00 -> 10 slots x 0.5 kWh x 1.3)", () => {
    const { next } = decide(base());
    // 5.0 kWh x 1.3 / 42 = 15.5% -> ceil 16 + 10 = 26
    expect(next.reservePct).toBe(26);
  });

  it("computes data-driven reserve from samples", () => {
    const i = base();
    for (let slot = 12; slot < 22; slot++) i.samples.push({ slot, loadKwh: 0.2 });
    const { next } = decide(i);
    // 2.0 x 1.3 / 42 = 6.2% -> ceil 7 + 10 = 17
    expect(next.reservePct).toBe(17);
  });

  it("re-plans when the stored state is from yesterday", () => {
    const i = base();
    i.stored = stored({ date: "2026-07-05", state: "DONE", solarResumes: 4 });
    const { next } = decide(i);
    expect(next.date).toBe("2026-07-06");
    expect(next.solarResumes).toBe(0);
  });

  it("adopts an owner-raised minSocOnGrid above the forecast as the effective reserve", () => {
    const i = base();
    i.floorPct = 35; // owner raised it in the FoxESS app; forecast says 26
    const { next } = decide(i);
    expect(next.reservePct).toBe(35);
  });

  it("keeps the forecast reserve when the floor is at the 10% BMS minimum", () => {
    const i = base();
    i.floorPct = 10; // manufacturer minimum, below the 26% forecast
    const { next } = decide(i);
    expect(next.reservePct).toBe(26);
  });

  it("falls back to the forecast reserve when the floor read failed (null)", () => {
    const i = base();
    i.floorPct = null;
    const { next } = decide(i);
    expect(next.reservePct).toBe(26);
  });
});

describe("DUMPING", () => {
  it("enters from IDLE and starts at 16 A in the same tick", () => {
    const i = base();
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(next.state).toBe("DUMPING");
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
    expect(next.sessionOwner).toBe("system");
    expect(next.startPending).toBe(0);
  });

  it("does not resend start while confirmation is pending", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 0, lastAmps: 16 });
    const { actions } = decide(i);
    expect(kinds(actions)).not.toContain("start_charging");
  });

  it("alerts and blocks after 2 unconfirmed ticks (invariant 4)", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 1, lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(next.startBlocked).toBe(true);
    expect(next.sessionOwner).toBeNull();
    // and stays blocked: no new start attempt this tick or the next
    expect(kinds(actions)).not.toContain("start_charging");
    const again = decide({ ...i, stored: next });
    expect(kinds(again.actions)).not.toContain("start_charging");
  });

  it("confirms the start when the car reports Charging", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 0, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startPending).toBe(-1);
    expect(next.sessionOwner).toBe("system");
  });

  it("derates 2 A when the battery limits (import > 500 W)", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.gridImportW = 600;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "set_amps", amps: 14 });
    expect(next.lastAmps).toBe(14);
  });

  it("recovers 2 A when headroom returns, and never exceeds 16", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.gridImportW = 0;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 14 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 16 });
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(kinds(decide(i).actions)).not.toContain("set_amps"); // no-op dedupe
  });

  it("exits to SOLAR_TRACK at the SoC floor and acts the same tick (spec example)", () => {
    // 16 A car + 400 W house on 6 kW PV: the floor-hit shortfall is paid
    // import, and at reserve PV doesn't cover the load -> reserve_hit now.
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 17, loadW: 11440, gridImportW: 5440, pvW: 6000, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(next.state).toBe("SOLAR_TRACK");
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
  });

  it("exits to SOLAR_TRACK on the 8 kW import backstop even above the SoC floor", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 30, loadW: 400, gridImportW: 9000, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).next.state).toBe("SOLAR_TRACK");
  });
});

describe("SOLAR_TRACK", () => {
  // pvW default covers the load: at/below reserve a charge may only run on
  // PV surplus (reserve_hit stop otherwise), so the meter-loop tests need sun.
  const solar = (over: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}): DecideInputs => {
    const i = base();
    i.house = { socPct: 17, loadW: 400, gridImportW: 0, pvW: 6000, feedinW: 0, ...over };
    i.stored = stored({ state: "SOLAR_TRACK", ...st });
    return i;
  };

  it("steps amps up with export headroom", () => {
    // loadsPower includes the car: 400 W house + 7 A x 690 W
    const i = solar({ loadW: 5230, pvW: 6730, feedinW: 1500 }, { sessionOwner: "system", lastAmps: 7 });
    i.car.chargingState = "Charging";
    // 7 + floor((1500-0-250)/690) = 7 + 1 = 8
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 8 });
  });

  it("holds amps inside the export margin (no-op dedupe)", () => {
    const i = solar({ loadW: 5920, pvW: 6220, feedinW: 300 }, { sessionOwner: "system", lastAmps: 8 });
    i.car.chargingState = "Charging";
    expect(kinds(decide(i).actions)).not.toContain("set_amps");
  });

  it("stops when clamped at 5 A and still importing", () => {
    // above reserve (so not reserve_hit): the battery can't be what's short
    const i = solar({ socPct: 18, loadW: 3850, pvW: 3450, gridImportW: 400 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "below_solar_min" });
    expect(next.sessionOwner).toBeNull();
  });

  it("steps down to 5 A first when arriving from higher amps", () => {
    const i = solar({ socPct: 18, loadW: 5920, pvW: 2920, gridImportW: 3000 }, { sessionOwner: "system", lastAmps: 8 });
    i.car.chargingState = "Charging";
    const { actions } = decide(i);
    expect(actions).toContainEqual({ kind: "set_amps", amps: 5 });
    expect(kinds(actions)).not.toContain("stop_charging");
  });

  it("stops immediately at reserve when PV doesn't cover the load (2026-07-08 floor-drain)", () => {
    // replay of the 06:20 tick: SoC 15 ≤ reserve, no sun, battery feeding the
    // car at ~11 kW while the meter reads ~0 — the amp loop can't see it.
    const i = solar(
      { socPct: 15, loadW: 11913, gridImportW: 19, pvW: 0 },
      { sessionOwner: "system", lastAmps: 16, reservePct: 16 },
    );
    i.car.chargingState = "Charging";
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
    expect(kinds(actions)).not.toContain("set_amps");
    expect(next.sessionOwner).toBeNull();
  });

  it("DUMPING reserve-hit with no sun stops the same tick instead of amp-tracking", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 15, loadW: 11913, gridImportW: 19, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16, reservePct: 16 });
    const { actions, next } = decide(i);
    expect(next.state).toBe("SOLAR_TRACK");
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
  });

  it("keeps charging at reserve while PV covers the whole load", () => {
    const i = solar({ socPct: 17, loadW: 4000, pvW: 6000, feedinW: 300 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    expect(kinds(decide(i).actions)).not.toContain("stop_charging");
  });

  it("resumes at 5 A only after 3 consecutive surplus ticks", () => {
    let st = stored({ state: "SOLAR_TRACK" });
    for (const expectStart of [false, false, true]) {
      const i = solar({ pvW: 5200 }, st);
      const { actions, next } = decide(i);
      expect(kinds(actions).includes("start_charging")).toBe(expectStart);
      st = next;
    }
    expect(st.solarResumes).toBe(1);
    expect(st.lastAmps).toBe(5);
  });

  it("a cloudy tick resets the resume streak", () => {
    const i = solar({ pvW: 2000 }, { surplusStreak: 2 });
    expect(decide(i).next.surplusStreak).toBe(0);
  });

  it("enforces the daily resume cap", () => {
    const i = solar({ pvW: 8000 }, { surplusStreak: 2, solarResumes: 4 });
    expect(kinds(decide(i).actions)).not.toContain("start_charging");
  });

  it("solar_track=false never resumes (floor-hold behaviour)", () => {
    const i = solar({ pvW: 8000 }, { surplusStreak: 2 });
    i.cfg.solarTrack = false;
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.surplusStreak).toBe(0);
  });

  it("missing pv/feedin: alert once, stop the charge, degrade to floor-hold", () => {
    const i = solar({ pvW: null, feedinW: null }, { sessionOwner: "system", lastAmps: 7 });
    i.car.chargingState = "Charging";
    const first = decide(i);
    expect(kinds(first.actions)).toContain("notify");
    expect(kinds(first.actions)).toContain("stop_charging");
    const i2 = solar({ pvW: null, feedinW: null }, first.next);
    expect(decide(i2).actions).toHaveLength(0); // alert not repeated
  });

  it("sustained import (failed amp commands) stops after 3 ticks", () => {
    let st = stored({ state: "SOLAR_TRACK", sessionOwner: "system", lastAmps: 5, highImportTicks: 0 });
    let stopped = false;
    for (let t = 0; t < 3; t++) {
      const i = solar({ gridImportW: 2500, feedinW: 0 }, st);
      i.car.chargingState = "Charging";
      const r = decide(i);
      stopped = kinds(r.actions).includes("stop_charging");
      st = r.next;
      if (stopped) break;
    }
    expect(stopped).toBe(true);
  });

  it("follows PV the battery is absorbing (meter reads 0 at the floor)", () => {
    // 5 A car + 400 W house = 3850 W load on 6 kW PV, no export: Self-Use
    // puts the spare ~2.1 kW into the battery, invisible to the meter.
    const i = solar({ loadW: 3850, pvW: 6000, feedinW: 0 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    // 5 + floor((2150 - 250)/690) = 5 + 2 = 7
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 7 });
  });

  it("battery discharging above reserve: no phantom surplus, stays at 5 A", () => {
    const i = solar({ socPct: 20, loadW: 3850, pvW: 1500, feedinW: 0 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    expect(decide(i).actions).toHaveLength(0);
  });

  it("solar bank: resumes at 5 A once banked PV + surplus carry 20 min of the minimum", () => {
    // 2 kW surplus -> 1.45 kW deficit x 20 min = 483 Wh; 1% = 420 Wh, 2% = 840 Wh
    expect(kinds(decide(solar({ socPct: 18, pvW: 2400 })).actions)).not.toContain("start_charging");
    const { actions, next } = decide(solar({ socPct: 19, pvW: 2400 }));
    expect(actions).toContainEqual({ kind: "start_charging", amps: 5 });
    expect(next.solarResumes).toBe(1);
    expect(next.state).toBe("SOLAR_TRACK"); // not a 16 A DUMPING burst
  });

  it("solar bank with no sun needs car min + house for 20 min (1.28 kWh -> 4%)", () => {
    expect(kinds(decide(solar({ socPct: 20, pvW: 0 })).actions)).not.toContain("start_charging");
    expect(kinds(decide(solar({ socPct: 21, pvW: 0 })).actions)).toContain("start_charging");
  });

  it("solar bank never fires at or below reserve, and respects the resume cap and solar_track", () => {
    expect(decide(solar({ socPct: 17, pvW: 3000 })).actions).toHaveLength(0);
    expect(decide(solar({ socPct: 20, pvW: 3000 }, { solarResumes: 4 })).actions).toHaveLength(0);
    const off = solar({ socPct: 20, pvW: 3000 });
    off.cfg.solarTrack = false;
    expect(decide(off).actions).toHaveLength(0);
  });

  it("bounces back to DUMPING when PV lifts the battery over reserve + 5", () => {
    const i = solar({ socPct: 23 }); // reserve 17 -> 23 > 22
    expect(decide(i).next.state).toBe("DUMPING");
  });

  it("stays SOLAR_TRACK at reserve + 5 exactly", () => {
    const i = solar({ socPct: 22 });
    expect(decide(i).next.state).toBe("SOLAR_TRACK");
  });
});

describe("manual override (invariant 6)", () => {
  it("marks an unexpected charge as owner, notes once, sends no commands", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.stored = stored();
    const first = decide(i);
    expect(first.next.sessionOwner).toBe("owner");
    expect(first.actions).toEqual([{ kind: "notify", message: "manual charge detected — not interfering" }]);
    expect(first.next.state).toBe("IDLE");
    const second = decide({ ...i, stored: first.next });
    expect(second.actions).toHaveLength(0); // one note per session
  });

  it("away sessions (supercharger) are owner sessions with no note", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.car.atHome = false;
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.sessionOwner).toBe("owner");
  });

  it("owner session ending clears ownership for the next detection", () => {
    const i = base();
    i.house.socPct = 17; // at reserve: no dump starts, isolating the clearing
    i.stored = stored({ sessionOwner: "owner", manualNoted: true });
    const { next } = decide(i);
    expect(next.sessionOwner).toBeNull();
    expect(next.manualNoted).toBe(false);
  });

  it("owner stopping their own session hands control back to the system", () => {
    const i = base(); // battery above reserve -> the system dumps again
    i.stored = stored({ sessionOwner: "owner", manualNoted: true });
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
    expect(next.sessionOwner).toBe("system");
  });

  it("external stop of a system session stands down with one alert", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(next.startBlocked).toBe(true);
    expect(kinds(actions)).not.toContain("start_charging");
  });

  it("Complete is a natural end: no alert, no stand-down", () => {
    const i = base();
    i.car.chargingState = "Complete";
    i.car.socPct = 80;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.startBlocked).toBe(false);
    expect(next.state).toBe("IDLE");
  });
});

describe("geofence (invariant 7)", () => {
  it("no commands when the car is plugged in away from home", () => {
    const i = base();
    i.car.atHome = false;
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.state).toBe("IDLE");
  });

  it("no commands in the free window either", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.atHome = false;
    i.stored = stored();
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("unplugged", () => {
  it("resets to IDLE with no actions", () => {
    const i = base();
    i.car.pluggedIn = false;
    i.car.chargingState = "Disconnected";
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.state).toBe("IDLE");
    expect(next.sessionOwner).toBeNull();
  });
});

describe("FREE_WINDOW", () => {
  it("starts at 16 A when the car is idle at 11:00", () => {
    const i = base();
    i.nowMins = 11 * 60;
    i.stored = stored({ state: "DUMPING" });
    const { actions, next } = decide(i);
    expect(next.state).toBe("FREE_WINDOW");
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
  });

  it("window entry resets a morning stand-down (free power is free)", () => {
    const i = base();
    i.nowMins = 11 * 60;
    i.stored = stored({ state: "SOLAR_TRACK", startBlocked: true });
    const { actions } = decide(i);
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
  });

  it("bumps a system session back to 16 A", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 7 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 16 });
  });

  it("leaves pre-window owner sessions alone (ownership is sticky)", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.car.chargeAmps = 10;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "owner", manualNoted: true });
    expect(decide(i).actions).toHaveLength(0);
  });

  it("adopts a native-schedule start inside the window (no owner branding, 16 A, 14:00 stop applies)", () => {
    const i = base();
    i.nowMins = 11 * 60 + 5; // native Tesla schedule fired at 11:00
    i.car.chargingState = "Charging";
    i.car.chargeAmps = 10;
    i.stored = stored({ state: "DUMPING" }); // no session claim
    const { actions, next } = decide(i);
    expect(next.sessionOwner).toBe("system");
    expect(kinds(actions)).not.toContain("notify");
    expect(actions).toContainEqual({ kind: "set_amps", amps: 16 });
    // ...and at 14:00 the adopted session is stopped like any system session
    const end = { ...i, nowMins: 14 * 60, stored: next, cfg: { ...i.cfg, solarSoak: false } };
    expect(decide(end).actions).toContainEqual({ kind: "stop_charging", reason: "window_end" });
  });

  it("does not adopt in-window charging away from home", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.car.atHome = false;
    i.stored = stored({ state: "FREE_WINDOW" });
    const { actions, next } = decide(i);
    expect(next.sessionOwner).toBe("owner");
    expect(actions).toHaveLength(0);
  });

  it("does nothing when the car is full", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.socPct = 80;
    i.stored = stored({ state: "FREE_WINDOW" });
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("window end (14:00)", () => {
  it("solar_soak=false: stops a system session and goes DONE", () => {
    const i = base();
    i.cfg.solarSoak = false;
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "window_end" });
    expect(next.state).toBe("DONE");
  });

  it("below stranded min: alerts and leaves the paid charge running", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.car.socPct = 25;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(kinds(actions)).not.toContain("stop_charging");
    expect(next.state).toBe("DONE");
  });

  it("never stops an owner session at window end", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "owner", manualNoted: true });
    expect(kinds(decide(i).actions)).not.toContain("stop_charging");
  });

  it("DONE stays quiet", () => {
    const i = base();
    i.nowMins = 14 * 60 + 10;
    i.stored = stored({ state: "DONE" });
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("SOLAR_SOAK (after the window)", () => {
  /** 15:00, battery full, car on a system session at `amps`; loadsPower
   *  includes the car. Inverter curtailing: pv == load, no export. */
  const soakIn = (
    amps: number,
    over: Partial<DecideInputs["house"]> = {},
    st: Partial<StoredState> = {},
  ): DecideInputs => {
    const i = base();
    i.nowMins = 15 * 60;
    i.car.chargingState = "Charging";
    i.car.chargeAmps = amps;
    const load = 400 + amps * 690;
    i.house = { socPct: 100, loadW: load, gridImportW: 0, pvW: load, feedinW: 0, ...over };
    i.stored = stored({ state: "SOLAR_SOAK", sessionOwner: "system", lastAmps: amps, ...st });
    return i;
  };

  it("14:00: throttles the free-window session to visible PV instead of stopping", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    // 16 A car (11040 W) + 400 W house; PV 5 kW visible -> floor((5000-400-250)/690) = 6
    i.house = { socPct: 100, loadW: 11440, gridImportW: 6440, pvW: 5000, feedinW: 0 };
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 6 }]);
    expect(next.state).toBe("SOLAR_SOAK");
    expect(next.sessionOwner).toBe("system");
  });

  it("14:00 with no visible PV throttles to 5 A (the probe climbs from there)", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.house = { socPct: 100, loadW: 11440, gridImportW: 11440, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 5 }]);
  });

  it("14:00 stranded-min rule still wins: leave the charge running, DONE", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.car.socPct = 25;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toEqual(["notify"]);
    expect(next.state).toBe("DONE");
  });

  it("battery full and balanced (curtailing): probes up 1 A", () => {
    expect(decide(soakIn(8)).actions).toEqual([{ kind: "set_amps", amps: 9 }]);
  });

  it("does not probe while the battery is below full, or during a hold", () => {
    expect(decide(soakIn(8, { socPct: 96 })).actions).toHaveLength(0);
    expect(decide(soakIn(8, {}, { soakHold: 2 })).actions).toHaveLength(0);
  });

  it("takes visible export in one step", () => {
    const i = soakIn(6, { pvW: 400 + 6 * 690 + 2000, feedinW: 2000 });
    // 6 + floor((2000-250)/690) = 8
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 8 }]);
  });

  it("battery discharging: steps down by the deficit and holds before re-probing", () => {
    const i = soakIn(10, { pvW: 400 + 10 * 690 - 1000 }); // battery covering 1 kW
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 8 }]); // ceil(1000/690) = 2
    expect(next.soakHold).toBe(3);
  });

  it("at 5 A and discharging: rides out one tick (cloud), stops on the second", () => {
    const i = soakIn(5, { pvW: 1500 });
    const first = decide(i);
    expect(first.actions).toHaveLength(0);
    expect(first.next.soakLowTicks).toBe(1);
    const second = decide({ ...i, stored: first.next });
    expect(second.actions).toEqual([{ kind: "stop_charging", reason: "soak_below_min" }]);
    expect(second.next.sessionOwner).toBeNull();
    expect(second.next.soakHold).toBe(6);
  });

  it("hard stop below the battery floor (evening export + tomorrow's dump untouched)", () => {
    const { actions } = decide(soakIn(8, { socPct: 89 }));
    expect(actions).toEqual([{ kind: "stop_charging", reason: "soak_battery_low" }]);
  });

  it("amps stay within [5,16]", () => {
    expect(decide(soakIn(16)).actions).toHaveLength(0); // probe clamped at max
    const big = soakIn(6, { pvW: 400 + 6 * 690 + 20000, feedinW: 20000 });
    expect(decide(big).actions).toEqual([{ kind: "set_amps", amps: 16 }]);
  });

  it("starts at 5 A when the battery is full and the car is idle", () => {
    const i = soakIn(0, { loadW: 400, pvW: 400 }, { sessionOwner: null, lastAmps: null });
    i.car.chargingState = "Stopped";
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "start_charging", amps: 5 }]);
    expect(next.soakStarts).toBe(1);
    expect(next.sessionOwner).toBe("system");
  });

  it("no start: battery not full, restart hold, daily cap, after 16:30, start blocked", () => {
    const idle = (over: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}) => {
      const i = soakIn(0, { loadW: 400, pvW: 400, ...over }, { sessionOwner: null, lastAmps: null, ...st });
      i.car.chargingState = "Stopped";
      return i;
    };
    expect(decide(idle({ socPct: 95 })).actions).toHaveLength(0);
    expect(decide(idle({}, { soakHold: 3 })).actions).toHaveLength(0);
    expect(decide(idle({}, { soakStarts: 3 })).actions).toHaveLength(0);
    expect(decide(idle({}, { startBlocked: true })).actions).toHaveLength(0);
    const late = idle({});
    late.nowMins = 16 * 60 + 30;
    expect(decide(late).actions).toHaveLength(0);
  });

  it("re-plug after 14:00 (IDLE) enters SOLAR_SOAK and can start", () => {
    const i = soakIn(0, { loadW: 400, pvW: 400 }, { state: "IDLE", sessionOwner: null, lastAmps: null });
    i.car.chargingState = "Stopped";
    const { actions, next } = decide(i);
    expect(next.state).toBe("SOLAR_SOAK");
    expect(kinds(actions)).toContain("start_charging");
  });

  it("17:30: stops the soak session and goes DONE", () => {
    const i = soakIn(8);
    i.nowMins = 17 * 60 + 30;
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "stop_charging", reason: "soak_end" }]);
    expect(next.state).toBe("DONE");
  });

  it("never touches an owner session (invariant 6) or acts away from home (invariant 7)", () => {
    const owner = soakIn(16, {}, { sessionOwner: "owner", manualNoted: true });
    expect(decide(owner).actions).toHaveLength(0);
    const away = soakIn(8);
    away.car.atHome = false;
    expect(decide(away).actions).toHaveLength(0);
  });

  it("car full: nothing to do", () => {
    const i = soakIn(8);
    i.car.socPct = 80;
    expect(decide(i).actions).toHaveLength(0);
  });

  it("missing pv/feedin: alert once, stop, DONE", () => {
    const { actions, next } = decide(soakIn(8, { pvW: null, feedinW: null }));
    expect(kinds(actions)).toEqual(["notify", "stop_charging"]);
    expect(next.state).toBe("DONE");
  });

  it("loads a state row persisted before soak fields existed", () => {
    const i = soakIn(8);
    const legacy = { ...i.stored! } as Partial<StoredState>;
    delete legacy.soakHold;
    delete legacy.soakStarts;
    delete legacy.soakLowTicks;
    i.stored = legacy as StoredState;
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 9 }]);
    expect(next.soakHold).toBe(0);
  });
});

describe("shadow mode", () => {
  it("failed start verification does not block retries", () => {
    const i = base();
    i.cfg.shadowMode = true;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 1, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startBlocked).toBe(false);
  });

  it("never-charging car does not trigger the external-stop stand-down", () => {
    const i = base();
    i.cfg.shadowMode = true;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: -1, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startBlocked).toBe(false);
  });
});

describe("amp maths sanity", () => {
  it("full sweep: amps always within [5,16] whatever the meter says", () => {
    for (const feedin of [0, 500, 3000, 12000]) {
      for (const imp of [0, 300, 2000, 11000]) {
        for (const last of [5, 8, 16]) {
          const i = base();
          i.car.chargingState = "Charging";
          i.house = { socPct: 17, loadW: 400, gridImportW: imp, pvW: 5000, feedinW: feedin };
          i.stored = stored({ state: "SOLAR_TRACK", sessionOwner: "system", lastAmps: last });
          for (const act of decide(i).actions) {
            if (act.kind === "set_amps") {
              expect(act.amps).toBeGreaterThanOrEqual(5);
              expect(act.amps).toBeLessThanOrEqual(16);
            }
          }
        }
      }
    }
  });
});
