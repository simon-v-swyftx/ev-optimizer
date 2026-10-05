/**
 * Per-install site facts, read at runtime from Worker `vars` (wrangler.jsonc).
 *
 * Every value is REQUIRED: a controller that silently fell back to someone
 * else's timezone or free window would charge the car at the wrong time, so a
 * missing or malformed var throws (the tick fails loud via ntfy) instead.
 * Control-loop tuning that rarely differs between installs stays in
 * src/constants.ts.
 */

export interface Site {
  /** Local-time offset from UTC in minutes. FIXED: no DST (invariant 5). */
  tzOffsetMins: number;
  /** Free grid window, minutes since local midnight. Start is on a half hour
   *  (the reserve forecast works in half-hour slots). */
  windowStartMins: number;
  windowEndMins: number;
  /** First tick of the day (PLAN runs here). */
  dayStartMins: number;
  /** Afternoon solar soak hard stop; no fresh soak starts in its last hour,
   *  and ticks keep running 15 min past it so the stop lands. */
  soakEndMins: number;
  /** Home battery usable capacity. */
  batteryKwh: number;
  /** Battery's own minimum SoC (BMS floor), %. The reserve never sits below
   *  it, and it is assumed when the FoxESS minSocOnGrid read fails. */
  batteryMinSocPct: number;
  /** Charger watts per amp step (volts x phases, e.g. 230 V x 3 = 690). */
  wPerAmp: number;
  minAmps: number;
  maxAmps: number;
  /** Geofence radius around config home_lat/home_lon (invariant 7). */
  homeRadiusM: number;
}

export interface SiteVars {
  UTC_OFFSET?: unknown; // "+10:00"
  FREE_WINDOW_START?: unknown; // "11:00"
  FREE_WINDOW_END?: unknown; // "14:00"
  DAY_START?: unknown; // "05:30"
  SOLAR_SOAK_END?: unknown; // "17:30"
  BATTERY_KWH?: unknown;
  BATTERY_MIN_SOC?: unknown; // %
  CHARGER_VOLTS?: unknown;
  CHARGER_PHASES?: unknown;
  CHARGER_MIN_AMPS?: unknown;
  CHARGER_MAX_AMPS?: unknown;
  HOME_RADIUS_M?: unknown;
}

export function siteFromEnv(env: SiteVars): Site {
  const missing: string[] = [];
  const raw = (k: keyof SiteVars): string => {
    const v = env[k];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.push(k);
      return "";
    }
    return String(v).trim();
  };
  const hhmm = (k: keyof SiteVars): number => {
    const v = raw(k);
    if (!v) return NaN;
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`var ${k}="${v}" must be HH:MM`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const num = (k: keyof SiteVars): number => {
    const v = raw(k);
    if (!v) return NaN;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`var ${k}="${v}" must be a positive number`);
    return n;
  };
  const offset = (k: keyof SiteVars): number => {
    const v = raw(k);
    if (!v) return NaN;
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(v);
    if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) throw new Error(`var ${k}="${v}" must be ±HH:MM`);
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };

  const site: Site = {
    tzOffsetMins: offset("UTC_OFFSET"),
    windowStartMins: hhmm("FREE_WINDOW_START"),
    windowEndMins: hhmm("FREE_WINDOW_END"),
    dayStartMins: hhmm("DAY_START"),
    soakEndMins: hhmm("SOLAR_SOAK_END"),
    batteryKwh: num("BATTERY_KWH"),
    batteryMinSocPct: num("BATTERY_MIN_SOC"),
    wPerAmp: num("CHARGER_VOLTS") * num("CHARGER_PHASES"),
    minAmps: num("CHARGER_MIN_AMPS"),
    maxAmps: num("CHARGER_MAX_AMPS"),
    homeRadiusM: num("HOME_RADIUS_M"),
  };
  if (missing.length) throw new Error(`missing site vars in wrangler.jsonc: ${missing.join(", ")}`);

  if (site.windowStartMins % 30 !== 0) throw new Error("FREE_WINDOW_START must be on the hour or half hour");
  if (!(site.dayStartMins < site.windowStartMins && site.windowStartMins < site.windowEndMins)) {
    throw new Error("need DAY_START < FREE_WINDOW_START < FREE_WINDOW_END");
  }
  if (site.soakEndMins < site.windowEndMins || site.soakEndMins > 23 * 60 + 30) {
    throw new Error("SOLAR_SOAK_END must be between FREE_WINDOW_END and 23:30");
  }
  if (!Number.isInteger(site.batteryMinSocPct) || site.batteryMinSocPct >= 100) {
    throw new Error("BATTERY_MIN_SOC must be a whole percentage below 100");
  }
  if (!Number.isInteger(site.minAmps) || !Number.isInteger(site.maxAmps) || site.minAmps > site.maxAmps) {
    throw new Error("CHARGER_MIN_AMPS / CHARGER_MAX_AMPS must be integers with min <= max");
  }
  return site;
}

/** Local wall-clock time as a Date whose UTC fields read as local time. */
export function localNow(site: Pick<Site, "tzOffsetMins">, now = new Date()): Date {
  return new Date(now.getTime() + site.tzOffsetMins * 60_000);
}

/** UTC epoch ms of local midnight starting `date` (YYYY-MM-DD, local). */
export function localMidnightMs(site: Pick<Site, "tzOffsetMins">, date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - site.tzOffsetMins * 60_000;
}

/** "+1000" / "-0330" — the offset suffix FoxESS puts on sample times. */
export function offsetSuffix(site: Pick<Site, "tzOffsetMins">): string {
  const m = Math.abs(site.tzOffsetMins);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${site.tzOffsetMins < 0 ? "-" : "+"}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}
