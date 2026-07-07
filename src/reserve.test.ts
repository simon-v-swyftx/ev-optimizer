import { describe, expect, it } from "vitest";
import { reservePct } from "./reserve";

const base = { safetyFactor: 1.3, batteryKwh: 42 };

describe("reservePct", () => {
  it("bootstrap: no history, plan at 05:30 (slot 11)", () => {
    // 11 slots x 0.5 kWh = 5.5 kWh x 1.3 = 7.15 -> ceil(17.02) + 10 = 28
    expect(reservePct({ ...base, nowSlot: 11, samples: [] })).toBe(28);
  });

  it("averages multiple days of the same slot", () => {
    // horizon = slot 21 only; mean(1.0, 2.0) = 1.5 x 1.3 = 1.95 -> ceil(4.64) + 10 = 15
    const samples = [
      { slot: 21, loadKwh: 1.0 },
      { slot: 21, loadKwh: 2.0 },
    ];
    expect(reservePct({ ...base, nowSlot: 21, samples })).toBe(15);
  });

  it("partial history: missing slots fall back to 0.5 kWh", () => {
    // slots 20,21; only 20 sampled at 2.0 -> 2.0 + 0.5 = 2.5 x 1.3 = 3.25 -> ceil(7.74) + 10 = 18
    expect(
      reservePct({ ...base, nowSlot: 20, samples: [{ slot: 20, loadKwh: 2.0 }] }),
    ).toBe(18);
  });

  it("ignores samples outside the horizon", () => {
    // slot 30 is after 11:00; horizon = slot 21 bootstrap only -> 0.65 kWh -> ceil(1.55) + 10 = 12
    expect(
      reservePct({ ...base, nowSlot: 21, samples: [{ slot: 30, loadKwh: 99 }] }),
    ).toBe(12);
  });

  it("empty horizon at exactly 11:00 (slot 22) returns the 10% floor", () => {
    expect(reservePct({ ...base, nowSlot: 22, samples: [] })).toBe(10);
  });

  it("clamps to 100 when forecast exceeds the battery", () => {
    const samples = Array.from({ length: 11 }, (_, i) => ({ slot: 11 + i, loadKwh: 10 }));
    expect(reservePct({ ...base, nowSlot: 11, samples })).toBe(100);
  });

  it("clamps to the 10% floor on zero load", () => {
    const samples = Array.from({ length: 11 }, (_, i) => ({ slot: 11 + i, loadKwh: 0 }));
    expect(reservePct({ ...base, nowSlot: 11, samples })).toBe(10);
  });

  it("wraps past midnight for an evening-dump horizon", () => {
    // slot 46 (23:00) -> 24 slots to 11:00 tomorrow; bootstrap 12 kWh x 1.3 = 15.6 -> ceil(37.14) + 10 = 48
    expect(reservePct({ ...base, nowSlot: 46, samples: [] })).toBe(48);
  });
});
