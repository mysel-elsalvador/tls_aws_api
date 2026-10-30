// JSON contract of the web API (v1). The web app has a copy in
// ../tls_app/src/lib/types.ts; keep both in sync.
//
// Console times ("console_time", "alarm_time") and VOX controller times
// ("sale_time", "opened_at", "closed_at") have no zone and are sent exactly
// as the device reported them. Every other time ending in "_at" is UTC.

export interface Me {
  email: string | null; // null: the Cognito user is not linked to any organization
  orgs: Org[];
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  active: boolean; // false: subscription off, no data
  role: "viewer" | "admin";
  // all: every station of the organization (admins, or all_stations).
  // assigned: only the stations granted to the user, possibly none.
  stations: "all" | "assigned";
}

export type AgentState = "online" | "offline" | "never"; // never: no heartbeat received yet
export type ConsoleState = "online" | "offline" | "unknown";
// offline: the heartbeat says so, or the agent itself is not online.
export type ControllerState = "online" | "offline";

/**
 * A station is one device id of an agent: a Veeder-Root console, a VOX
 * controller, or both (same id in the agent's config). One agent may serve
 * several stations.
 */
export interface StationSummary {
  id: string;
  name: string;
  address: string | null;
  org: { id: string; name: string };
  agent: {
    id: string;
    state: AgentState;
    version: string | null;
    last_heartbeat_at: string | null;
  };
  // The station's console on that agent (id from the agent's config; null:
  // not assigned yet, no data). State from the agent's last heartbeat,
  // "unknown" when the agent is not online.
  console: { id: string | null; state: ConsoleState };
  // Which devices the station has, from the agent's last heartbeat: a
  // console unless the heartbeat lists the id only under "controllers"; a
  // controller when it lists the id under "controllers". Without a
  // heartbeat: a console and no controller.
  has_console: boolean;
  controller: { id: string; state: ControllerState } | null;
  tanks: number;
  active_alarms: number;
  last_reading_at: string | null;
}

export interface Tank {
  console_id: string;
  tank: number;
  product_code: string | null;
  product_label: string | null; // label set on the console for this tank (602), e.g. "DIESEL"; null if unknown
  status: string | null;
  console_time: string;
  collected_at: string | null;
  volume: number | null;
  tc_volume: number | null;
  ullage: number | null;
  height: number | null;
  water: number | null;
  temperature: number | null;
  water_volume: number | null;
  units: { volume?: string; height?: string; temp?: string } | null;
}

/** Active alarm (function 113). Codes are sent as the console reports them. */
export interface Alarm {
  console_id: string;
  category: string | null;
  type: string | null;
  number: number | null;
  alarm_time: string | null;
  first_seen_at: string | null;
}

/**
 * One tank's delivery (function 202/20C), as the console measured it.
 * Times are console times; start/end values are the tank before and after.
 */
export interface Delivery {
  console_id: string;
  tank: number;
  product_code: string | null;
  product_label: string | null; // label set on the console for this tank (602), e.g. "DIESEL"; null if unknown
  start_time: string;
  end_time: string | null;
  start_volume: number | null;
  end_volume: number | null;
  start_height: number | null;
  end_height: number | null;
  start_temp: number | null;
  end_temp: number | null;
  start_water: number | null;
  end_water: number | null;
  units: Tank["units"];
}

export interface StationDetail {
  station: StationSummary;
  tanks: Tank[];
  alarms: Alarm[];
  deliveries: Delivery[]; // latest first, at most 50
}

/** GET /v1/stations/{id}/history: readings in [from, to], per tank. */
export interface History {
  from: string;
  to: string;
  tanks: TankHistory[]; // only tanks with readings in the window
}

export interface TankHistory {
  tank: number;
  units: Tank["units"]; // of the latest reading
  // [collected_at (UTC), height, volume], oldest first. Compact: a week of
  // 5-minute readings is ~2,000 points per tank.
  points: [string, number | null, number | null][];
}

/**
 * One dispatch from the station's VOX controller. Numbers as the VOX sent
 * them (amount 2 decimals, volume and ppu 3; volume in gallons at the
 * stations seen so far).
 */
export interface Sale {
  id: string;
  controller_id: string;
  sale_time: string; // VOX wall clock, no zone (the VOX clock is not reliable)
  collected_at: string;
  pump: number;
  hose: number | null; // from the letter (a = 1); null if unknown
  hose_letter: string | null;
  product_code: string | null;
  product_name: string | null;
  amount: number | null;
  volume: number | null;
  ppu: number | null;
  sale_type: string | null; // "01" = contado; other codes are not verified
}

export type CloseType = "T" | "D" | "M"; // turno, día, mes

/** A closed report of the VOX, for lists. Totals add up by_product. */
export interface CloseSummary {
  id: string;
  controller_id: string;
  type: CloseType;
  opened_at: string; // VOX wall clock, no zone
  closed_at: string; // VOX wall clock, no zone
  collected_at: string;
  dispatch_count: number | null; // sales the VOX lists in the period; null: not counted
  total_amount: number | null;
  total_volume: number | null;
}

/** One sales total of a closed report, as the agent decoded it. */
export interface CloseTotal {
  section: number;
  group: number;
  name?: string; // payment type (section 1)
  pump?: number;
  hose?: string; // letter, on VOXes that report per hose ("1a")
  product?: string;
  ppu?: number;
  amount: number | null;
  volume: number | null;
}

/**
 * A hose's electronic volume totalizer at the start and end of the period.
 * The amount totalizers are stored but not served: their scale is not verified.
 */
export interface Totalizer {
  pump: number | null;
  hose: string;
  product: string;
  start_volume: number | null;
  end_volume: number | null;
}

/** GET /v1/stations/{id}/closes/{close}. */
export interface CloseDetail extends CloseSummary {
  by_payment_type: CloseTotal[];
  by_product: CloseTotal[]; // one row per product and price
  by_pump: CloseTotal[];
  by_pump_cash: CloseTotal[];
  pump_tests: CloseTotal[];
  totalizers: Totalizer[];
}

/** GET /v1/stations/{id}/closes: latest first; pass next as ?before= for the page before. */
export interface ClosePage {
  closes: CloseSummary[];
  next: string | null; // null: no older closes
}

export interface ApiError {
  error: "not_found" | "bad_request" | "organization_inactive" | "internal";
  message?: string;
}
