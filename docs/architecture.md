# Execution protocol and trust boundary

Agent authority comes exclusively from an authenticated bearer token matched to a stored, active principal. Organization and role come from that row. Each operation key is unique within the organization, across agents. The original agent owns its operation; a sibling agent cannot acquire another execution by reusing its key. Distinct operations share the task budget. Body schemas are strict, request bodies and headers are capped at 8 KiB, identifiers are bounded, and cents are integers between 0 and 1,000,000. Purchase policy then caps amount plus fees at 500.

The provider URL and credential are trusted deployment configuration, never supplied by the agent. Quotes have immutable seller, amount, fees, simulated currency, organization, and expiry. Only the provider database's trusted fixture loader can create them. The API confirms quote identity and organization, saves the complete quote inside immutable canonical input, and hashes sorted JSON with SHA-256. The immutable operation stores both the original validated selection and the execution input. Changed input under the same operation key returns 409 before Kaji/provider invocation.

The provider separately authenticates every route and owns its own database. Its ledger enforces one charge per provider operation UUID with a transaction advisory lock plus primary key. Identical requests replay the actual saved receipt, including after quote expiry; changed terms conflict. Provider operation IDs are generated once and saved before dispatch. No raw charge, credential, quote creation, or ledger route exists on the agent-facing service.

## Transactions

1. **Intake:** authenticate, validate, resolve quote outside a transaction, then atomically insert immutable application operation (organization/key uniqueness). Competing submissions load the winner and compare validated requests. No reservation or provider effect exists yet.
2. **Claim and dispatch:** the application-specific `PgExecutionStore.claim()` begins a short transaction. Lock organization, task, and principal; atomically insert the Kaji execution identity; then read PostgreSQL time and decide policy. The expiry clock is read after acquiring the locks, since a locking SELECT can evaluate its timestamp before waiting. A permitted decision updates reserved cents and creates a dispatch plus unresolved attempt in the same transaction. Denial or required approval creates a claim and decision only. All five records commit together. Provider calls never occur inside this transaction.
3. **Kaji gates:** Kaji calls authorization against the saved decision. Assessment requirements deny. Approval requirements return Kaji `rejected` because no approver is installed. A permitted dispatch proceeds to the single static capability. It executes the saved canonical input and stable provider identity, never fresh request arguments.
4. **Provider:** its independent transaction locks the operation key, checks immutable quote/fingerprint/currency/expiry, and inserts the actual receipt. Both services use the same transaction helper for commit, rollback, client release, and a five-second lock timeout. The provider replies or drops its fault-fixture response only after that helper commits. HTTP occurs outside our transaction. The service verifies all execution-relevant receipt fields. Failed calls and invalid receipts remain uncertain; even a provider 4xx is conservatively unresolved in this increment.
5. **Final record:** `PgExecutionStore.record()` atomically stores the redacted Kaji outcome and, on success, the verified provider receipt in the attempt. No gap exists between a saved successful Kaji outcome and saved provider evidence. Non-success outcomes retain any reserved budget.

The store implements exactly `claim(ExecutionClaim): Promise<ClaimResult>` and `record(StoredExecution): Promise<void>`. PostgreSQL claims are unique on capability/principal/idempotency key and operation ID. Kaji's own input fingerprint is a canonical JSON string, separate from the application's SHA-256 fingerprint. Existing claim waiters poll for at most two seconds; timeout rejects the wait, never reclaims the execution or invents a terminal result. The HTTP response then reports durable application status. There is no lease/timer takeover, automatic payment retry, or background worker.

## Pause and revocation cutoff

Owner pause and agent revocation lock the same organization row as the dispatch transaction. A control that commits first blocks a new dispatch. A dispatch that commits first is durably authorized and may reach the provider after a pause/revocation response. Pause does not cancel it or release budget. Authentication can race with revocation, so the dispatch transaction rechecks active principal status under its locks. Controls are audited.

`dispatch.recordedAt` is a database timestamp taken while inserting the record, **not the exact commit time**. Lock serialization and commit establish ordering; timestamps do not prove that ordering. This implementation serializes purchases per organization as a deliberate throughput limit. Narrow the lock only if measured load requires it while retaining the shared control ordering.

## Crash gaps

| Crash/lost acknowledgement | Durable evidence | Result and retry behavior |
|---|---|---|
| Before immutable operation insert | Nothing | Same submitted operation may start safely |
| After operation insert, before claim transaction | Saved inputs only | Authenticated status says unresolved; same operation may safely claim because no dispatch exists |
| During claim transaction before commit | Transaction rolls back | No claim/reservation/dispatch/attempt survives; same operation may safely claim |
| Claim commit acknowledged or acknowledgement lost; before Kaji gate/provider call | Claim, decision, reservation, dispatch, pre-call attempt | Unresolved and budget held; duplicate waits/reads only, even if no provider charge occurred |
| Provider call did not reach provider, or provider transaction rolled back | Same application dispatch | Unresolved and held; this increment cannot prove absence of an effect |
| Provider committed; response dropped or service died | Provider ledger has charge; application still unresolved | Held; same operation never executes again; provider identity retained for later reconciliation |
| Valid receipt received, before/during final store transaction | Provider receipt exists; application final transaction either commits or rolls back atomically | Success+receipt together, or unresolved+held; no new payment |
| Final store commit acknowledged or acknowledgement lost | May already have saved success+receipt | Status reads durable facts. Kaji may transiently return `unknown` on a lost store acknowledgement; HTTP does not overwrite saved success with that result |
| HTTP response lost after completion | Saved application result and provider ledger | Identical retry replays, changed input conflicts |

Application states (`succeeded`, `denied`, `blocked_approval`, `blocked_assessment`, `unresolved`) differ from Kaji statuses. In particular, `unresolved` includes a pending/dead claimant with no Kaji result and an explicit Kaji `unknown`. It never means proven failure. Status reads expose dispatch/attempt/evidence separately. This increment never releases reservations, including completed spend; future reconciliation must prove outcomes before altering budget. Lack of an automated recovery worker is visible and intentional.

## Deployment boundaries and limits

Compose puts the agent on a network containing only the API. The API additionally joins its database network and a provider link. The provider alone joins its ledger database network. Neither database nor the provider publishes a host port. The agent has only its own token, a read-only client image, no source/host mounts, no container socket, no owner/admin/provider/database secrets, no capabilities, and no privilege escalation. Database volumes and simulator credentials persist. These deployment definitions must be tested with an actual Docker engine; host integration tests verify credential checks but cannot prove container isolation.

The trusted operator owns the host and secret files. Administrative access to those databases or the container engine is outside the untrusted-agent boundary. The local bootstrap database accounts own their databases; database-role hardening, secret rotation and TLS termination are deployment follow-up, not supplied by Kaji. Do not expose this loopback demo API directly on the public internet. Process HTTP gates cap 240 requests/minute/IP and 128 concurrent connections, and a PostgreSQL counter caps authenticated principals at 120/minute across replicas. A distributed edge limiter would be needed for public unauthenticated traffic. Errors are fixed application messages/codes; authorization headers, exception causes, and connection strings are never emitted.

The simulator's `drop_after_commit` fixture is trusted database configuration; agents cannot select fault behavior in input. It creates a real durable simulated charge and closes the response, making conservative uncertainty testable. Only the test/operator process can inspect the provider ledger directly.
