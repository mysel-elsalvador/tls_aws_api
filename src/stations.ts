// Read queries for the web API. Every query starts from the caller's Cognito
// sub through org_users, so a user only ever sees stations of their own
// organizations, only while the organization is active, and only the
// stations they may see (see visible below).
import type { Db } from "./db";
import type {
  Alarm,
  CloseDetail,
  ClosePage,
  CloseSummary,
  CloseType,
  ConsoleState,
  ControllerState,
  Delivery,
  History,
  Me,
  Org,
  Sale,
  StationSummary,
  Tank,
  TankHistory,
  Totalizer,
} from "./types";

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
  // Whether the last heartbeat lists the station's id under "consoles" /
  // "controllers" (false without a heartbeat).
  console_listed: boolean;
  controller_listed: boolean;
  controller_state: string | null;
  tanks: number;
  active_alarms: number;
  last_reading_at: Date | null;
}

// A station is one device id of an agent: (agent_id, console_id), where
// console_id names the console and/or the VOX controller with that id. A
// station without one (registered before 004) matches no data.
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
  coalesce(jsonb_typeof(a.last_heartbeat->'consoles') = 'object'
    AND a.last_heartbeat->'consoles' ? s.console_id, false) AS console_listed,
  coalesce(jsonb_typeof(a.last_heartbeat->'controllers') = 'object'
    AND a.last_heartbeat->'controllers' ? s.console_id, false) AS controller_listed,
  a.last_heartbeat->'controllers'->>s.console_id AS controller_state,
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
  | { kind: "ok"; station: StationSummary; tanks: Tank[]; alarms: Alarm[]; deliveries: Delivery[] }
  | { kind: "not_found" }
  | { kind: "inactive" };

export async function getStation(db: Db, sub: string, id: string, opt: Options): Promise<StationResult> {
  const [row] = await db.query<SummaryRow>(sqlSummaries, [sub, id]);
  if (!row) return { kind: "not_found" };
  if (!row.org_active) return { kind: "inactive" };
  const [tanks, alarms, deliveries] = await Promise.all([
    db.query<Tank>(
      `SELECT r.console_id, r.tank, r.product_code, l.label AS product_label, r.status, r.console_time, r.collected_at,
         r.volume, r.tc_volume, r.ullage, r.height, r.water, r.temperature, r.water_volume, r.units
       FROM tank_latest r
       LEFT JOIN tank_labels l ON l.agent_id = r.agent_id AND l.console_id = r.console_id AND l.tank = r.tank
       WHERE r.agent_id = $1 AND r.console_id = $2
       ORDER BY r.tank`,
      [row.agent_id, row.console_id],
    ),
    db.query<Alarm>(
      `SELECT console_id, category, type, number, alarm_time, first_collected_at AS first_seen_at
       FROM active_alarms WHERE agent_id = $1 AND console_id = $2
       ORDER BY alarm_time DESC NULLS LAST, category, type, number`,
      [row.agent_id, row.console_id],
    ),
    db.query<Delivery>(
      `SELECT d.console_id, d.tank, d.product_code, l.label AS product_label, d.start_time, d.end_time,
         d.start_volume, d.end_volume, d.start_height, d.end_height,
         d.start_temp, d.end_temp, d.start_water, d.end_water, d.units
       FROM deliveries d
       LEFT JOIN tank_labels l ON l.agent_id = d.agent_id AND l.console_id = d.console_id AND l.tank = d.tank
       WHERE d.agent_id = $1 AND d.console_id = $2
       ORDER BY d.start_time DESC, d.tank
       LIMIT 50`,
      [row.agent_id, row.console_id],
    ),
  ]);
  return { kind: "ok", station: summary(row, opt), tanks, alarms, deliveries };
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

// ---- VOX controller: sales and closed reports. The station's controller is
// the one with the station's id (console_id) on the same agent.

/** Most sales the API returns at once (also the default). */
export const MAX_SALES = 50;
/** Closes per page. */
export const CLOSES_PAGE = 20;

type Scoped<T> = { kind: "ok"; value: T } | { kind: "not_found" } | { kind: "inactive" };

/** The caller's station `id`, or why it is not available. */
async function station(db: Db, sub: string, id: string): Promise<Scoped<SummaryRow>> {
  const [row] = await db.query<SummaryRow>(sqlSummaries, [sub, id]);
  if (!row) return { kind: "not_found" };
  if (!row.org_active) return { kind: "inactive" };
  return { kind: "ok", value: row };
}

// numeric columns come back from pg as strings: cast them for JSON numbers.
// A bare "id" in ORDER BY is the text output column ("10" < "9"): qualify it.
const saleCols = `id::text, controller_id, sale_time, collected_at, pump, hose, hose_letter,
  product_code, product_name, amount::float8 AS amount, volume::float8 AS volume, ppu::float8 AS ppu, sale_type`;
const closeCols = `id::text, controller_id, type, opened_at, closed_at, collected_at, dispatch_count,
  total_amount::float8 AS total_amount, total_volume::float8 AS total_volume`;

/** The station controller's latest `limit` sales by VOX time, latest first. */
export async function getSales(db: Db, sub: string, id: string, limit: number): Promise<Scoped<Sale[]>> {
  const s = await station(db, sub, id);
  if (s.kind !== "ok") return s;
  const sales = await db.query<Sale>(
    `SELECT ${saleCols} FROM sales
     WHERE agent_id = $1 AND controller_id = $2
     ORDER BY sale_time DESC, sales.id DESC
     LIMIT $3`,
    [s.value.agent_id, s.value.console_id, limit],
  );
  return { kind: "ok", value: sales };
}

/** Keyset cursor of a close: "closed_at_id", e.g. "2026-10-26T17:33:47_12". */
export interface CloseCursor {
  closed_at: string;
  id: string;
}

export const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)_([1-9][0-9]{0,17})$/;

export function parseCursor(s: string): CloseCursor | null {
  const m = CURSOR.exec(s);
  return m ? { closed_at: m[1]!, id: m[2]! } : null;
}

/**
 * One page of the controller's closes of `type`, latest closed_at first,
 * strictly before `before` when given. Ties on closed_at go by id.
 */
export async function getCloses(
  db: Db,
  sub: string,
  id: string,
  type: CloseType,
  before: CloseCursor | null,
): Promise<Scoped<ClosePage>> {
  const s = await station(db, sub, id);
  if (s.kind !== "ok") return s;
  // One more than a page, to know whether there is a next one.
  const rows = await db.query<CloseSummary>(
    `SELECT ${closeCols} FROM closes
     WHERE agent_id = $1 AND controller_id = $2 AND type = $3
       AND ($4::timestamp IS NULL OR (closed_at, id) < ($4::timestamp, $5::bigint))
     ORDER BY closed_at DESC, closes.id DESC
     LIMIT $6`,
    [s.value.agent_id, s.value.console_id, type, before?.closed_at ?? null, before?.id ?? null, CLOSES_PAGE + 1],
  );
  const closes = rows.slice(0, CLOSES_PAGE);
  const last = closes[closes.length - 1];
  return {
    kind: "ok",
    value: { closes, next: rows.length > CLOSES_PAGE && last ? `${last.closed_at}_${last.id}` : null },
  };
}

/** One close of the station's controller, with its sections. Totalizer amounts are left out. */
export async function getClose(db: Db, sub: string, id: string, closeId: string): Promise<Scoped<CloseDetail>> {
  const s = await station(db, sub, id);
  if (s.kind !== "ok") return s;
  const [row] = await db.query<CloseDetail & { totalizers: (Totalizer & Record<string, unknown>)[] }>(
    `SELECT ${closeCols}, by_payment_type, by_product, by_pump, by_pump_cash, pump_tests, totalizers
     FROM closes WHERE id = $3 AND agent_id = $1 AND controller_id = $2`,
    [s.value.agent_id, s.value.console_id, closeId],
  );
  if (!row) return { kind: "not_found" };
  const totalizers = row.totalizers.map(
    (t): Totalizer => ({
      pump: t.pump ?? null,
      hose: t.hose,
      product: t.product,
      start_volume: t.start_volume ?? null,
      end_volume: t.end_volume ?? null,
    }),
  );
  return { kind: "ok", value: { ...row, totalizers } };
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
    // Only a heartbeat that lists the id as a controller and not as a
    // console says "no console"; anything else keeps the console.
    has_console: !(r.controller_listed && !r.console_listed),
    controller:
      r.controller_listed && r.console_id !== null
        ? { id: r.console_id, state: controllerState(r.controller_state, state) }
        : null,
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

/** Online only while the agent is online and its last heartbeat says the controller is. */
export function controllerState(reported: string | null, agent: StationSummary["agent"]["state"]): ControllerState {
  return agent === "online" && reported === "online" ? "online" : "offline";
}
