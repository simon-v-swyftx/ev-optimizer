import { describe, expect, it } from "vitest";
import { localMidnightMs, localNow, offsetSuffix, siteFromEnv, type SiteVars } from "./site";
import { TEST_SITE } from "./testing";
import { decide, type DecideInputs } from "./tick";
import wranglerJsonc from "../wrangler.jsonc?raw";

const vars: SiteVars = {
  UTC_OFFSET: "+10:00",
  FREE_WINDOW_START: "11:00",
  FREE_WINDOW_END: "14:00",
  DAY_START: "05:30",
  SOLAR_SOAK_END: "17:30",
  BATTERY_KWH: "42",
  BATTERY_MIN_SOC: "10",
  CHARGER_VOLTS: "230",
  CHARGER_PHASES: "3",
  CHARGER_MIN_AMPS: "5",
  CHARGER_MAX_AMPS: "16",
  HOME_RADIUS_M: "150",
};

describe("siteFromEnv", () => {
  it("accepts the vars committed in wrangler.jsonc (CI catches a broken edit before deploy)", () => {
    const json = wranglerJsonc.replace(/^\s*\/\/.*$/gm, ""); // full-line comments only
    const cfg = JSON.parse(json) as { vars: SiteVars };
    expect(() => siteFromEnv(cfg.vars)).not.toThrow();
  });

  it("parses wrangler vars (strings or numbers)", () => {
    expect(siteFromEnv(vars)).toEqual({
      tzOffsetMins: 600,
      windowStartMins: 660,
      windowEndMins: 840,
      dayStartMins: 330,
      soakEndMins: 1050,
      batteryKwh: 42,
      batteryMinSocPct: 10,
      wPerAmp: 690,
      minAmps: 5,
      maxAmps: 16,
      homeRadiusM: 150,
    });
    expect(siteFromEnv({ ...vars, BATTERY_KWH: 13.5, CHARGER_PHASES: 1 }).wPerAmp).toBe(230);
  });

  it("lists every missing var instead of defaulting to someone else's site", () => {
    const { UTC_OFFSET: _a, BATTERY_KWH: _b, ...rest } = vars;
    expect(() => siteFromEnv(rest)).toThrow("missing site vars in wrangler.jsonc: UTC_OFFSET, BATTERY_KWH");
  });

  it("rejects malformed values", () => {
    expect(() => siteFromEnv({ ...vars, UTC_OFFSET: "10" })).toThrow("±HH:MM");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_START: "11am" })).toThrow("HH:MM");
    expect(() => siteFromEnv({ ...vars, BATTERY_KWH: "-1" })).toThrow("positive");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_START: "11:15" })).toThrow("half hour");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_END: "10:00" })).toThrow("DAY_START <");
    expect(() => siteFromEnv({ ...vars, SOLAR_SOAK_END: "13:00" })).toThrow("SOLAR_SOAK_END");
    expect(() => siteFromEnv({ ...vars, CHARGER_MIN_AMPS: "20" })).toThrow("min <= max");
  });
});

describe("local time helpers", () => {
  it("handles positive, negative and half-hour offsets", () => {
    const at = new Date("2026-07-01T20:00:00Z");
    expect(localNow({ tzOffsetMins: 600 }, at).toISOString()).toBe("2026-07-02T06:00:00.000Z");
    expect(localMidnightMs({ tzOffsetMins: 600 }, "2026-07-02")).toBe(Date.parse("2026-07-01T14:00:00Z"));
    expect(localMidnightMs({ tzOffsetMins: -300 }, "2026-07-02")).toBe(Date.parse("2026-07-02T05:00:00Z"));
    expect(offsetSuffix({ tzOffsetMins: 600 })).toBe("+1000");
    expect(offsetSuffix({ tzOffsetMins: 570 })).toBe("+0930");
    expect(offsetSuffix({ tzOffsetMins: -210 })).toBe("-0330");
  });
});

describe("decide honours the site", () => {
  const inputs = (nowMins: number, site = TEST_SITE): DecideInputs => ({
    date: "2026-07-06",
    nowMins,
    site,
    car: { pluggedIn: true, chargingState: "Stopped", socPct: 50, limitPct: 80, chargeAmps: 16, atHome: true },
    house: { socPct: 15, loadW: 400, gridImportW: 0, pvW: 0, feedinW: 0 },
    cfg: { safetyFactor: 1.3, strandedMinPct: 30, solarTrack: true, solarSoak: true, shadowMode: false },
    samples: [],
    floorPct: 10,
    stored: null,
  });

  it("uses the configured free window and charger max", () => {
    const site = siteFromEnv({ ...vars, FREE_WINDOW_START: "09:00", FREE_WINDOW_END: "15:00", CHARGER_MAX_AMPS: "32" });
    // 10:00 is outside the reference window but inside this one
    expect(decide(inputs(600)).next.state).not.toBe("FREE_WINDOW");
    const { actions, next } = decide(inputs(600, site));
    expect(next.state).toBe("FREE_WINDOW");
    expect(actions).toEqual([{ kind: "start_charging", amps: 32 }]);
  });

  it("forecasts the reserve up to the configured window start", () => {
    const early = siteFromEnv({ ...vars, FREE_WINDOW_START: "08:00" });
    // 06:00 -> 4 bootstrap slots x 0.5 kWh x 1.3 / 42 = 6.2% -> 7 + 10
    expect(decide(inputs(360, early)).next.reservePct).toBe(17);
    expect(decide(inputs(360)).next.reservePct).toBe(26);
  });

  it("uses BATTERY_MIN_SOC as the floor when the minSocOnGrid read fails", () => {
    const site = siteFromEnv({ ...vars, BATTERY_MIN_SOC: "20" });
    const i = { ...inputs(360, site), floorPct: null };
    expect(decide(i).next.floorPct).toBe(20);
    expect(decide(i).next.reservePct).toBe(36); // 16% house need on top of 20
  });

  it("scales the floor-hit import trigger with the charger (7.4 kW single-phase)", () => {
    const site = siteFromEnv({ ...vars, CHARGER_PHASES: "1", CHARGER_MIN_AMPS: "6", CHARGER_MAX_AMPS: "32" });
    const dumping = (gridImportW: number) => {
      const i = inputs(400, site);
      i.car.chargingState = "Charging";
      i.house = { ...i.house, socPct: 60, loadW: 7800, gridImportW };
      i.stored = { ...decide(inputs(395, site)).next, state: "DUMPING", sessionOwner: "system", lastAmps: 32 };
      return decide(i).next.state;
    };
    // 32 A x 230 V = 7.36 kW; trigger = 72.5% rounded to 100 W = 5.3 kW. A
    // fixed 8 kW (the 11 kW reference) would never fire on this charger.
    expect(dumping(5400)).toBe("SOLAR_TRACK");
    expect(dumping(5200)).toBe("DUMPING");
  });

  it("resumes on surplus sized to the car's minimum draw", () => {
    const site = siteFromEnv({ ...vars, CHARGER_PHASES: "1", CHARGER_MIN_AMPS: "6", CHARGER_MAX_AMPS: "32" });
    // 6 A x 230 V = 1.38 kW minimum + 1.05 kW headroom = 2.43 kW surplus
    const streak = (pvW: number) => {
      const i = inputs(420, site);
      i.house = { ...i.house, socPct: 15, loadW: 400, pvW };
      i.stored = { ...decide(inputs(415, site)).next, state: "SOLAR_TRACK" };
      return decide(i).next.surplusStreak;
    };
    expect(streak(400 + 2430)).toBe(1);
    expect(streak(400 + 2420)).toBe(0);
  });
});
