// Admin Lambda: manages organizations, stations and users. A station is one
// console of an agent (agent_id + console_id). Not behind the
// API; operators invoke it directly (make admin / scripts/add-user.sh), so
// whoever may call lambda:InvokeFunction on it is an administrator.
// DB user hub_tenant: writes only organizations, stations and org_users.
import { type Db, log, poolFromEnv, wrap } from "./db";

export type Request =
  | { action: "list" }
  | { action: "create_org"; slug: string; name: string; active?: boolean }
  | { action: "set_org_active"; org: string; active: boolean }
  | { action: "add_station"; org: string; agent_id: string; console_id: string; name: string; address?: string }
  | { action: "set_station_console"; id: string; console_id: string }
  | { action: "remove_station"; agent_id: string; console_id: string }
  | { action: "add_user"; org: string; sub: string; email: string; role?: "viewer" | "admin"; all_stations?: boolean }
  | { action: "set_user_scope"; org: string; email: string; all_stations: boolean }
  | { action: "grant_station"; org: string; email: string; station: string }
  | { action: "revoke_station"; org: string; email: string; station: string }
  | { action: "remove_user"; org: string; sub: string };

export type Response = { ok: true; [k: string]: unknown } | { ok: false; error: string };

let db: Db | undefined;

export async function handler(req: Request): Promise<Response> {
  db ??= wrap(poolFromEnv());
  const res = await run(db, req);
  // Logged without the user's email.
  log(res.ok ? "info" : "warn", "admin", { action: req?.action, ok: res.ok, error: res.ok ? undefined : res.error });
  return res;
}

export async function run(db: Db, req: Request): Promise<Response> {
  try {
    switch (req?.action) {
      case "list": {
        const [orgs, stations, consoles, users] = await Promise.all([
          db.query(`SELECT org_id::text AS id, slug, name, active, created_at FROM organizations ORDER BY slug`),
          db.query(
            `SELECT s.station_id::text AS id, o.slug AS org, s.agent_id, s.console_id, s.name, s.address
             FROM stations s JOIN organizations o USING (org_id) ORDER BY o.slug, s.name`,
          ),
          // Every console the agents report, with its station (null: not registered yet).
          db.query(
            `SELECT a.agent_id, c.console_id, c.state, s.station_id::text AS station_id, s.name AS station
             FROM agents a
             CROSS JOIN LATERAL jsonb_each_text(
               CASE WHEN jsonb_typeof(a.last_heartbeat->'consoles') = 'object' THEN a.last_heartbeat->'consoles' ELSE '{}' END
             ) AS c(console_id, state)
             LEFT JOIN stations s ON s.agent_id = a.agent_id AND s.console_id = c.console_id
             ORDER BY a.agent_id, c.console_id`,
          ),
          db.query(
            `SELECT o.slug AS org, u.user_sub AS sub, u.email, u.role, u.all_stations,
               coalesce((SELECT array_agg(g.station_id::text ORDER BY g.station_id) FROM station_users g
                         WHERE g.user_sub = u.user_sub AND g.org_id = u.org_id), '{}') AS stations
             FROM org_users u JOIN organizations o USING (org_id) ORDER BY o.slug, u.email`,
          ),
        ]);
        return { ok: true, orgs, stations, consoles, users };
      }
      case "create_org": {
        need(req, "slug", "name");
        const [org] = await db.query(
          `INSERT INTO organizations (slug, name, active) VALUES ($1, $2, $3)
           RETURNING org_id::text AS id, slug, name, active`,
          [req.slug, req.name, req.active ?? false],
        );
        return { ok: true, org };
      }
      case "set_org_active": {
        need(req, "org");
        if (typeof req.active !== "boolean") throw new Bad("active must be true or false");
        const [org] = await db.query(
          `UPDATE organizations SET active = $2, updated_at = now() WHERE slug = $1
           RETURNING org_id::text AS id, slug, name, active`,
          [req.org, req.active],
        );
        return org ? { ok: true, org } : { ok: false, error: `no organization ${req.org}` };
      }
      case "add_station": {
        need(req, "org", "agent_id", "console_id", "name");
        const [station] = await db.query(
          `INSERT INTO stations (org_id, agent_id, console_id, name, address)
           SELECT org_id, $2, $3, $4, $5 FROM organizations WHERE slug = $1
           RETURNING station_id::text AS id, agent_id, console_id, name, address`,
          [req.org, req.agent_id, req.console_id, req.name, req.address ?? null],
        );
        return station ? { ok: true, station } : { ok: false, error: `no organization ${req.org}` };
      }
      case "set_station_console": {
        need(req, "id", "console_id");
        stationId(req.id);
        const [station] = await db.query(
          `UPDATE stations SET console_id = $2 WHERE station_id = $1
           RETURNING station_id::text AS id, agent_id, console_id, name, address`,
          [req.id, req.console_id],
        );
        return station ? { ok: true, station } : { ok: false, error: `no station ${req.id}` };
      }
      case "remove_station": {
        need(req, "agent_id", "console_id");
        const rows = await db.query(
          `DELETE FROM stations WHERE agent_id = $1 AND console_id = $2 RETURNING station_id`,
          [req.agent_id, req.console_id],
        );
        return rows.length
          ? { ok: true }
          : { ok: false, error: `no station for console ${req.console_id} of agent ${req.agent_id}` };
      }
      case "add_user": {
        need(req, "org", "sub", "email");
        const role = req.role ?? "viewer";
        if (req.all_stations !== undefined && typeof req.all_stations !== "boolean") {
          throw new Bad("all_stations must be true or false");
        }
        // A new user sees no station until granted some or all; re-adding
        // keeps the current scope unless all_stations is given.
        const [user] = await db.query(
          `INSERT INTO org_users (org_id, user_sub, email, role, all_stations)
           SELECT org_id, $2, lower($3), $4, coalesce($5, false) FROM organizations WHERE slug = $1
           ON CONFLICT (user_sub, org_id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role,
             all_stations = coalesce($5, org_users.all_stations)
           RETURNING user_sub AS sub, email, role, all_stations`,
          [req.org, req.sub, req.email, role, req.all_stations ?? null],
        );
        return user ? { ok: true, user } : { ok: false, error: `no organization ${req.org}` };
      }
      case "set_user_scope": {
        need(req, "org", "email");
        if (typeof req.all_stations !== "boolean") throw new Bad("all_stations must be true or false");
        const [user] = await db.query(
          `UPDATE org_users u SET all_stations = $3 FROM organizations o
           WHERE u.org_id = o.org_id AND o.slug = $1 AND u.email = lower($2)
           RETURNING u.user_sub AS sub, u.email, u.role, u.all_stations`,
          [req.org, req.email, req.all_stations],
        );
        return user ? { ok: true, user } : { ok: false, error: "no such user in that organization" };
      }
      case "grant_station": {
        need(req, "org", "email", "station");
        stationId(req.station);
        // The station must belong to the user's organization (also enforced by the foreign keys).
        const rows = await db.query(
          `INSERT INTO station_users (org_id, user_sub, station_id)
           SELECT u.org_id, u.user_sub, s.station_id
           FROM org_users u
           JOIN organizations o ON o.org_id = u.org_id
           JOIN stations s ON s.org_id = u.org_id AND s.station_id = $3::bigint
           WHERE o.slug = $1 AND u.email = lower($2)
           ON CONFLICT DO NOTHING
           RETURNING station_id`,
          [req.org, req.email, req.station],
        );
        if (rows.length) return { ok: true };
        const [exists] = await db.query(
          `SELECT 1 FROM station_users g JOIN org_users u USING (user_sub, org_id) JOIN organizations o USING (org_id)
           WHERE o.slug = $1 AND u.email = lower($2) AND g.station_id = $3::bigint`,
          [req.org, req.email, req.station],
        );
        return exists
          ? { ok: true, already: true }
          : { ok: false, error: "no such user, or no such station, in that organization" };
      }
      case "revoke_station": {
        need(req, "org", "email", "station");
        stationId(req.station);
        const rows = await db.query(
          `DELETE FROM station_users g USING org_users u, organizations o
           WHERE g.user_sub = u.user_sub AND g.org_id = u.org_id AND u.org_id = o.org_id
             AND o.slug = $1 AND u.email = lower($2) AND g.station_id = $3::bigint
           RETURNING g.station_id`,
          [req.org, req.email, req.station],
        );
        return rows.length ? { ok: true } : { ok: false, error: "that user has no grant for that station" };
      }
      case "remove_user": {
        need(req, "org", "sub");
        const rows = await db.query(
          `DELETE FROM org_users u USING organizations o
           WHERE u.org_id = o.org_id AND o.slug = $1 AND u.user_sub = $2 RETURNING u.user_sub`,
          [req.org, req.sub],
        );
        return rows.length ? { ok: true } : { ok: false, error: "no such user in that organization" };
      }
      default:
        return { ok: false, error: `unknown action ${String((req as { action?: unknown })?.action)}` };
    }
  } catch (err) {
    // Bad input and constraint violations (duplicate slug/console, bad
    // slug or role) are the operator's to fix; report them as they are.
    if (err instanceof Bad) return { ok: false, error: err.message };
    const pgErr = err as { code?: string; detail?: string; message?: string };
    if (pgErr.code?.startsWith("23")) return { ok: false, error: pgErr.detail ?? pgErr.message ?? "constraint" };
    throw err;
  }
}

class Bad extends Error {}

function stationId(id: string) {
  if (!/^[1-9][0-9]{0,17}$/.test(id)) throw new Bad("station id must be a number (as a string)");
}

function need<T extends object>(req: T, ...keys: (keyof T & string)[]) {
  for (const k of keys) {
    const v = req[k];
    if (typeof v !== "string" || v.trim() === "") throw new Bad(`${k} is required`);
  }
}
