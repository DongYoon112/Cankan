# Increment review evidence

Initial review: 2026-09-26. The repository initially contained only an empty Git repository, with no commits, instructions, code, or tooling to preserve. That increment implemented stages 0–2; recovery was absent at that review. **Stage 3 success reconciliation and its verification are recorded below (2026-09-27).** Approvals, assessments, dashboards, MCP, real payment credentials, real emails, and Jev calls remain absent. Required approvals/assessments fail closed.

## Commands actually run

Environment: Node **20.20.1**, npm **10.8.2**, real PostgreSQL **16.14**, Linux x64. PostgreSQL ran on isolated loopback port 55432. Test databases were separate from the provider/governance demo databases, created with unique names, and deleted by the test harness afterward.

| Command/check | Actual result |
|---|---|
| `npm ci` | Passed; 23 packages installed, audit reported 0 vulnerabilities |
| `npm run typecheck` | Passed, strict TypeScript |
| `npm run build` | Passed |
| `node dist/scripts/setup-secrets.js` | Passed; generated ignored simulator secrets, preserving any existing files |
| `node --check scripts/agent.mjs` | Passed syntax check |
| `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/cankan_test npm test` | **18 passed, 0 failed, 0 skipped**, latest senior-review run 8.436 s; includes the expiry-during-lock-wait regression |
| `npm run migrate`, twice on the same fresh database pair | Both passed; second run was idempotent |
| `npm run fixtures` | Passed; two organizations seeded |
| `node dist/src/provider-main.js`, `node dist/src/main.js` | Both started successfully on loopback for the demo |
| `npm run demo` | HTTP **200**, application `succeeded`, Kaji `succeeded`; provider ledger independently queried: **1 charge, 500 SIM_CENTS** |
| `npm audit --omit=dev` | 0 vulnerabilities reported |
| PyYAML parse and assertions on Compose topology/readiness/mounts | Passed static checks; not a Docker runtime validation |
| Secret mode inspection | `.secrets` 0700; selectively mounted files 0444 |
| `docker compose version` | **Blocked, exit 127:** Docker wrapper requires missing `/usr/bin/flatpak-spawn` |

The command-line demo used fresh uniquely named databases and the ignored generated credential files, started the actual built entrypoints in separate processes, then stopped those processes and dropped only its own databases. Demo operation ID: `demo-82e4804b-0381-4b6b-b576-826df3687654`; provider receipt ID: `9cac41ab-b732-497a-8b92-5b8849331df5`. Receipt facts matched the independent ledger.

## What the integration tests established

| Requirement | Evidence |
|---|---|
| Legitimate purchase and fee accounting | 500+0 and 450+50 succeed; application attempt and Kaji result equal provider ledger receipt; saved fingerprint recomputes |
| Strict authority boundary | Body organization/principal/claimed price/description/unsupported action rejected; unauthenticated 401, owner purchase 403, oversized body 413; zero effects |
| Fixed hard policies | Wrong seller, currency, expired quote, total 501, inactive task, missing membership, foreign task/quote blocked; no provider effects/reservation |
| Shared budget under concurrency | **10 concurrent requests, two OS processes, two agents: 4 successes, 6 budget denials, 4 ledger charges, 2,000 reserved** |
| Durable application idempotency | **8 concurrent identical calls across two processes: one receipt, one charge, 500 reserved**; quote/task changes 409; sibling agent cannot reuse identity |
| Organization isolation | Foreign status reads 404; owner can read own organization; same operation key in different organizations creates distinct legitimate identities |
| Owner controls | Agent controls 403; pause denies new purchases without reservation; organization B unaffected; revoke is organization-scoped and disables the agent credential |
| Approval/assessment remain closed | Required approval and assessment show blocked states and create no dispatch/attempt/reservation/provider charge |
| Provider independently enforces boundary | No credential or agent token returns 401; API raw-charge route 404; provider administrative ledger route 404 |
| Provider idempotency | Six concurrent privileged test calls with one identity create one ledger charge; identical requests replay; changed quote/fingerprint conflict |
| Uncertain provider outcome | Simulator commits then drops response: one actual charge, application unresolved, Kaji unknown, evidence absent locally, 500 held; replay does not create another charge |
| Abandoned claim | Injected interruption immediately after actual Kaji/PostgreSQL claim commit: no provider call, dispatch/attempt survive, Kaji outcome null, 500 held; other-process retry remains unresolved |
| Immutable inputs/evidence | Application input update/delete and provider quote update/delete and ledger update fail |
| Limits and redaction | Authenticated rate counter is shared across processes; invalid/unknown errors do not reveal supplied test credentials |

The abandoned-claim test interrupts the wrapper immediately after the real atomic store commit; it does not kill an OS process mid-instruction. The duplicate and budget race tests do use two separate OS processes. Provider fault injection is a real committed ledger transaction followed by socket destruction, not a mocked payment function.

## Findings fixed during self-review

- Initial race runs exposed a foreign-key lock deadlock: operation insertion's parent-key locks conflicted with policy `FOR UPDATE` locks. Parent and control locks now use **`FOR NO KEY UPDATE`**, preserving budget/control serialization while allowing foreign-key checks. The original strict 10-request assertion now passes.
- Removed nested `BEGIN/COMMIT` from provider migration; the migration runner owns the schema-plus-journal transaction and advisory lock.
- Added quote response ID verification and an active-owner recheck inside the revoke transaction.
- Renamed dispatch timestamp to `recordedAt`; it never claims to be exact commit time. Commit/lock ordering defines the cutoff.
- Secret mounts now work across host/container UID differences: operator-only 0700 parent, selectively mounted readable files.
- Agent network checks now use actual TCP connections; an HTTP rejection from a reachable PostgreSQL port would be a false positive.
- Added provider/API readiness healthchecks and dependency gates to avoid startup races in the documented Compose demo.
- Test cleanup stopped using forced database disconnection, which could race with closing pool sockets; it now shuts services/pools down and ordinarily drops only its own test databases.

## Follow-up hygiene check

Five confirmed small errors were fixed without adding dependencies:

- Missing provider quotes now return HTTP 404 instead of 503; payment-call errors still remain conservative. The integration test verifies no operation, reservation, or charge is created.
- Host and container demos now require application `succeeded`, instead of accepting denied HTTP 200 or unresolved HTTP 202. Requests have a bounded timeout. Subprocess tests exercise success, denial, and uncertainty; the container-script denial check uses a stub response and does **not** establish container isolation.
- Idle PostgreSQL connection failures no longer terminate the service through an unhandled pool error. The shared pool logs a fixed redacted message. A real PostgreSQL subprocess regression terminates only its own idle backend and verifies a replacement connection works. Before the fix, this reproduction exited with code 1.
- Bootstrap URLs now escape preserved passwords containing reserved URL characters. A temporary-directory regression verifies correct URL parsing and preservation of all existing secrets on rerun.
- JSON content types are normalized for case and surrounding whitespace. Valid media types such as `Application/JSON ; charset=utf-8` now reach schema validation; unsupported types still return 415.

Enabled TypeScript's unused-local and unused-parameter checks, removed empty package metadata, and filled in the package description. Typecheck, build, agent-script syntax, all 17 tests, JSON/Compose parsing, purpose headers, and whitespace/final-newline checks passed. Full `npm audit` reported zero vulnerabilities. Docker runtime checks were still unexecuted at that point; subsequent runtime evidence follows below.

## Senior review follow-up

- Fixed a real PostgreSQL ordering bug: the task-lock query could evaluate its timestamp before waiting, allowing a quote that expired during that wait to reserve budget. The existing membership query now reads database time after the locks. The new HTTP regression observes the blocked query, holds the lock past expiry, then verifies `quote_expired` with no dispatch, attempt, reservation, or provider charge. It failed before the fix (HTTP 202 instead of the expected denial response) and passed afterward.
- Removed the provider's duplicate transaction lifecycle and manual validation-error branch. It reuses the existing transaction helper and shared HTTP schema-error handling. Ledger responses and the dropped-response fixture still occur only after commit. Provider source shrank from 117 to 105 lines; no dependency or abstraction was added.
- Corrected the execution waiter's final-read omission: an outcome from its last database poll is now returned instead of discarded. Existing duplicate and abandoned-claim tests still pass.
- Made the rate-limit test tolerate a legitimate database-clock minute rollover by repeating only that probe when its seeded minute changed. Added explicit checks that the provider rejects extra payment arguments and malformed operation IDs.

Final typecheck, build, and **18 tests passed** with zero failures/skips; configuration parsing, purpose headers, and whitespace checks passed. The payment scope and durable pause/revocation cutoff remain unchanged.

## Docker runtime verification (2026-09-27)

**The local Compose demo and agent isolation checks passed on Docker Desktop.** This follow-up supersedes the earlier Docker runtime limitation above. Environment: Windows host, Docker Desktop 4.63.0, Linux engine 29.2.1 (linux/amd64), Compose v5.0.2. Docker Desktop was initially stopped and was started for this verification. Fresh simulator secrets and database volumes were created; no existing simulator data was reset.

| Command/check | Actual result |
|---|---|
| `node scripts/setup-secrets.ts` (host Node 24.11.0) | Passed; generated ignored local secrets |
| `docker compose build` | Passed; dependency installation and TypeScript compilation succeeded inside the service build |
| `docker compose up -d --wait db provider-db` | Both PostgreSQL containers healthy |
| `docker compose run --rm --build setup` | Migrations and two-organization fixtures succeeded |
| `docker compose up -d --wait provider api` | Provider and API healthy |
| `docker compose run --rm --build agent` | Exit 0; application and Kaji both `succeeded`; printed `Agent boundary checks passed` |
| Independent provider/governance SQL reads | Exactly one provider charge for 500 SIM_CENTS; matching receipt and successful application attempt; task reservation 500 |
| Agent script boundary assertions | Provider and both databases unreachable by service name; privileged secret files, trusted source, and Docker socket unreadable; privileged environment variables absent |
| Additional one-off probe through `docker compose run --rm --no-deps -T agent node --input-type=module -` | API reachable (unauthenticated HTTP 401); TCP connections to both provider IPs and both database IPs rejected; only `agent_token` mounted; non-root UID; `/tmp` write rejected with `EROFS`; effective capabilities zero; `NoNewPrivs` set to 1 |
| Docker port-binding inspection | API configured for `127.0.0.1:3000`; databases/provider have no published host ports |
| `docker compose stop` | All four service containers exited with code 0; database volumes and local secrets preserved |

Demo operation: `sandbox-0584652c-3e63-4ac5-a573-1a030634dbd8`. Provider operation: `294e4e17-3884-4d39-bd42-648ad625e8a7`. Receipt: `956e7b8d-ec94-4e73-8646-96b6f8453fbb`. The independent ledger evidence matched the agent's returned receipt. The additional probe was supplied through stdin without adding source mounts or privileged secrets to the agent container. This follow-up exercised the deployment and isolation checks; it did not rerun the separate 18-test integration suite.

## Stage 3 implementation and verification (2026-09-27)

Inspected the actual initial-commit checkout (`9cca435`), existing Docker review edits, schemas, claim/record transactions, simulator, and tests before extending. No repository `AGENTS.md` was present. Installed and applied the user-requested [Ponytail](https://github.com/DietrichGebert/ponytail) 4.10.0 skill through its Codex marketplace; `codex plugin list --json` confirmed installed/enabled. No application dependency was added or upgraded. Installed Kaji 0.3.1 declarations still define `.parse(input)`, `claim(ExecutionClaim)`, and `record(StoredExecution)`; its runtime calls the supplied parser's `.parse()`.

Environment: Windows, host Node **24.11.0**, npm **11.6.1**, Docker Desktop **4.63.0**, engine **29.2.1**, Compose **v5.0.2**, container Node **22.23.3**, PostgreSQL **16.14**. PowerShell commands use `npm.cmd` because this host's execution policy blocks `npm.ps1`. The sandboxed dependency download stalled; the authorized host `npm.cmd ci --fetch-retries=0` succeeded (49 packages, zero audit vulnerabilities). Different platform-specific optional packages explain the earlier Linux install count.

Baseline before code changes: `npm.cmd run typecheck`, `npm.cmd run build`, and the existing PostgreSQL suite all passed: **18 tests, zero failed/skipped, 9.083 s**. Tests used a new disposable container, not the existing demo databases:

```powershell
docker run -d --name cankan-stage3-test-20260927 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=cankan_test -p 127.0.0.1:55432:5432 postgres:16.14-bookworm
$env:TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/cankan_test'
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Final result for those three checks: **passed; 36 tests, zero failed/skipped, 16.800 s**. Integration suites create uniquely named databases and drop only their own databases. Additional agent/controller JavaScript syntax and `git diff --check` passed.

| Stage 3 acceptance check | Actual evidence |
|---|---|
| Existing-data migration | Constructed old schema with an existing dispatch, unresolved attempt, and 500 reservation; ran migration twice; job backfilled and reservation unchanged |
| Scoped lookup authority | Lookup credential can read matching organization/operation; wrong organization returns 404, payment token returns 403, agent token returns 401; lookup token POST returns 403 |
| Lost reply recovery | Two independent worker processes compete; one lookup resolves the actual receipt, no extra POST, one charge, reservation unchanged, Kaji remains `unknown` |
| Interrupted dispatch / missing evidence | 404 retains unresolved/null-Kaji state and budget, schedules backoff; later original submission can charge and then be reconciled |
| Worker/API crashes | Killed a worker holding a lease; successor recovers. Separately killed an API process at a database barrier after actual provider commit but before result persistence; job survives and recovery succeeds with Kaji still null |
| Lease/generation/version fencing | Expired sole worker cannot save success or error; old generation cannot overwrite successor; save blocked on an attempt lock rechecks expiry after the wait; changed application version rejects save |
| Atomic application/job/audit resolution | Test-only audit trigger failure rolls back receipt, attempt version, and job completion; same valid claim subsequently succeeds |
| Evidence validation | Tested wrong organization, operation, quote, fingerprint, seller, amounts, fees, total, currency, malformed/oversized content, HTTP 503/404, and a real timed-out request; none releases budget |
| Exhaustion | Eight claimed attempts require attention without release; expired final claim cannot cause a ninth lookup or accept a stale error |
| Late original results | Recovery-first matching success and timeout retain application success; identical results replay harmlessly; contradictory receipt audited without replacing accepted evidence; original-first completion fences the worker |
| Controls and isolation | Deterministic database barriers exercise pause/revoke in both commit orderings; control-first blocks dispatch, dispatch-first may finish; new operations remain blocked; lookup recovery works while paused or revoked |
| Status permissions | Original agent/organization owner can read reconciliation; sibling agent and foreign organizations cannot; arbitrary diagnostics and credentials do not appear in status |

Tests count incoming provider POST requests as well as inspect committed ledger effects, so provider deduplication cannot hide a worker resubmission. Fault servers and database barrier/failure triggers exist only in tests and uniquely named test databases. Lease-expiry tests deliberately change lease timestamps in those databases; commit-order tests wait for observable PostgreSQL lock barriers rather than using sleeps to choose the ordering.

Docker verification used the separate Compose project `cankan-stage3-verify`, with fresh project volumes. Original `cankan` demo containers/volumes were left untouched. Secret setup added the lookup credential while preserving existing files.

| Actual command/check | Result |
|---|---|
| `node dist/scripts/setup-secrets.js` | Passed; existing credentials preserved |
| `docker compose -p cankan-stage3-verify build api provider worker setup agent` | All images built |
| `docker compose -p cankan-stage3-verify up -d --wait db provider-db` | Both databases healthy |
| `docker compose -p cankan-stage3-verify run --rm setup` | Migrations and fixtures passed |
| `docker compose -p cankan-stage3-verify up -d --build --wait provider api worker` | API/provider healthchecks passed; background worker running |
| `$env:COMPOSE_PROJECT_NAME='cankan-stage3-verify'; node scripts/verify-boundary.mjs` | Passed before and after service recreation and again after the negative control; seven live private hostname/IP targets blocked, authenticated API positive control passed |
| `$env:AGENT_A_TOKEN_FILE='.secrets/agent-a-token'; npm.cmd run demo:recovery` | Background worker reconciled lost reply in one lookup; application succeeded, Kaji unknown, independent ledger receipt matched |
| `docker compose -p cankan-stage3-verify run --rm --no-deps agent` | Normal purchase and original boundary assertions passed |
| `docker compose -p cankan-stage3-verify stop worker`, second recovery demo, then `docker compose -p cankan-stage3-verify run --rm --no-deps worker node dist/src/worker-main.js --once` | One-pass command saved exactly one observation; waiting demo succeeded with Kaji unknown |
| Stop provider, run boundary controller | Expected exit 1; a stopped private service cannot masquerade as successful isolation. Provider restored and controller passed again |
| Independent final SQL inspection | Three charges total (normal purchase plus two recovery demos), all attempts succeeded; recovery lookup counts 0/1/1; task reservation exactly 1,500 |
| Actual worker-container credential probe | Only database URL and lookup token mounted; payment-token environment absent; authenticated POST `/charges` rejected with HTTP 403 |
| `docker compose -p cankan-stage3-verify stop`; `docker stop cankan-stage3-test-20260927` | Verification services stopped; original demo data, verification volumes, and all local credentials preserved |

Runtime verification found and fixed a pre-existing host-port issue: the API's configured loopback binding had no effective published port while all its networks were internal (`NetworkSettings.Ports` was empty for 3000). Added a network used only by the API; `docker port` now reports `127.0.0.1:3000`, the host recovery demo passes, and private service/agent isolation checks still pass. Docker documents internal networks as externally isolated in its [Compose network reference](https://docs.docker.com/reference/compose-file/networks/#internal).

Background demo operation: `recovery-4d35b781-684c-4336-8a8b-355e36a75f97`, provider operation `9fb98f17-9c13-4ecc-bab7-35c823889ca8`, receipt `fba464bc-3f4d-435b-89e2-0f71ae322747`. One-pass operation: `recovery-f9d0b862-2286-4002-8e14-50afb4e8b771`, receipt `3c2d4e93-5a82-458f-9aac-e0a2f2236442`.

Unexecuted/deferred: enabled-IPv6 runtime topology (this Docker stack assigned IPv4 only; controller discovers IPv6 when enabled), public deployment hardening, terminal no-effect/cancellation protocols, and automatic release. No real payments were used. Historical Linux fallback instructions below document the earlier environment, not a new dependency.

## Remaining limits

Kaji's package API, PostgreSQL race protection, credentials, provider ledger effects, success reconciliation, and container boundaries were runtime verified. This is a local simulated-payment increment, not a production deployment certification. Database accounts own their own databases; public edge controls, TLS, credential rotation, and finer database privileges remain deployment work. Recovery confirms matching committed effects using their original identities. Missing/invalid evidence and retry exhaustion retain unresolved state and budget indefinitely; successful recovery also keeps completed spending counted. Cancellation and automatic release require a future durable finality protocol. Per-organization dispatch serialization is conservative and may limit throughput.

All direct dependency versions and lockfile details are in [README](../README.md#dependencies). The [architecture note](architecture.md) documents every persistence/crash gap and the pause/revocation cutoff.

## PostgreSQL fallback used in this environment

Docker was unavailable, so a real unprivileged PostgreSQL binary distribution was unpacked under `/tmp`; it was not added as an application dependency. These are the reproducible Linux x64 setup steps used (the temporary directory name varies):

```sh
pgtest_dir=$(mktemp -d /tmp/cankan-postgres.XXXXXX)
cd "$pgtest_dir"
npm pack @embedded-postgres/linux-x64@16.14.0-beta.17 --silent
tar -xzf embedded-postgres-linux-x64-16.14.0-beta.17.tgz
ln -s libicui18n.so.60.2 package/native/lib/libicui18n.so.60
ln -s libicuuc.so.60.2 package/native/lib/libicuuc.so.60
ln -s libicudata.so.60.2 package/native/lib/libicudata.so.60
ln -s libpq.so.5.16 package/native/lib/libpq.so.5
export LD_LIBRARY_PATH="$pgtest_dir/package/native/lib"
./package/native/bin/initdb -D data -U postgres -A trust --no-locale --encoding=UTF8
./package/native/bin/pg_ctl -D data -l postgres.log \
  -o "-h 127.0.0.1 -p 55432 -k $pgtest_dir" -w start
```

Back in the repository, create the dedicated administrator test database once:

```sh
node --input-type=module -e "import pg from 'pg'; const c=new pg.Client('postgres://postgres@127.0.0.1:55432/postgres'); await c.connect(); await c.query('CREATE DATABASE cankan_test'); await c.end();"
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/cankan_test npm test
```

This loopback trust-authenticated database is disposable test infrastructure only. Stop it from its temporary directory using `./package/native/bin/pg_ctl -D data -m fast -w stop` with the same library path.
