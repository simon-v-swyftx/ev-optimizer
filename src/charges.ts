/**
 * Tessie charge history → local half-hour slots to exclude from
 * load_samples (loadsPower includes the EV charger; see SPEC "Nightly job").
 * Pure functions — keep them exhaustively testable.
 */

import { addDays, localMidnightMs, localSlot, type Site } from "./site";

const SLOT_MS = 30 * 60 * 1000;

export interface Charge {
  startedAtMs: number;
  endedAtMs: number | null; // null = still charging
  lat: number | null; // null = location unknown
  lon: number | null;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/**
 * Slots of `date` (YYYY-MM-DD local) that overlap a home charging session.
 * A charge with unknown location counts as home: wrongly excluding a slot
 * only pushes the forecast toward its conservative 1.0 kW bootstrap, while
 * wrongly keeping one bakes ~10 kW of charger into the house forecast.
 */
export function excludedSlots(
  charges: Charge[],
  home: { lat: number; lon: number },
  date: string,
  nowMs: number,
  site: Pick<Site, "timeZone" | "homeRadiusM">,
): Set<number> {
  const dayStart = localMidnightMs(site, date);
  const dayEnd = localMidnightMs(site, addDays(date, 1)); // 23/24/25 h (DST)
  const out = new Set<number>();
  for (const c of charges) {
    if (
      c.lat !== null &&
      c.lon !== null &&
      haversineM(c.lat, c.lon, home.lat, home.lon) > site.homeRadiusM
    ) {
      continue; // away charge: no effect on house loadsPower
    }
    const end = c.endedAtMs ?? nowMs;
    // Step real half hours and label each by its wall-clock slot, matching
    // how FoxESS samples are bucketed (by their local time string).
    for (let t = dayStart; t < dayEnd; t += SLOT_MS) {
      if (c.startedAtMs < t + SLOT_MS && end > t) out.add(localSlot(site, t));
    }
  }
  return out;
}
