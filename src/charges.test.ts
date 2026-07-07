import { describe, expect, it } from "vitest";
import { excludedSlots, haversineM } from "./charges";

// Arbitrary test coordinates (Brisbane CBD) — the real geofence lives in D1 config.
const HOME = { lat: -27.47, lon: 153.03 };
const bris = (s: string) => Date.parse(`${s}+10:00`);

describe("excludedSlots", () => {
  it("marks the slots a home charge overlaps", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:00:00"), endedAtMs: bris("2026-07-01T10:00:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0)].sort()).toEqual([18, 19]);
  });

  it("partial-slot overlap still excludes the slot", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:15:00"), endedAtMs: bris("2026-07-01T09:20:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0)]).toEqual([18]);
  });

  it("handles a charge spanning midnight from the previous day", () => {
    const charges = [
      { startedAtMs: bris("2026-06-30T23:30:00"), endedAtMs: bris("2026-07-01T00:45:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0)].sort()).toEqual([0, 1]);
  });

  it("ignores charges away from home", () => {
    const supercharger = { lat: -27.57, lon: 153.03 }; // ~11 km away
    const charges = [
      {
        startedAtMs: bris("2026-07-01T09:00:00"),
        endedAtMs: bris("2026-07-01T10:00:00"),
        lat: supercharger.lat,
        lon: supercharger.lon,
      },
    ];
    expect(excludedSlots(charges, HOME, "2026-07-01", 0).size).toBe(0);
  });

  it("treats unknown location as home (conservative)", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:00:00"), endedAtMs: bris("2026-07-01T09:31:00"), lat: null, lon: null },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0)].sort()).toEqual([18, 19]);
  });

  it("clamps a still-running charge (null end) to now", () => {
    const charges = [{ startedAtMs: bris("2026-07-01T08:00:00"), endedAtMs: null, ...HOME_XY }];
    const now = bris("2026-07-01T09:10:00");
    expect([...excludedSlots(charges, HOME, "2026-07-01", now)].sort()).toEqual([16, 17, 18]);
  });

  it("charge entirely on another day excludes nothing", () => {
    const charges = [
      { startedAtMs: bris("2026-06-30T09:00:00"), endedAtMs: bris("2026-06-30T10:00:00"), ...HOME_XY },
    ];
    expect(excludedSlots(charges, HOME, "2026-07-01", 0).size).toBe(0);
  });
});

const HOME_XY = { lat: HOME.lat, lon: HOME.lon };

describe("haversineM", () => {
  it("zero distance to itself, ~111 km per degree of latitude", () => {
    expect(haversineM(HOME.lat, HOME.lon, HOME.lat, HOME.lon)).toBe(0);
    expect(haversineM(0, 0, 1, 0)).toBeGreaterThan(110_000);
    expect(haversineM(0, 0, 1, 0)).toBeLessThan(112_000);
  });
});
