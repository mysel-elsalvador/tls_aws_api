import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { agentState, consoleState } from "../src/stations";
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
});
