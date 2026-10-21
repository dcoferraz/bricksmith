# Runtime resilience & performance

> Generated from the knowledge base (§8) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

## 8. Runtime resilience & performance

### 8.1 Where time goes under OBO

- Per request: connect + openSession handshake (dominant), then statement exec/fetch.
- A single-row Delta INSERT commit measured ~1.5–1.8 s even after optimization; the remaining real win was avoiding warehouse cold starts (auto-stop between requests).
- Cold boot of a classic warehouse: 30 s – 5 min. **Serverless warehouses removed most first-hit transients — prefer them for apps.**

### 8.2 Retry the safe things

Two transient classes appear before any user SQL executes, so retrying is safe even for writes:

| Phase | Typical messages | Policy that worked |
|---|---|---|
| Session open | "Failed to open new session … Couldn't create directory …", "sparkSession is null" | 4 attempts, backoff 400/900/1800 ms; new client per attempt |
| First statement | "Session … is not fully initialized yet: no SparkSession is attached" | same backoff, retry the statement |

Also: log a warning for errors that mention session/warehouse but weren't classified transient — that's how new variants are found. Redact token-like strings in error logs. Tag failures with a short statement label (never bound values).

### 8.3 Warm per-user session cache (opt-in)

Reuse a live session across a user's page/sort/filter requests to skip the handshake:

- Key = `sha256(token)` — never shared across identities, token never stored in plaintext.
- Idle TTL (~60 s), LRU size bound, discard on any error.
- Same-user concurrency → ephemeral extra session (one session can't run two statements).

### 8.4 Tell the user the warehouse is waking

- `GET /api/warehouse/status` calls `GET /api/2.0/sql/warehouses/{id}` with the user's token (a user with `CAN_USE` can read state), 5 s timeout, never throws — degrades to `UNKNOWN`. Not behind the group gate.
- Client polls every 5 s while not `RUNNING`, 30 s while `RUNNING`, re-checks on tab visibility.
- A non-blocking banner ("responses may be delayed while the warehouse starts") + a status dot (green RUNNING / amber STARTING-STOPPING-UNKNOWN / red STOPPED-DELETED). Dismissible.
- Local-only hook to force a state for testing the banner.

### 8.5 Cheap wins

- Lazy-load the SQL driver (≈1.3 s import) so tests/alternate providers never pay for it.
- Disable per-client driver telemetry (`telemetryEnabled: false`) when creating a client per request.
- Driver logger at WARN so per-request lifecycle noise doesn't bury app logs.
- One OBO session per mutation, including master-detail saves (combined endpoint) — not one per child row.
- Server-side pagination, latest-updated-first, filters pushed into SQL; keep a kill-switch flag until verified against the deployed schema.
- Cache dropdown option lists client-side, but treat cache as untrusted: version it, refetch when empty or wrong-shaped, normalize shape before use.
