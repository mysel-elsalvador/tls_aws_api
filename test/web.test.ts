import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { agentState, consoleState, controllerState } from "../src/stations";
import { route } from "../src/web";

const now = new Date("2026-10-16T12:00:00Z");
const opt = { now, onlineWindowS: 180 };

function event(routeKey: string, sub: string | undefined, id?: string): Event {
  return {
    routeKey,
    pathParameters: id === undefined ? undefined : { id },
    requestContext: { requestId: "r1", authorizer: { jwt: { claims: sub ? { sub } : {}, scopes: [] } } },
  } as unknown as Event;
}

// Answers the summary query with `rows` and everything else with [].
function fakeDb(rows: unknown[], calls: unknown[][] = []): Db {
  return {
    async query<R>(sql: string, params: unknown[] = []) {
      calls.push(params);
      return (sql.includes("FROM org_users u\nJOIN organizations") ? rows : []) as R[];
    },
  };
}

const row = {
  id: "7", name: "Escalonia", address: null, org_id: "1", org_name: "Puma", org_active: true,
  agent_id: "station-0042", console_id: "tls2-1", agent_version: "1.0", last_heartbeat_at: new Date("2026-10-16T11:59:00Z"),
  console_state: "online", tanks: 1, active_alarms: 2, last_reading_at: null,
};

describe("route", () => {
  it("rejects a request without sub", async () => {
    expect((await route(fakeDb([]), event("GET /v1/me", undefined), opt)).statusCode).toBe(500);
  });

  it("validates the station id before querying", async () => {
    const calls: unknown[][] = [];
    for (const id of ["0", "abc", "1;drop", "1234567890123456789"]) {
      const res = await route(fakeDb([row], calls), event("GET /v1/stations/{id}", "u1", id), opt);
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("passes the caller's sub and the id to the query", async () => {
    const calls: unknown[][] = [];
    await route(fakeDb([row], calls), event("GET /v1/stations/{id}", "u1", "7"), opt);
    expect(calls[0]).toEqual(["u1", "7"]);
  });

  it("404 when the station is not the caller's", async () => {
    const res = await route(fakeDb([]), event("GET /v1/stations/{id}", "u1", "7"), opt);
    expect(res.statusCode).toBe(404);
  });

  it("403 when the organization is inactive, without reading data", async () => {
    const calls: unknown[][] = [];
    const res = await route(fakeDb([{ ...row, org_active: false }], calls), event("GET /v1/stations/{id}", "u1", "7"), opt);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(String(res.body)).error).toBe("organization_inactive");
    expect(calls).toHaveLength(1);
  });

  it("200 with station, tanks and alarms", async () => {
    const res = await route(fakeDb([row]), event("GET /v1/stations/{id}", "u1", "7"), opt);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(String(res.body));
    expect(body.station.agent).toEqual({
      id: "station-0042", state: "online", version: "1.0", last_heartbeat_at: "2026-10-16T11:59:00.000Z",
    });
    expect(body.station.console).toEqual({ id: "tls2-1", state: "online" });
    expect(body).toHaveProperty("tanks");
    expect(body).toHaveProperty("alarms");
  });

  it("history validates hours before querying, default 24", async () => {
    const calls: unknown[][] = [];
    const hist = (hours?: string) => {
      const e = event("GET /v1/stations/{id}/history", "u1", "7");
      return route(fakeDb([row], calls), { ...e, queryStringParameters: hours === undefined ? undefined : { hours } }, opt);
    };
    for (const h of ["0", "169", "-1", "1.5", "abc", "0024"]) expect((await hist(h)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);

    const res = await hist();
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toEqual(["u1", "7"]);
    expect(calls[1]![2]).toEqual(new Date(now.getTime() - 24 * 3600_000));
    expect(JSON.parse(String(res.body))).toEqual({
      from: "2026-10-15T12:00:00.000Z", to: now.toISOString(), tanks: [],
    });
    expect((await hist("168")).statusCode).toBe(200);
  });

  it("history: 404 not the caller's, 403 inactive", async () => {
    const e = event("GET /v1/stations/{id}/history", "u1", "7");
    expect((await route(fakeDb([]), e, opt)).statusCode).toBe(404);
    expect((await route(fakeDb([{ ...row, org_active: false }]), e, opt)).statusCode).toBe(403);
  });

  it("station without heartbeat fields: console kept, no controller", async () => {
    const body = JSON.parse(String((await route(fakeDb([row]), event("GET /v1/stations", "u1"), opt)).body));
    expect(body.stations[0]).toMatchObject({ has_console: true, controller: null });
  });

  it("controller from the heartbeat; controller-only when the id is not a console", async () => {
    const get = async (r: object) =>
      JSON.parse(String((await route(fakeDb([{ ...row, ...r }]), event("GET /v1/stations/{id}", "u1", "7"), opt)).body)).station;
    const both = { console_listed: true, controller_listed: true, controller_state: "online" };
    expect(await get(both)).toMatchObject({ has_console: true, controller: { id: "tls2-1", state: "online" } });
    expect(await get({ ...both, console_listed: false, controller_state: "offline" }))
      .toMatchObject({ has_console: false, controller: { id: "tls2-1", state: "offline" } });
    // A stale heartbeat makes the controller offline.
    expect(await get({ ...both, last_heartbeat_at: new Date(now.getTime() - 600_000) }))
      .toMatchObject({ controller: { state: "offline" } });
  });

  it("VOX routes validate their parameters before querying", async () => {
    const calls: unknown[][] = [];
    const call = (routeKey: string, path: Record<string, string>, qs?: Record<string, string>) =>
      route(fakeDb([row], calls), {
        ...event(routeKey, "u1"), pathParameters: path, queryStringParameters: qs,
      } as Event, opt);
    const bad = [
      call("GET /v1/stations/{id}/sales", { id: "x" }),
      ...["0", "51", "abc", "-1", "050"].map((limit) => call("GET /v1/stations/{id}/sales", { id: "7" }, { limit })),
      call("GET /v1/stations/{id}/closes", { id: "7" }, { type: "X" }),
      ...["", "2026-10-26T17:33:47", "2026-10-26 17:33:47_1", "2026-10-26T17:33:47_0", "x_1"]
        .map((before) => call("GET /v1/stations/{id}/closes", { id: "7" }, { before })),
      call("GET /v1/stations/{id}/closes/{close}", { id: "7", close: "a" }),
      call("GET /v1/stations/{id}/closes/{close}", { id: "0", close: "1" }),
    ];
    for (const res of await Promise.all(bad)) expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);

    expect((await call("GET /v1/stations/{id}/sales", { id: "7" })).statusCode).toBe(200);
    expect(calls[1]).toEqual(["station-0042", "tls2-1", 50]);
    calls.length = 0;
    const res = await call("GET /v1/stations/{id}/closes", { id: "7" }, { before: "2026-10-26T17:33:47_12" });
    expect(JSON.parse(String(res.body))).toEqual({ closes: [], next: null });
    expect(calls[1]).toEqual(["station-0042", "tls2-1", "T", "2026-10-26T17:33:47", "12", 21]);
    calls.length = 0;
    await call("GET /v1/stations/{id}/closes", { id: "7" }, { type: "D" });
    expect(calls[1]).toEqual(["station-0042", "tls2-1", "D", null, null, 21]);
  });

  it("VOX routes: 404 not the caller's or no such close, 403 inactive", async () => {
    const e = (routeKey: string, path: Record<string, string>) => ({ ...event(routeKey, "u1"), pathParameters: path }) as Event;
    for (const [k, p] of [
      ["GET /v1/stations/{id}/sales", { id: "7" }],
      ["GET /v1/stations/{id}/closes", { id: "7" }],
      ["GET /v1/stations/{id}/closes/{close}", { id: "7", close: "3" }],
    ] as const) {
      expect((await route(fakeDb([]), e(k, p), opt)).statusCode).toBe(404);
      const calls: unknown[][] = [];
      expect((await route(fakeDb([{ ...row, org_active: false }], calls), e(k, p), opt)).statusCode).toBe(403);
      expect(calls).toHaveLength(1);
    }
    // The station is the caller's, but the close is not one of its controller's.
    expect((await route(fakeDb([row]), e("GET /v1/stations/{id}/closes/{close}", { id: "7", close: "3" }), opt)).statusCode)
      .toBe(404);
  });

  it("500 without leaking the error", async () => {
    const db: Db = { query: async () => { throw new Error("password authentication failed for hub_web"); } };
    const res = await route(db, event("GET /v1/stations", "u1"), opt);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("password");
  });
});

describe("status", () => {
  it("agent online within the window, offline after, never without heartbeat", () => {
    expect(agentState(new Date(now.getTime() - 180_000), opt)).toBe("online");
    expect(agentState(new Date(now.getTime() - 181_000), opt)).toBe("offline");
    expect(agentState(null, opt)).toBe("never");
  });

  it("console is unknown unless the agent is online and reported it", () => {
    expect(consoleState("online", "online")).toBe("online");
    expect(consoleState("offline", "online")).toBe("offline");
    expect(consoleState("weird", "online")).toBe("unknown");
    expect(consoleState(null, "online")).toBe("unknown");
    expect(consoleState("online", "offline")).toBe("unknown");
    expect(consoleState("online", "never")).toBe("unknown");
  });

  it("controller is online only if the agent is online and reported it online", () => {
    expect(controllerState("online", "online")).toBe("online");
    expect(controllerState("offline", "online")).toBe("offline");
    expect(controllerState("unknown", "online")).toBe("offline");
    expect(controllerState(null, "online")).toBe("offline");
    expect(controllerState("online", "offline")).toBe("offline");
  });
});
