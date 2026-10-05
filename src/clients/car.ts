/**
 * Car API abstraction. The controller talks to the car through exactly one
 * provider per install — Tessie or Teslascope — chosen by which token
 * secret is set. Both proxy Tesla's Fleet API (command signing included);
 * commands are still not confirmations (invariant 4).
 */
import type { Charge } from "../charges";
import { TeslascopeClient } from "./teslascope";
import { TessieClient } from "./tessie";

export interface CarState {
  pluggedIn: boolean;
  chargingState: string; // Tesla charging_state: "Charging" | "Stopped" | "Complete" | "Disconnected" | ...
  socPct: number;
  limitPct: number;
  chargeAmps: number | null; // null = not reported
  latLon: { lat: number; lon: number } | null; // null = unknown → NOT home (invariant 7)
}

export interface CarClient {
  readonly name: string;
  /** Cached car state (must not wake the car). Fails loud on missing fields. */
  getCarState(): Promise<CarState>;
  startCharging(): Promise<void>;
  stopCharging(): Promise<void>;
  setChargingAmps(amps: number): Promise<void>;
  /** Charge history overlapping [fromS, toS] (unix SECONDS). */
  getCharges(fromS: number, toS: number): Promise<Charge[]>;
  /** Raw state payload, for /debug/car shape checks. */
  rawState(): Promise<unknown>;
}

export interface CarEnv {
  TESSIE_TOKEN?: string;
  TESSIE_VIN?: string;
  TESLASCOPE_TOKEN?: string;
  TESLASCOPE_VEHICLE_ID?: string;
}

/** Exactly one provider's token must be set. Ambiguity is a config error,
 *  not a silent pick: the wrong account could command the wrong car. */
export function carFromEnv(env: CarEnv): CarClient {
  const tessie = !!env.TESSIE_TOKEN;
  const teslascope = !!env.TESLASCOPE_TOKEN;
  if (tessie && teslascope) {
    throw new Error("both TESSIE_TOKEN and TESLASCOPE_TOKEN are set; remove one");
  }
  if (tessie) {
    if (!env.TESSIE_VIN) throw new Error("TESSIE_VIN missing");
    return new TessieClient(env.TESSIE_TOKEN!, env.TESSIE_VIN);
  }
  if (teslascope) {
    if (!env.TESLASCOPE_VEHICLE_ID) throw new Error("TESLASCOPE_VEHICLE_ID missing");
    return new TeslascopeClient(env.TESLASCOPE_TOKEN!, env.TESLASCOPE_VEHICLE_ID);
  }
  throw new Error("no car API configured: set TESSIE_TOKEN or TESLASCOPE_TOKEN");
}
