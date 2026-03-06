# Phase 12 Test Cases

This file defines manual test scenarios for Phase 12 (group-info DHT publish/sync hardening).

## Scope

Covers:
- Creator publish behavior (versioned + latest records).
- Pending republish behavior and retry scheduling.
- Responder sync behavior (missing-only fetch, chain validation, metadata backfill).
- DHT validator invariants for latest/versioned records.

Does not cover:
- Join/leave/kick feature semantics (already validated in previous phases).

## Test Setup

Use at least 3 clients:
- `Alice` (group creator)
- `Bob` (member)
- `Chad` (member)

Recommended:
- 1 bootstrap/validator node visible in logs.
- Group with multiple key rotations (>= 5 epochs) before running sync-focused tests.

## Quick DB Queries

Use these on a client DB when needed:

```sql
-- Key history for a group
SELECT group_id, key_version, state_hash, used_until
FROM group_key_history
WHERE group_id = '<GROUP_ID>'
ORDER BY key_version;

-- Pending group-info publish rows
SELECT group_id, key_version, attempts, next_retry_at, last_error
FROM group_pending_info_publishes
WHERE group_id = '<GROUP_ID>'
ORDER BY key_version;

-- Chat state
SELECT id, group_id, key_version, group_status, group_info_dht_key
FROM chats
WHERE group_id = '<GROUP_ID>';
```

## Scenario 1: Normal publish path succeeds

Steps:
1. Alice performs membership change (join/leave/kick) to trigger key rotation.
2. Keep network healthy (peers connected).

Expected:
1. Alice logs:
   - `[GROUP-INFO][PUBLISH][START]`
   - `[GROUP-INFO][PUBLISH][VERSIONED_OK]`
   - `[GROUP-INFO][PUBLISH][LATEST_OK]`
   - `[GROUP-INFO][PUBLISH][DONE]`
2. No row remains in `group_pending_info_publishes` for that `(group_id, key_version)`.
3. In `group_key_history` on Alice:
   - current epoch has non-null `state_hash`
   - previous epoch has non-null `used_until`

## Scenario 2: Publish failure queues pending retry

Steps:
1. Temporarily isolate Alice from DHT peers (or force DHT put failure).
2. Trigger rotation on Alice.

Expected:
1. Alice logs:
   - `[GROUP-INFO][PUBLISH][FAIL]`
   - `[GROUP-INFO][PUBLISH][QUEUED_RETRY]`
2. New row appears in `group_pending_info_publishes` with:
   - `attempts = 0` initially
   - `last_error` populated
3. Creator flow still completes membership change (no crash).

## Scenario 3: Republisher retries and clears pending row

Steps:
1. Start from Scenario 2 queued row.
2. Restore Alice connectivity.
3. Wait for republisher cycle.

Expected:
1. Logs show:
   - `[GROUP-INFO][CYCLE][START]`
   - `[GROUP-INFO][ITEM][START] ... attempt=X/Y`
   - `[GROUP-INFO][ITEM][DONE] ... attempt=X/Y`
   - `[GROUP-INFO][CYCLE][DONE]`
2. Pending row is deleted from `group_pending_info_publishes`.
3. `group_key_history.state_hash` / `used_until` are present as expected.

## Scenario 4: Republisher schedules retries with jittered delay

Steps:
1. Keep a pending row unrecoverable for at least one cycle.
2. Let republisher attempt and fail.

Expected:
1. Log line:
   - `[GROUP-INFO][ITEM][RETRY_SCHEDULED] ... nextRetryInMs=... attempt=...`
2. `attempts` increments.
3. `next_retry_at` advances.
4. Delay is around configured base/steady delay with jitter (not constant exact same value each time).

## Scenario 5: Attempt-cap pruning

Steps:
1. Keep a pending row failing until attempts reach max cap.
2. Run cycles until cap is hit.

Expected:
1. Republisher logs:
   - `[GROUP-INFO][ITEM][REMOVE] ... reason=attempt_cap`
2. Row is removed from `group_pending_info_publishes`.
3. No further retries for that row.

## Scenario 6: Responder sync skips when already synced

Steps:
1. Ensure Bob has full `state_hash` and `used_until` backfilled locally for `<= local key_version`.
2. Trigger a control message handling path that calls sync (WELCOME/STATE_UPDATE duplicate is enough).

Expected:
1. Bob logs:
   - `[GROUP-INFO][SYNC][SKIP] ... reason=already_synced`
2. No additional DHT fetch activity for versioned records.

## Scenario 7: Missing-only sync fetches bounded range

Steps:
1. On Bob, clear `state_hash`/`used_until` only for a subset of old local epochs (for example epochs 4-5).
2. Trigger sync path via WELCOME/STATE_UPDATE processing.

Expected:
1. Bob logs:
   - `[GROUP-INFO][SYNC][START] ... missingEpochs=...`
   - `[GROUP-INFO][SYNC][FETCH_PLAN] ... fetchRange=4-5 concurrency=5` (or 1-based with anchor fallback)
   - `[GROUP-INFO][SYNC][OK] ... fetchRange=...`
2. Cleared epochs are backfilled.
3. Epochs outside range are not unnecessarily re-fetched.

## Scenario 8: Chain-break rejection (safety)

Steps:
1. Create a tampered/missing versioned record in DHT view (or simulate missing record for one version).
2. Trigger responder sync.

Expected:
1. Bob logs one of:
   - `[GROUP-INFO][SYNC][CHAIN_FAIL] ... reason=missing_versioned_record`
   - `[GROUP-INFO][SYNC][CHAIN_FAIL] ... reason=prev_hash_mismatch`
   - `[GROUP-INFO][SYNC][CHAIN_FAIL] ... reason=latest_state_hash_mismatch`
2. Bob local `chat.key_version` is unchanged by this DHT sync path.
3. No partial metadata corruption is observed.

## Scenario 9: Latest stale update rejected by validator

Steps:
1. Attempt to write a `group-info-latest` record with:
   - lower `latestVersion`, or
   - same `latestVersion` + different `latestStateHash`, or
   - same version/hash but older `lastUpdated`.

Expected:
1. Validator rejects write with stale error.
2. Existing latest record remains authoritative.

## Scenario 10: Versioned immutability enforced

Steps:
1. Attempt to overwrite an existing versioned key with any non-byte-identical payload.

Expected:
1. Validator rejects with stale error.
2. Only byte-identical re-publish is accepted.

## Scenario 11: Performance sanity on high-epoch group

Steps:
1. Use a group with many rotations (for example 30-50 epochs).
2. Ensure responder is already synced.
3. Trigger sync call path.

Expected:
1. Immediate skip log:
   - `[GROUP-INFO][SYNC][SKIP] ... reason=already_synced`
2. No long sequential fetch behavior from epoch 1 to latest.

## Scenario 12: Regression check (core chat still works)

Steps:
1. Run a normal join, then send messages in real-time.
2. Run a leave or kick, then send/fetch as expected.

Expected:
1. Group messaging behavior remains unchanged.
2. Phase 12 logs appear, but no functional regressions in chat flow.

---

## Pass Criteria

Phase 12 is considered validated when:
1. Scenarios 1-4 and 6-8 pass.
2. Validator safety scenarios 9-10 pass.
3. No chat-flow regression in Scenario 12.
