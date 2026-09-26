# Increment review evidence

Reviewed 2026-09-26. The repository initially contained only an empty Git repository, with no commits, instructions, code, or tooling to preserve. Implemented the attachment's stages 0–2 scope. Later-stage recovery, approvals, assessments, dashboards, MCP, real payment credentials, real emails, and Jev calls are absent. Required approvals/assessments fail closed.

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

Enabled TypeScript's unused-local and unused-parameter checks, removed empty package metadata, and filled in the package description. Typecheck, build, agent-script syntax, all 17 tests, JSON/Compose parsing, purpose headers, and whitespace/final-newline checks passed. Full `npm audit` reported zero vulnerabilities. Docker runtime checks remain unexecuted as described below.

## Senior review follow-up

- Fixed a real PostgreSQL ordering bug: the task-lock query could evaluate its timestamp before waiting, allowing a quote that expired during that wait to reserve budget. The existing membership query now reads database time after the locks. The new HTTP regression observes the blocked query, holds the lock past expiry, then verifies `quote_expired` with no dispatch, attempt, reservation, or provider charge. It failed before the fix (HTTP 202 instead of the expected denial response) and passed afterward.
- Removed the provider's duplicate transaction lifecycle and manual validation-error branch. It reuses the existing transaction helper and shared HTTP schema-error handling. Ledger responses and the dropped-response fixture still occur only after commit. Provider source shrank from 117 to 105 lines; no dependency or abstraction was added.
- Corrected the execution waiter's final-read omission: an outcome from its last database poll is now returned instead of discarded. Existing duplicate and abandoned-claim tests still pass.
- Made the rate-limit test tolerate a legitimate database-clock minute rollover by repeating only that probe when its seeded minute changed. Added explicit checks that the provider rejects extra payment arguments and malformed operation IDs.

Final typecheck, build, and **18 tests passed** with zero failures/skips; configuration parsing, purpose headers, and whitespace checks passed. The payment scope and durable pause/revocation cutoff remain unchanged.

## Remaining limits and unrun commands

**Container isolation has not been runtime verified here.** Docker/Compose build, healthchecks, private-network reachability, secret mounting, read-only filesystem, and container-socket absence still need `docker compose run --rm agent` on a working engine. The topology and client checks are implemented and statically inspected; they are not reported as passed. Follow the setup commands in [README](../README.md).

Kaji's package API, PostgreSQL race protection, credentials, and provider ledger effects were runtime verified. This is a local simulated-payment increment, not a production deployment certification. Database accounts own their own databases; public edge controls, TLS, credential rotation, and finer database privileges remain deployment work. No automated reconciliation exists. Unknown or abandoned dispatches remain visible and hold budget indefinitely; only later, deliberately implemented recovery may resolve them using the same provider identity and evidence. Per-organization serialization is conservative and may limit throughput.

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
