// Web API Lambda, behind API Gateway (HTTP API) with a Cognito JWT
// authorizer: every request reaching it carries a valid token, and the
// caller is the token's "sub". Read-only (DB user hub_web).
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer as Event,
  APIGatewayProxyStructuredResultV2 as Result,
} from "aws-lambda";
import { type Db, log, poolFromEnv, wrap } from "./db";
import {
  getClose,
  getCloses,
  getHistory,
  getSales,
  getStation,
  listStations,
  MAX_HISTORY_HOURS,
  MAX_SALES,
  me,
  type Options,
  parseCursor,
} from "./stations";
import type { ApiError, CloseType } from "./types";

const ID = /^[1-9][0-9]{0,17}$/;

let db: Db | undefined;

export async function handler(event: Event): Promise<Result> {
  db ??= wrap(poolFromEnv());
  const started = Date.now();
  const res = await route(db, event, {
    now: new Date(),
    onlineWindowS: Number(process.env.ONLINE_WINDOW_S ?? 180),
  });
  log("info", "request", {
    route: event.routeKey,
    status: res.statusCode,
    ms: Date.now() - started,
    sub: event.requestContext.authorizer?.jwt?.claims?.sub,
    requestId: event.requestContext.requestId,
  });
  return res;
}

export async function route(
  db: Db,
  event: Event,
  opt: Options,
): Promise<Result> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  // The authorizer guarantees a token; a missing sub means a misconfigured route.
  if (typeof sub !== "string" || sub === "")
    return fail(500, "internal", "no sub claim");
  try {
    switch (event.routeKey) {
      case "GET /v1/me":
        return json(200, await me(db, sub));
      case "GET /v1/stations":
        return json(200, { stations: await listStations(db, sub, opt) });
      case "GET /v1/stations/{id}": {
        const id = event.pathParameters?.id ?? "";
        if (!ID.test(id))
          return fail(400, "bad_request", "id must be a station number");
        const r = await getStation(db, sub, id, opt);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, {
          station: r.station,
          tanks: r.tanks,
          alarms: r.alarms,
          deliveries: r.deliveries,
        });
      }
      case "GET /v1/stations/{id}/history": {
        const id = event.pathParameters?.id ?? "";
        if (!ID.test(id))
          return fail(400, "bad_request", "id must be a station number");
        const hoursParam = event.queryStringParameters?.hours ?? "24";
        const hours = /^[1-9][0-9]{0,2}$/.test(hoursParam)
          ? Number(hoursParam)
          : 0;
        if (hours < 1 || hours > MAX_HISTORY_HOURS) {
          return fail(
            400,
            "bad_request",
            `hours must be 1..${MAX_HISTORY_HOURS}`,
          );
        }
        const r = await getHistory(db, sub, id, hours, opt);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, r.history);
      }
      case "GET /v1/stations/{id}/sales": {
        const id = event.pathParameters?.id ?? "";
        if (!ID.test(id))
          return fail(400, "bad_request", "id must be a station number");
        const limitParam =
          event.queryStringParameters?.limit ?? String(MAX_SALES);
        const limit = /^[1-9][0-9]{0,2}$/.test(limitParam)
          ? Number(limitParam)
          : 0;
        if (limit < 1 || limit > MAX_SALES)
          return fail(400, "bad_request", `limit must be 1..${MAX_SALES}`);
        const r = await getSales(db, sub, id, limit);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, { sales: r.value });
      }
      case "GET /v1/stations/{id}/closes": {
        const id = event.pathParameters?.id ?? "";
        if (!ID.test(id))
          return fail(400, "bad_request", "id must be a station number");
        const type = event.queryStringParameters?.type ?? "T";
        if (type !== "T" && type !== "D" && type !== "M")
          return fail(400, "bad_request", "type must be T, D or M");
        const beforeParam = event.queryStringParameters?.before;
        const before =
          beforeParam === undefined ? null : parseCursor(beforeParam);
        if (beforeParam !== undefined && !before)
          return fail(400, "bad_request", "before must be a next cursor");
        const r = await getCloses(db, sub, id, type satisfies CloseType, before);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, r.value);
      }
      case "GET /v1/stations/{id}/closes/{close}": {
        const id = event.pathParameters?.id ?? "";
        const close = event.pathParameters?.close ?? "";
        if (!ID.test(id) || !ID.test(close))
          return fail(400, "bad_request", "id and close must be numbers");
        const r = await getClose(db, sub, id, close);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, r.value);
      }
      default:
        return fail(404, "not_found", `no route ${event.routeKey}`);
    }
  } catch (err) {
    log("error", "request failed", {
      route: event.routeKey,
      error: String(err),
    });
    return fail(500, "internal");
  }
}

function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function fail(
  statusCode: number,
  error: ApiError["error"],
  message?: string,
): Result {
  return json(statusCode, { error, message } satisfies ApiError);
}
