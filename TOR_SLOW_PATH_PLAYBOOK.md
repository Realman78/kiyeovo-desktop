# Tor Slow-Path Playbook

Goal: reduce worst-case Tor latency for group bucket reads (for example 20-30s per bucket) without changing group correctness guarantees.

## Problem Pattern

Observed symptom:
- DHT `get` on group buckets/meta can take tens of seconds, especially when multiple buckets are scanned.

Main reason in this codebase:
- Many `dht.get` calls are needed during catch-up/check flows.
- Each call is subject to Tor path latency, relay variability, and query retry/walk behavior.

## Priority Plan (No Protocol Changes)

## 1) Keep Reads Targeted, Never Broad

Status:
- Already partially improved by epoch/senders pruning and metadata-guided scans.

Action:
- Continue enforcing "only required epochs/senders" in every check path.
- Do not reintroduce full-history scans unless local anchor is missing.

Touchpoints:
- `src/core/lib/group/group-offline-manager.ts`
  - `checkGroupChat(...)`
  - `getEpochSenderPeerIds(...)`
  - `shouldSkipEpoch(...)`
  - pruning paths (`pruneEpochState(...)`)

## 2) Add Hard Deadline for `dht.get` Consumer Loops

Why:
- `for await (...)` can run long waiting for events under Tor.

Action:
- Introduce a bounded get helper with deadline:
  - read until `deadlineMs`, then stop consuming and return best-so-far.
- Apply to:
  - group offline store fetch (`getLatestStore`)
  - group info meta fetch (`getVersionMeta`)
  - group responder chain reads (`fetchLatestGroupInfoRecord`, `fetchVersionedGroupInfoRecord`)

Recommended starting values:
- `GROUP_DHT_GET_DEADLINE_MS = 8000`
- `GROUP_DHT_GET_DEADLINE_SLOW_MS = 12000` for explicit/manual refetch path only.

Guardrail:
- If deadline hit and no value found, log reason explicitly (`deadline_exceeded`), do not silently fail.

## 3) Early-Return on First Sufficient Value

Why:
- Waiting for additional events after one valid value often adds latency with little benefit.

Action:
- In read helpers, stop once you have a sufficient candidate:
  - `latest`: once valid highest observed in short window.
  - versioned immutable record: first valid value is enough.
  - bucket store: first valid store that meets minimum freshness criteria.

Touchpoints:
- `src/core/lib/group/group-offline-manager.ts:getLatestStore`
- `src/core/lib/group/group-offline-manager.ts:getVersionMeta`
- `src/core/lib/group/group-responder.ts:fetchLatestGroupInfoRecord`
- `src/core/lib/group/group-responder.ts:fetchVersionedGroupInfoRecord`

## 4) Bounded Parallelism for Independent Reads

Status:
- Already used in some paths (`GROUP_ROTATION_IO_CONCURRENCY = 5`, responder version-range fetch concurrency 5).

Action:
- Keep concurrency at 5 for independent bucket/versioned fetches.
- Do not exceed 5 by default on Tor; higher often increases contention and timeout noise.

Touchpoints:
- `src/core/lib/group/group-offline-manager.ts` sender bucket scan map
- `src/core/lib/group/group-responder.ts:fetchVersionedRecordsRange(..., concurrency=5)`

## 5) Prefer Warm Local Data Before DHT

Status:
- Local mirrors and caches already exist.

Action:
- Ensure every read path checks local cache/mirror first before DHT.
- Increase local cache TTL moderately for Tor-heavy usage if memory allows.

Current constants:
- `GROUP_OFFLINE_LOCAL_CACHE_TTL_MS = 5 * 60 * 1000`
- `GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES = 256`

Possible tuning (optional):
- TTL to `10 min`
- max entries to `512`

Risk:
- More memory usage; stale cache risk is acceptable because DHT merges/versioning still guard correctness.

## 6) Connectivity Gate Before Heavy Check Cycle

Why:
- Running heavy checks with 0-1 unstable peers wastes time and creates noisy failures.

Action:
- For background cycles, require minimum connected peers (for example `>= 2`) before broad check pass.
- Manual "Check missed messages" can bypass this gate.

Touchpoints:
- startup/background check orchestration in `src/ui/pages/Main.tsx`
- group/offline managers that schedule cycle checks

## 7) Keep Logging Structured and Actionable

Action:
- Keep and use current tags:
  - `[GROUP-OFFLINE][TIMING][STORE|META|CHAT|RUN]`
  - `[GROUP-INFO][SYNC][START|FETCH_PLAN|OK|CHAIN_FAIL|SKIP]`
  - `[GROUP-INFO][ITEM][START|DONE|RETRY_SCHEDULED]`
- Add one explicit flag where applicable:
  - `reason=deadline_exceeded`
  - `reason=no_connected_peers`

## Suggested Two-Day Execution

Day 1:
1. Add bounded `dht.get` helper with deadline.
2. Integrate helper in `getLatestStore` and `getVersionMeta`.
3. Add deadline reason logs.

Day 2:
1. Integrate helper in responder group-info fetch methods.
2. Add peer-count gate for background-only cycles.
3. Run before/after timing comparison with existing `[TIMING]` logs.

## Success Metrics

Track from logs:
1. p95 `storeFetchMs` and `metaMs` in `[GROUP-OFFLINE][TIMING][CHAT:*]`.
2. Number of `dht_get_failed` / `deadline_exceeded` events.
3. Total startup catch-up time for N groups.

Target:
- Reduce p95 per-bucket read from ~30s to low single-digit seconds in healthy periods.
- Keep correctness behavior unchanged (no missing-message regressions).

## Non-Goals

Not part of this pass:
- Reworking protocol format.
- Replacing Tor transport.
- Relaxing chain/signature verification rules.
