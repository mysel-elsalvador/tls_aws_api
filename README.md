# hub web API

Read API for the web app (`../page`), plus the Cognito users and the S3 + CloudFront hosting of the site. One SAM stack per environment (`hub-web-dev`, `hub-web-prod`), in the same account and region as the ingest stack (`../aws`). It reuses that stack's database.

```
browser ──SRP──> Cognito (user pool, admin-created users only)
   │ access token
   ▼
API Gateway (HTTP API, JWT authorizer) ──> web Lambda (Node 22, TypeScript, VPC) ──IAM auth, hub_web──> RDS PostgreSQL
                                                                                    (of hub-<env>, read-only)
operator ──aws lambda invoke──> admin Lambda ──IAM auth, hub_tenant──> organizations / stations / org_users
```

## Tenancy

The tables are in the ingest stack's database (`../aws/migrations/003_tenancy.sql`, `004_station_console.sql`, `005_station_users.sql`), next to the data they gate:

| Table           | What                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations` | a customer. `active = false` (the default) means the subscription is off: no data at all                                                                               |
| `stations`      | one per console (`agent_id` + `console_id`), owned by one organization. One agent can read several consoles, each its own station, possibly of different organizations |
| `org_users`     | Cognito user (`sub`) to organization, with `role` `viewer`/`admin` and `all_stations`                                                                                 |
| `station_users` | stations granted to a user (only stations of the user's organization; dropped with the user or the station)                                                          |

- **Which stations a user sees** in an organization: all of them as `admin` or with `all_stations`; otherwise only the granted ones. A new viewer sees **none** until given `all_stations` or grants. Users that existed before `005` were set to `all_stations`. `/v1/me` reports each organization's `stations`: `all` or `assigned`.
- Every query starts from the token's `sub` through `org_users`. A station of another organization, or one not granted, is a 404. A station of an inactive organization is a 403 `organization_inactive`. The list skips inactive organizations, and `/v1/me` tells the app which ones are inactive.
- **Database roles:** `hub_web` (this API) can only `SELECT`. `hub_tenant` (admin) can write only the tenancy tables. `hub_app` (the processor) cannot write them. `test/pg.test.ts` checks all three.

## Endpoints

All of them need `Authorization: Bearer <Cognito access token>`. The contract is in `src/types.ts`.

| Route                   | Returns                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`            | email + organizations (`active`, `role`)                                                                                           |
| `GET /v1/stations`      | stations of the active organizations: agent `online`/`offline`/`never`, console state, tank and active-alarm counts, last reading  |
| `GET /v1/stations/{id}` | the same summary, plus `tanks` (latest reading per tank), `alarms` (active, from the latest 113 snapshot) and `deliveries` (latest 50 tank deliveries from 202/20C, console times), of that console only |
| `GET /v1/stations/{id}/history?hours=24` | readings of the last `hours` (1..168, default 24) per tank as `[collected_at, height, volume]`, by agent time (console clocks may be skewed). Index from `aws/migrations/006` |

- **Agent online:** a heartbeat within `OnlineWindowSeconds` (180 s; the agent sends one every 60 s).
- **Console state:** what the agent's last heartbeat reported for the station's console. It is `unknown` while the agent is not online.
- **Station without a console** (`console.id: null`): registered before `004` on an agent with several consoles. It shows no data until `set_station_console`.
- **Times:** console times are sent as the console reported them (no zone; the real console is 10 days fast). Times ending in `_at` are UTC.

## Deploy

Deploy `../aws` first. That stack creates the tenancy tables and roles, and the exports this stack imports (`hub-dev-DbSubnetA`, …).

```sh
npm ci
make test test-pg typecheck     # test-pg: throwaway local PostgreSQL with ../aws/migrations
make deploy                     # = sam build && sam deploy --config-env dev   → stack hub-web-dev
make deploy ENV=prod            # hub-web-prod, imports from hub-prod, asks to confirm
cd ../page && npm run deploy    # build the site with this stack's outputs, upload it
```

Outputs: `WebUrl` (the site), `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `WebBucketName`, `WebDistributionId`.

## Customers and users

```sh
make admin A='{"action":"create_org","slug":"rvq","name":"RVQ El Salvador","active":true}'
make admin A='{"action":"list"}'      # "consoles": every console the agents report, with its station (null: none yet)
make admin A='{"action":"add_station","org":"rvq","agent_id":"station-rvq-001","console_id":"tex-merliot","name":"Texaco Merliot","address":"Ciudad Merliot CP, Santa Tecla 1501, El Salvador"}'
make user EMAIL=ga.salandra@gmail.com ORG=rvq STATIONS=all   # creates the Cognito user (emails a temporary password), links it, sees every station
make user EMAIL=x@y.com ORG=rvq STATIONS=2,3                  # sees only stations 2 and 3
make user EMAIL=x@y.com ORG=rvq                               # sees no station yet (re-running adds grants, keeps the scope)
make user EMAIL=jefe@y.com ORG=rvq ROLE=admin                 # admins always see every station
make admin A='{"action":"set_org_active","org":"rvq","active":false}'   # subscription off: immediately no data

make admin A='{"action":"set_user_scope","org":"rvq","email":"x@y.com","all_stations":false}' # back to granted stations only
make admin A='{"action":"grant_station","org":"rvq","email":"x@y.com","station":"2"}'         # grant station 2
make admin A='{"action":"revoke_station","org":"rvq","email":"x@y.com","station":"2"}'        # revoke station 2
```

`list` shows each user's `all_stations` and granted `stations`. Station ids are strings (as `list` shows them).

Other actions: `set_station_console {id, console_id}`, `remove_station {agent_id, console_id}`, `add_user {org, sub, email, role, all_stations?}`, `remove_user {org, sub}` (also drops its grants). To lock a user out completely: `aws cognito-idp admin-disable-user`.

Whoever can call `lambda:InvokeFunction` on `hub-web-<env>-admin` is an administrator.

## Notes

- **DB TLS:** `verify-full` against the CA bundle of the Lambda runtime (`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`). If connections fail with a certificate error, deploy with `DbSslMode=require`, which encrypts without verifying, the same as the processor.
- **Connections:** one per Lambda container, with an IAM token per connection. Many concurrent users means many connections on a `t4g.micro` (about 80 max). Add RDS Proxy before that point.
- **CORS:** the CloudFront URL, plus `http://localhost:3000` when `AllowLocalDev=true` (dev).
- **Cognito email:** the default sender is limited to about 50 emails a day. Use SES for production.
- **The `tank_latest` / `active_alarms` views** scan each agent's history. That is fine for the pilot; a "current" table kept by the processor will be needed as history grows.

## Not done yet

- Custom domains for the site and the API (ACM in `us-east-1` for CloudFront).
- Password reset from the login page, MFA.
- History endpoints (readings over time, deliveries) and alarm notifications.
- A role-based admin UI (today it is `make admin`).
