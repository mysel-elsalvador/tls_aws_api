// JSON contract of the web API (v1). The web app has a copy in
// ../page/src/lib/types.ts; keep both in sync.
//
// Console times ("console_time", "alarm_time") have no zone and are sent
// exactly as the console reported them. Everything ending in "_at" is UTC.

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

/** A station is one console read by an agent; one agent may serve several stations. */
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
  tanks: number;
  active_alarms: number;
  last_reading_at: string | null;
}

export interface Tank {
  console_id: string;
  tank: number;
  product_code: string | null;
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

export interface ApiError {
  error: "not_found" | "bad_request" | "organization_inactive" | "internal";
  message?: string;
}
