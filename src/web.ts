// Web API Lambda, behind API Gateway (HTTP API) with a Cognito JWT
// authorizer: every request reaching it carries a valid token, and the
// caller is the token's "sub". Read-only (DB user hub_web).
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer as Event,
  APIGatewayProxyStructuredResultV2 as Result,
} from "aws-lambda";
import { type Db, log, poolFromEnv, wrap } from "./db";
import { getStation, listStations, me, type Options } from "./stations";
import type { ApiError } from "./types";

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

export async function route(db: Db, event: Event, opt: Options): Promise<Result> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  // The authorizer guarantees a token; a missing sub means a misconfigured route.
  if (typeof sub !== "string" || sub === "") return fail(500, "internal", "no sub claim");
  try {
    switch (event.routeKey) {
      case "GET /v1/me":
        return json(200, await me(db, sub));
      case "GET /v1/stations":
        return json(200, { stations: await listStations(db, sub, opt) });
      case "GET /v1/stations/{id}": {
        const id = event.pathParameters?.id ?? "";
        if (!/^[1-9][0-9]{0,17}$/.test(id)) return fail(400, "bad_request", "id must be a station number");
        const r = await getStation(db, sub, id, opt);
        if (r.kind === "not_found") return fail(404, "not_found");
        if (r.kind === "inactive") return fail(403, "organization_inactive");
        return json(200, { station: r.station, tanks: r.tanks, alarms: r.alarms });
      }
      default:
        return fail(404, "not_found", `no route ${event.routeKey}`);
    }
  } catch (err) {
    log("error", "request failed", { route: event.routeKey, error: String(err) });
    return fail(500, "internal");
  }
}

function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function fail(statusCode: number, error: ApiError["error"], message?: string): Result {
  return json(statusCode, { error, message } satisfies ApiError);
}
