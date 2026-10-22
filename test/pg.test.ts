// Runs against a real PostgreSQL with the schema from ../aws/migrations.
// Started by scripts/test-pg.sh (make test-pg); skipped otherwise.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/admin";
import { type Db, wrap } from "../src/db";
import { getHistory, getStation, listStations, me } from "../src/stations";

const MIGRATIONS = new URL("../../aws/migrations/", import.meta.url);
const now = new Date();
const opt = { now, onlineWindowS: 180 };
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

// A pool that acts as one of the application roles (PG* env = superuser).
function as(role: string): pg.Pool {
  return new pg.Pool({ max: 1, options: `-c role=${role}` });
}

describe.skipIf(!process.env.HUB_TEST_PG)("postgres", () => {
  const owner = new pg.Pool({ max: 1 });
  const webPool = as("hub_web");
  const tenantPool = as("hub_tenant");
  const appPool = as("hub_app");
  const web: Db = wrap(webPool);
  const tenant: Db = wrap(tenantPool);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await owner.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await owner.query(readFileSync(new URL(f, MIGRATIONS), "utf8"));
    }

    // Tenancy through the admin Lambda code, as hub_tenant.
    const ok = async (req: Parameters<typeof run>[1]) => {
      const res = await run(tenant, req);
      if (!res.ok) throw new Error(res.error);
      return res as Record<string, any>;
    };
    await ok({ action: "create_org", slug: "puma", name: "Puma", active: true });
    await ok({ action: "create_org", slug: "texaco", name: "Texaco" }); // inactive by default
    // Agent station-a reads two consoles: two stations.
    const st = (org: string, agent_id: string, console_id: string, name: string) =>
      ok({ action: "add_station", org, agent_id, console_id, name }).then((r) => r.station.id as string);
    ids.a = await st("puma", "station-a", "tls2-1", "Escalonia");
    ids.a2 = await st("puma", "station-a", "tls2-2", "Arce");
    ids.b = await st("puma", "station-b", "tls2-1", "Bulevar");
    ids.c = await st("texaco", "station-c", "tls2-1", "Centro");
    await ok({ action: "add_user", org: "puma", sub: "u-puma", email: "Ana@Puma.example", all_stations: true });
    await ok({ action: "add_user", org: "texaco", sub: "u-texaco", email: "t@texaco.example", all_stations: true });
    // Admin of puma: every station without all_stations.
    await ok({ action: "add_user", org: "puma", sub: "u-both", email: "b@example.com", role: "admin" });
    await ok({ action: "add_user", org: "texaco", sub: "u-both", email: "b@example.com", all_stations: true });
    // Viewers of puma: one with two grants, one with none (the default).
    await ok({ action: "add_user", org: "puma", sub: "u-few", email: "few@puma.example" });
    await ok({ action: "add_user", org: "puma", sub: "u-none", email: "none@puma.example" });
    await ok({ action: "grant_station", org: "puma", email: "Few@Puma.example", station: ids.a2! });
    await ok({ action: "grant_station", org: "puma", email: "few@puma.example", station: ids.b! });

    // Data as the processor would store it.
    await owner.query(
      `INSERT INTO agents (agent_id, first_seen, last_seen, last_heartbeat, last_heartbeat_at, agent_version) VALUES
         ('station-a', $1, $2, '{"consoles":{"tls2-1":"online","tls2-2":"offline","tls2-9":"online"}}', $2, '1.0'),
         ('station-b', $1, $1, '{"consoles":{"tls2-1":"online"}}', $1, '0.9'),
         ('station-c', $1, $2, '{"consoles":{"tls2-1":"offline"}}', $2, '1.0')`,
      [ago(3600), ago(60)],
    );
    await owner.query(
      `INSERT INTO readings (agent_id, console_id, tank, console_time, collected_at, volume, ullage, units, batch_id) VALUES
         ('station-a', 'tls2-1', 2, '2026-10-23 13:24', $1, 5000, 5170, '{"volume":"gal"}', 'b1'),
         ('station-a', 'tls2-1', 2, '2026-10-23 13:29', $2, 4997.5, 5172.5, '{"volume":"gal"}', 'b2'),
         ('station-a', 'tls2-1', 3, '2026-10-23 13:29', $2, 100, 900, NULL, 'b2'),
         ('station-a', 'tls2-2', 1, '2026-10-23 13:29', $2, 700, 300, NULL, 'b2'),
         ('station-c', 'tls2-1', 1, '2026-10-23 13:29', $2, 1, 2, NULL, 'b3')`,
      [ago(600), ago(60)],
    );
    // Snapshot at 13:29 has two alarms; one alarm was only in the older snapshot.
    await owner.query(
      `INSERT INTO alarms (agent_id, console_id, source, record, category, type, number, state, alarm_time,
                           first_console_time, last_console_time, first_collected_at, batch_id) VALUES
         ('station-a', 'tls2-1', '113', 'r1', '02', '05', 2, 'active', '2026-10-22 14:38', '2026-10-23 13:24', '2026-10-23 13:29', $1, 'b1'),
         ('station-a', 'tls2-1', '113', 'r2', '64', '01', 1, 'active', '2026-10-19 10:37', '2026-10-23 13:29', '2026-10-23 13:29', $1, 'b2'),
         ('station-a', 'tls2-1', '113', 'r3', '02', '03', 2, 'active', '2026-10-18 09:00', '2026-10-23 13:24', '2026-10-23 13:24', $1, 'b1'),
         ('station-a', 'tls2-1', '111', 'h1', '02', '05', 2, 'occurred', '2026-10-22 14:38', '2026-10-23 13:29', '2026-10-23 13:29', $1, 'b2'),
         ('station-a', 'tls2-2', '113', 'r1', '02', '01', 1, 'active', '2026-10-20 08:00', '2026-10-23 13:29', '2026-10-23 13:29', $1, 'b2')`,
      [ago(600)],
    );
    await owner.query(
      `INSERT INTO events (agent_id, console_id, kind, console_time, collected_at, item_hash, batch_id) VALUES
         ('station-a', 'tls2-1', 'alarm_snapshot', '2026-10-23 13:24', $1, 'e1', 'b1'),
         ('station-a', 'tls2-1', 'alarm_snapshot', '2026-10-23 13:29', $2, 'e2', 'b2'),
         ('station-a', 'tls2-2', 'alarm_snapshot', '2026-10-23 13:29', $2, 'e3', 'b2')`,
      [ago(600), ago(60)],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), webPool.end(), tenantPool.end(), appPool.end()]);
  });

  it("me lists the caller's organizations", async () => {
    expect(await me(web, "u-both")).toMatchObject({
      email: "b@example.com",
      orgs: [
        { slug: "puma", active: true, role: "admin", stations: "all" },
        { slug: "texaco", active: false, role: "viewer", stations: "all" },
      ],
    });
    expect((await me(web, "u-none")).orgs).toMatchObject([{ slug: "puma", stations: "assigned" }]);
    expect((await me(web, "u-puma")).email).toBe("ana@puma.example");
    expect(await me(web, "nobody")).toEqual({ email: null, orgs: [] });
  });

  it("lists only stations of the caller's active organizations", async () => {
    const list = await listStations(web, "u-both", opt);
    expect(list.map((s) => s.name)).toEqual(["Arce", "Bulevar", "Escalonia"]);
    expect(await listStations(web, "u-texaco", opt)).toEqual([]);
    expect(await listStations(web, "nobody", opt)).toEqual([]);
  });

  it("summarizes status, tanks and active alarms", async () => {
    const [a2, b, a] = await listStations(web, "u-puma", opt);
    expect(a).toMatchObject({
      name: "Escalonia",
      agent: { id: "station-a", state: "online", version: "1.0" },
      console: { id: "tls2-1", state: "online" },
      tanks: 2,
      active_alarms: 2,
    });
    expect(a!.last_reading_at).toBe(ago(60));
    expect(a2).toMatchObject({
      name: "Arce",
      agent: { id: "station-a", state: "online" },
      console: { id: "tls2-2", state: "offline" },
      tanks: 1,
      active_alarms: 1,
    });
    expect(b).toMatchObject({ agent: { state: "offline" }, console: { state: "unknown" }, tanks: 0, active_alarms: 0 });
  });

  it("station detail: latest reading per tank, alarms of the latest snapshot", async () => {
    const r = await getStation(web, "u-puma", ids.a!, opt);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.tanks.map((t) => [t.tank, t.console_time, t.volume])).toEqual([
      [2, "2026-10-23T13:29:00", 4997.5],
      [3, "2026-10-23T13:29:00", 100],
    ]);
    expect(r.tanks[0]!.units).toEqual({ volume: "gal" });
    expect(r.alarms.map((x) => [x.category, x.type, x.alarm_time])).toEqual([
      ["02", "05", "2026-10-22T14:38:00"],
      ["64", "01", "2026-10-19T10:37:00"],
    ]);
    const r2 = await getStation(web, "u-puma", ids.a2!, opt);
    if (r2.kind !== "ok") throw new Error(r2.kind);
    expect(r2.tanks.map((t) => [t.console_id, t.tank, t.volume])).toEqual([["tls2-2", 1, 700]]);
    expect(r2.alarms.map((x) => [x.console_id, x.type])).toEqual([["tls2-2", "01"]]);
  });

  it("a station without a console (registered before 004) shows no data until assigned", async () => {
    const { rows } = await owner.query(
      `INSERT INTO stations (org_id, agent_id, name)
       SELECT org_id, 'station-a', 'Legacy' FROM organizations WHERE slug = 'puma' RETURNING station_id::text AS id`,
    ).catch(() => ({ rows: [] as { id: string }[] }));
    // 004's check binds new rows: a station needs a console.
    expect(rows).toEqual([]);
    // Rows that predate 004 can have none: simulate one.
    await owner.query("ALTER TABLE stations DROP CONSTRAINT stations_console_required");
    const [{ id }] = (
      await owner.query(
        `INSERT INTO stations (org_id, agent_id, name)
         SELECT org_id, 'station-a', 'Legacy' FROM organizations WHERE slug = 'puma' RETURNING station_id::text AS id`,
      )
    ).rows;
    await owner.query(
      `ALTER TABLE stations ADD CONSTRAINT stations_console_required
         CHECK (console_id IS NOT NULL AND console_id <> '') NOT VALID`,
    );
    let r = await getStation(web, "u-puma", id, opt);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.station).toMatchObject({ console: { id: null, state: "unknown" }, tanks: 0, active_alarms: 0 });
    expect([r.tanks, r.alarms]).toEqual([[], []]);
    // Taken: console tls2-1 already has a station.
    expect(await run(tenant, { action: "set_station_console", id, console_id: "tls2-1" })).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "set_station_console", id, console_id: "tls2-9" })).toMatchObject({ ok: true });
    r = await getStation(web, "u-puma", id, opt);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.station.console).toEqual({ id: "tls2-9", state: "online" });
    expect(await run(tenant, { action: "remove_station", agent_id: "station-a", console_id: "tls2-9" })).toMatchObject({ ok: true });
  });

  it("station detail: other tenants get not_found, inactive get inactive", async () => {
    expect((await getStation(web, "u-texaco", ids.a!, opt)).kind).toBe("not_found");
    expect((await getStation(web, "u-puma", ids.c!, opt)).kind).toBe("not_found");
    expect((await getStation(web, "u-texaco", ids.c!, opt)).kind).toBe("inactive");
    expect((await getStation(web, "u-both", ids.c!, opt)).kind).toBe("inactive");
    expect((await getStation(web, "u-puma", "999999", opt)).kind).toBe("not_found");
  });

  it("history: readings in the window by agent time, per tank, oldest first", async () => {
    // Older console times, so tank_latest (by console_time) is unchanged.
    await owner.query(
      `INSERT INTO readings (agent_id, console_id, tank, console_time, collected_at, height, volume, batch_id) VALUES
         ('station-a', 'tls2-1', 2, '2026-10-21 10:00', $1, 60.5, 5400, 'h1'),
         ('station-a', 'tls2-1', 2, '2026-10-20 10:00', $2, 61, 5500, 'h1'),
         ('station-a', 'tls2-1', 2, '2026-10-19 10:00', NULL, 62, 5600, 'h1')`,
      [ago(30 * 3600), ago(100 * 3600)],
    );
    const h = async (hours: number) => {
      const r = await getHistory(web, "u-puma", ids.a!, hours, opt);
      if (r.kind !== "ok") throw new Error(r.kind);
      return r.history;
    };
    const day = await h(24);
    expect(day.to).toBe(now.toISOString());
    expect(day.tanks.map((t) => [t.tank, t.units, t.points.map((p) => p[0])])).toEqual([
      [2, { volume: "gal" }, [ago(600), ago(60)]],
      [3, null, [ago(60)]],
    ]);
    expect(day.tanks[0]!.points[1]).toEqual([ago(60), null, 4997.5]);
    expect((await h(48)).tanks[0]!.points.map((p) => p[1])).toEqual([60.5, null, null]);
    expect((await h(168)).tanks[0]!.points.map((p) => p[2])).toEqual([5500, 5400, 5000, 4997.5]);

    // Other console of the same agent, other tenants, inactive organizations.
    const a2 = await getHistory(web, "u-puma", ids.a2!, 24, opt);
    expect(a2.kind === "ok" && a2.history.tanks.map((t) => t.tank)).toEqual([1]);
    expect((await getHistory(web, "u-texaco", ids.a!, 24, opt)).kind).toBe("not_found");
    expect((await getHistory(web, "u-none", ids.a!, 24, opt)).kind).toBe("not_found");
    expect((await getHistory(web, "u-texaco", ids.c!, 24, opt)).kind).toBe("inactive");
  });

  it("activating the organization shows its data", async () => {
    expect(await run(tenant, { action: "set_org_active", org: "texaco", active: true })).toMatchObject({ ok: true });
    expect((await listStations(web, "u-texaco", opt)).map((s) => s.name)).toEqual(["Centro"]);
    await run(tenant, { action: "set_org_active", org: "texaco", active: false });
    expect(await listStations(web, "u-texaco", opt)).toEqual([]);
  });

  it("admin reports bad input and constraint violations", async () => {
    expect(await run(tenant, { action: "create_org", slug: "Bad Slug", name: "x" })).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "create_org", slug: "puma", name: "again" })).toMatchObject({ ok: false });
    expect(
      await run(tenant, { action: "add_station", org: "puma", agent_id: "station-c", console_id: "tls2-1", name: "dup" }),
    ).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "add_station", org: "nope", agent_id: "x", console_id: "x", name: "x" })).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "add_station", org: "puma", agent_id: "x", name: "x" } as never)).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "set_station_console", id: "1", console_id: "" })).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "remove_station", agent_id: "station-a", console_id: "nope" })).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "add_user", org: "puma", sub: "", email: "x" } as never)).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "set_org_active", org: "puma" } as never)).toMatchObject({ ok: false });
    expect(await run(tenant, { action: "nope" } as never)).toMatchObject({ ok: false });
    const list = await run(tenant, { action: "list" });
    expect(list).toMatchObject({ ok: true, orgs: [{ slug: "puma" }, { slug: "texaco" }] });
    // Every reported console, with its station or null.
    expect((list as Record<string, any>).consoles.filter((c: any) => c.agent_id === "station-a")).toEqual([
      { agent_id: "station-a", console_id: "tls2-1", state: "online", station_id: ids.a, station: "Escalonia" },
      { agent_id: "station-a", console_id: "tls2-2", state: "offline", station_id: ids.a2, station: "Arce" },
      { agent_id: "station-a", console_id: "tls2-9", state: "online", station_id: null, station: null },
    ]);
  });

  it("viewers see only granted stations; admins and all_stations see all", async () => {
    const names = async (sub: string) => (await listStations(web, sub, opt)).map((s) => s.name);
    expect(await names("u-few")).toEqual(["Arce", "Bulevar"]);
    expect(await names("u-none")).toEqual([]);
    expect(await names("u-both")).toEqual(["Arce", "Bulevar", "Escalonia"]);
    // A station not granted is not_found, like another organization's.
    expect((await getStation(web, "u-few", ids.a!, opt)).kind).toBe("not_found");
    expect((await getStation(web, "u-few", ids.b!, opt)).kind).toBe("ok");
    expect((await getStation(web, "u-none", ids.b!, opt)).kind).toBe("not_found");
  });

  it("admin changes scope and grants by email", async () => {
    const names = async (sub: string) => (await listStations(web, sub, opt)).map((s) => s.name);
    const grant = { org: "puma", email: "none@puma.example", station: ids.a! };
    expect(await run(tenant, { action: "grant_station", ...grant })).toEqual({ ok: true });
    expect(await run(tenant, { action: "grant_station", ...grant })).toEqual({ ok: true, already: true });
    expect(await names("u-none")).toEqual(["Escalonia"]);
    expect(await run(tenant, { action: "set_user_scope", org: "puma", email: "none@puma.example", all_stations: true }))
      .toMatchObject({ ok: true, user: { all_stations: true } });
    expect(await names("u-none")).toEqual(["Arce", "Bulevar", "Escalonia"]);
    // Re-adding without all_stations keeps the scope.
    await run(tenant, { action: "add_user", org: "puma", sub: "u-none", email: "none@puma.example" });
    expect(await names("u-none")).toHaveLength(3);
    await run(tenant, { action: "set_user_scope", org: "puma", email: "none@puma.example", all_stations: false });
    expect(await run(tenant, { action: "revoke_station", ...grant })).toEqual({ ok: true });
    expect(await run(tenant, { action: "revoke_station", ...grant })).toMatchObject({ ok: false });
    expect(await names("u-none")).toEqual([]);

    // Not across organizations, not unknown users or stations, not bad input.
    expect(await run(tenant, { action: "grant_station", org: "puma", email: "few@puma.example", station: ids.c! }))
      .toMatchObject({ ok: false });
    await expect(tenantPool.query(
      `INSERT INTO station_users (org_id, user_sub, station_id)
       SELECT o.org_id, 'u-few', $1 FROM organizations o WHERE o.slug = 'puma'`, [ids.c],
    )).rejects.toThrow(/foreign key/);
    expect(await run(tenant, { action: "grant_station", org: "puma", email: "nobody@x", station: ids.a! }))
      .toMatchObject({ ok: false });
    expect(await run(tenant, { action: "grant_station", org: "puma", email: "few@puma.example", station: "999999" }))
      .toMatchObject({ ok: false });
    expect(await run(tenant, { action: "grant_station", org: "puma", email: "few@puma.example", station: "x" }))
      .toMatchObject({ ok: false });
    expect(await run(tenant, { action: "set_user_scope", org: "puma", email: "few@puma.example" } as never))
      .toMatchObject({ ok: false });
    expect(await run(tenant, { action: "add_user", org: "puma", sub: "u-x", email: "x@x", all_stations: "yes" } as never))
      .toMatchObject({ ok: false });

    const list = (await run(tenant, { action: "list" })) as Record<string, any>;
    expect(list.users.find((u: any) => u.sub === "u-few")).toMatchObject({
      all_stations: false, stations: [ids.a2, ids.b].sort((x, y) => Number(x) - Number(y)),
    });
  });

  it("grants go with the user and with the station", async () => {
    await run(tenant, { action: "add_user", org: "puma", sub: "u-tmp", email: "tmp@puma.example" });
    const id = ((await run(tenant, {
      action: "add_station", org: "puma", agent_id: "station-z", console_id: "c1", name: "Temporal",
    })) as Record<string, any>).station.id;
    await run(tenant, { action: "grant_station", org: "puma", email: "tmp@puma.example", station: id });
    await run(tenant, { action: "grant_station", org: "puma", email: "tmp@puma.example", station: ids.a! });
    await run(tenant, { action: "remove_station", agent_id: "station-z", console_id: "c1" });
    expect((await owner.query("SELECT station_id::text FROM station_users WHERE user_sub = 'u-tmp'")).rows)
      .toEqual([{ station_id: ids.a }]);
    await run(tenant, { action: "remove_user", org: "puma", sub: "u-tmp" });
    expect((await owner.query("SELECT 1 FROM station_users WHERE user_sub = 'u-tmp'")).rows).toEqual([]);
  });

  it("hub_web cannot write; hub_app cannot change tenancy; hub_tenant cannot touch data", async () => {
    await expect(webPool.query("UPDATE organizations SET active = true")).rejects.toThrow(/permission denied/);
    await expect(webPool.query("DELETE FROM readings")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("UPDATE organizations SET active = true")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("INSERT INTO org_users VALUES (1, 'x', 'x')")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("DELETE FROM station_users")).rejects.toThrow(/permission denied/);
    await expect(webPool.query("DELETE FROM station_users")).rejects.toThrow(/permission denied/);
    await expect(tenantPool.query("DELETE FROM readings")).rejects.toThrow(/permission denied/);
    await expect(tenantPool.query("UPDATE alarms SET state = 'x'")).rejects.toThrow(/permission denied/);
  });
});
