/**
 * House reserve calculation. See SPEC.md "PLAN".
 *
 * reserve_kwh = forecast house load from `nowSlot` until 11:00 x safetyFactor
 * reserve_pct = ceil(reserve_kwh / batteryKwh * 100) + floor, clamped 10..100
 *
 * `floor` is the FoxESS minSocOnGrid (10% BMS minimum unless the owner raised
 * it). The house's energy sits ON TOP of it: the inverter won't discharge
 * below the floor, so a reserve AT the floor would leave the house on paid
 * grid until 11:00 (owner, 2026-09-27: never pull from grid because the
 * battery hit its minimum).
 *
 * Forecast per half-hour slot = mean of `samples` rows for that slot; the
 * caller passes rows already filtered to the days it wants averaged (e.g.
 * last 5 weekdays). Slots with no samples fall back to a flat 1.0 kW
 * (0.5 kWh/slot), which also covers the no-history bootstrap.
 */

import { BOOTSTRAP_SLOT_KWH, WINDOW_START_SLOT } from "./constants";

export function reservePct(opts: {
  nowSlot: number; // half-hour slot index 0..47, Brisbane
  samples: { slot: number; loadKwh: number }[];
  safetyFactor: number;
  batteryKwh: number; // 42
  floorPct?: number; // FoxESS minSocOnGrid; default / below-minimum -> 10
}): number {
  const { nowSlot, samples, safetyFactor, batteryKwh } = opts;
  const floor = Math.max(10, opts.floorPct ?? 10);

  const bySlot = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const agg = bySlot.get(s.slot) ?? { sum: 0, n: 0 };
    agg.sum += s.loadKwh;
    agg.n += 1;
    bySlot.set(s.slot, agg);
  }

  // Slots from nowSlot up to (not including) 11:00, wrapping past midnight
  // so an evening dump's horizon of "until 11:00 tomorrow" also works.
  // At exactly 11:00 the horizon is empty and the reserve is the 10% floor.
  const nSlots = (WINDOW_START_SLOT - nowSlot + 48) % 48;
  let forecastKwh = 0;
  for (let i = 0; i < nSlots; i++) {
    const agg = bySlot.get((nowSlot + i) % 48);
    forecastKwh += agg ? agg.sum / agg.n : BOOTSTRAP_SLOT_KWH;
  }

  const pct = Math.ceil(((forecastKwh * safetyFactor) / batteryKwh) * 100) + floor;
  return Math.min(100, Math.max(10, pct));
}
