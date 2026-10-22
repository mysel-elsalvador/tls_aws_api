// Read queries for the web API. Every query starts from the caller's Cognito
// sub through org_users, so a user only ever sees stations of their own
// organizations, only while the organization is active, and only the
// stations they may see (see visible below).
import type { Db } from "./db";
import type { Alarm, ConsoleState, History, Me, Org, StationSummary, Tank, TankHistory } from "./types";

export async function me(db: Db, sub: string): Promise<Me> {
  const rows = await db.query<Org & { email: string }>(
    `SELECT o.org_id::text AS id, o.slug, o.name, o.active, u.role,
       CASE WHEN u.role = 'admin' OR u.all_stations THEN 'all' ELSE 'assigned' END AS stations,
       u.email
     FROM org_users u JOIN organizations o USING (org_id)
     WHERE u.user_sub = $1
     ORDER BY o.name`,
    [sub],
  );
  return {
    email: rows[0]?.email ?? null,
    orgs: rows.map(({ email: _, ...org }) => org),
  };
}

interface SummaryRow {
  id: string;
  name: string;
  address: string | null;
  org_id: string;
  org_name: string;
  org_active: boolean;
  agent_id: string;
  console_id: string | null;
  agent_version: string | null;
  last_heartbeat_at: Date | null;
  console_state: string | null;
  tanks: number;
  active_alarms: number;
  last_reading_at: Date | null;
}

// A station is one console of an agent: (agent_id, console_id). A station
// without a console (registered before 004) matches no data.
// A user sees every station of the organization as an admin or with
// all_stations, otherwise only the stations granted in station_users. A
// station not granted is "not yours" (404), whether or not it exists.
// $2 NULL: every station of the caller's active organizations.
// $2 set: that one station whether or not its organization is active, so
// the caller can tell "inactive" (403) from "not yours" (404).
const sqlSummaries = `
SELECT s.station_id::text AS id, s.name, s.address,
  o.org_id::text AS org_id, o.name AS org_name, o.active AS org_active,
  s.agent_id, s.console_id, a.agent_version, a.last_heartbeat_at,
  a.last_heartbeat->'consoles'->>s.console_id AS console_state,
  coalesce(t.tanks, 0) AS tanks, t.last_reading_at,
  (SELECT count(*)::int FROM active_alarms x
   WHERE x.agent_id = s.agent_id AND x.console_id = s.console_id) AS active_alarms
FROM org_users u
JOIN organizations o ON o.org_id = u.org_id
JOIN stations s ON s.org_id = o.org_id
LEFT JOIN agents a ON a.agent_id = s.agent_id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS tanks, max(r.collected_at) AS last_reading_at
  FROM tank_latest r WHERE r.agent_id = s.agent_id AND r.console_id = s.console_id
) t ON true
WHERE u.user_sub = $1
  AND (u.role = 'admin' OR u.all_stations OR EXISTS (
    SELECT 1 FROM station_users g WHERE g.user_sub = u.user_sub AND g.station_id = s.station_id))
  AND CASE WHEN $2::bigint IS NULL THEN o.active ELSE s.station_id = $2::bigint END
ORDER BY o.name, s.name`;

export interface Options {
  now: Date;
  /** An agent without a heartbeat for this long is offline (it sends one every 60 s). */
  onlineWindowS: number;
}

export async function listStations(db: Db, sub: string, opt: Options): Promise<StationSummary[]> {
  const rows = await db.query<SummaryRow>(sqlSummaries, [sub, null]);
  return rows.map((r) => summary(r, opt));
}

export type StationResult =
  | { kind: "ok"; station: StationSummary; tanks: Tank[]; alarms: Alarm[] }
  | { kind: "not_found" }
  | { kind: "inactive" };

export async function getStation(db: Db, sub: string, id: string, opt: Options): Promise<StationResult> {
  const [row] = await db.query<SummaryRow>(sqlSummaries, [sub, id]);
  if (!row) return { kind: "not_found" };
  if (!row.org_active) return { kind: "inactive" };
  const [tanks, alarms] = await Promise.all([
    db.query<Tank>(
      `SELECT console_id, tank, product_code, status, console_time, collected_at,
         volume, tc_volume, ullage, height, water, temperature, water_volume, units
       FROM tank_latest WHERE agent_id = $1 AND console_id = $2
       ORDER BY tank`,
      [row.agent_id, row.console_id],
    ),
    db.query<Alarm>(
      `SELECT console_id, category, type, number, alarm_time, first_collected_at AS first_seen_at
       FROM active_alarms WHERE agent_id = $1 AND console_id = $2
       ORDER BY alarm_time DESC NULLS LAST, category, type, number`,
      [row.agent_id, row.console_id],
    ),
  ]);
  return { kind: "ok", station: summary(row, opt), tanks, alarms };
}

/** Longest history window the API serves: one week. */
export const MAX_HISTORY_HOURS = 168;

export type HistoryResult =
  | { kind: "ok"; history: History }
  | { kind: "not_found" }
  | { kind: "inactive" };

/**
 * Readings of the station's console collected in the last `hours`, per tank,
 * oldest first. Time is collected_at (agent clock, UTC): console clocks may
 * be skewed. Readings without collected_at are left out.
 */
export async function getHistory(db: Db, sub: string, id: string, hours: number, opt: Options): Promise<HistoryResult> {
  const [row] = await db.query<SummaryRow>(sqlSummaries, [sub, id]);
  if (!row) return { kind: "not_found" };
  if (!row.org_active) return { kind: "inactive" };
  const from = new Date(opt.now.getTime() - hours * 3600_000);
  const [points, latest] = await Promise.all([
    db.query<{ tank: number; collected_at: Date; height: number | null; volume: number | null }>(
      `SELECT tank, collected_at, height, volume
       FROM readings
       WHERE agent_id = $1 AND console_id = $2 AND collected_at >= $3 AND collected_at <= $4
       ORDER BY tank, collected_at`,
      [row.agent_id, row.console_id, from, opt.now],
    ),
    db.query<Pick<Tank, "tank" | "units">>(
      `SELECT tank, units FROM tank_latest WHERE agent_id = $1 AND console_id = $2`,
      [row.agent_id, row.console_id],
    ),
  ]);
  const units = new Map(latest.map((t) => [t.tank, t.units]));
  const tanks = new Map<number, TankHistory>();
  for (const p of points) {
    let t = tanks.get(p.tank);
    if (!t) tanks.set(p.tank, (t = { tank: p.tank, units: units.get(p.tank) ?? null, points: [] }));
    t.points.push([p.collected_at.toISOString(), p.height, p.volume]);
  }
  return {
    kind: "ok",
    history: { from: from.toISOString(), to: opt.now.toISOString(), tanks: [...tanks.values()] },
  };
}

function summary(r: SummaryRow, opt: Options): StationSummary {
  const state = agentState(r.last_heartbeat_at, opt);
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    org: { id: r.org_id, name: r.org_name },
    agent: {
      id: r.agent_id,
      state,
      version: r.agent_version,
      last_heartbeat_at: r.last_heartbeat_at?.toISOString() ?? null,
    },
    console: { id: r.console_id, state: consoleState(r.console_state, state) },
    tanks: r.tanks,
    active_alarms: r.active_alarms,
    last_reading_at: r.last_reading_at?.toISOString() ?? null,
  };
}

export function agentState(lastHeartbeat: Date | null, opt: Options): StationSummary["agent"]["state"] {
  if (!lastHeartbeat) return "never";
  return opt.now.getTime() - lastHeartbeat.getTime() <= opt.onlineWindowS * 1000 ? "online" : "offline";
}

/** What the agent's last heartbeat reported for the console, or "unknown" when the agent itself is not online. */
export function consoleState(reported: string | null, agent: StationSummary["agent"]["state"]): ConsoleState {
  return agent === "online" && (reported === "online" || reported === "offline") ? reported : "unknown";
}
