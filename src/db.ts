// PostgreSQL access. One connection per Lambda container (a container serves
// one request at a time), opened lazily and reused across invocations.
import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";

// Console times are "timestamp" (no zone): keep them as the console wrote
// them ("2026-10-23T13:29:00") instead of letting pg guess a zone.
// timestamptz still becomes a Date (serialized as UTC ISO).
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (s) => s.replace(" ", "T"));

/** What the handlers need from the database. Parameters are $1, $2, … */
export interface Db {
  query<R>(sql: string, params?: unknown[]): Promise<R[]>;
}

export function wrap(pool: pg.Pool): Db {
  return {
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as R[];
    },
  };
}

/**
 * Pool from DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SSLMODE (verify-full |
 * require | disable; default verify-full). With DB_PASSWORD it logs in with
 * that password, otherwise with an RDS IAM token (signed locally, valid 15
 * min, a new one per connection).
 */
export function poolFromEnv(env = process.env): pg.Pool {
  const host = must(env, "DB_HOST");
  const port = Number(env.DB_PORT ?? 5432);
  const user = must(env, "DB_USER");
  let password: string | (() => Promise<string>);
  if (env.DB_PASSWORD) {
    password = env.DB_PASSWORD;
  } else {
    const signer = new Signer({ hostname: host, port, username: user });
    password = () => signer.getAuthToken();
  }
  const pool = new pg.Pool({
    host,
    port,
    user,
    password,
    database: must(env, "DB_NAME"),
    ssl: ssl(env.DB_SSLMODE ?? "verify-full"),
    max: 1,
    idleTimeoutMillis: 5 * 60_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "hub-web-api",
  });
  // An idle connection dropped while the container was frozen must not
  // crash the process; the pool opens a new one on the next query.
  pool.on("error", (err) => log("warn", "idle db connection lost", { error: err.message }));
  return pool;
}

// verify-full needs the RDS CA: on Lambda (Node 20+) set
// NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem (done in template.yml).
function ssl(mode: string): pg.PoolConfig["ssl"] {
  switch (mode) {
    case "verify-full":
      return { rejectUnauthorized: true };
    case "require":
      return { rejectUnauthorized: false };
    case "disable":
      return false;
    default:
      throw new Error(`DB_SSLMODE ${mode}: want verify-full, require or disable`);
  }
}

function must(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** With the Lambda JSON log format, an object becomes the "message" field. */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console[level]({ msg, version: VERSION, ...fields });
}

export const VERSION = process.env.HUB_VERSION ?? "dev";
