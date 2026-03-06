# Phase 12 Implementation: Versioned Group-Info DHT Records

## Goal
Make group state publication and synchronization robust under partial DHT failures, while preserving rollback protection via signed, hash-linked version records.

## Scope

In scope:
- Creator-side publish hardening for:
  - `/kiyeovo-group-info-v/<groupId>/<creatorPubKey>/<version>`
  - `/kiyeovo-group-info-latest/<groupId>/<creatorPubKey>`
- Responder-side chain sync/validation behavior (latest pointer + version chain).
- Retry and observability improvements around pending group-info publishes.

Out of scope:
- Group membership behavior changes (join/leave/kick semantics stay unchanged).
- Removed chat lifecycle policy (`removed_at` usage stays outside this phase).

## Current Baseline (Already Present)

1. Creator publishes versioned + latest in:
- `src/core/lib/group/group-creator.ts` (`publishGroupInfoRecords(...)`)

2. Failed publish is queued:
- `group_pending_info_publishes` table in `src/core/lib/db/database.ts`
- Republisher in `src/core/lib/group/group-info-republisher.ts`

3. DHT validator exists for both key namespaces:
- `src/core/lib/group/group-dht-validator.ts`

4. Latest/version signature verification logic exists in code paths that consume records.

## Implementation Tasks

### 1) Creator publish contract hardening
File: `src/core/lib/group/group-creator.ts`

Work:
- Keep publish order strict:
  1. versioned record
  2. latest pointer
- Keep local side effects only after full success:
  - update local `stateHash`
  - mark previous version `used_until`
- On any failure, persist pending publish row with clear error text and next retry.

Why:
- Prevent local state advancing as "fully published" when DHT publish only partially succeeded.

### 2) Republisher deterministic behavior
File: `src/core/lib/group/group-info-republisher.ts`

Work:
- Keep prune rules for invalid/stale rows.
- Ensure retry counters and next-retry timestamps are always advanced on failure.
- Keep startup/no-peer skip behavior explicit and logged.
- Keep attempt cap behavior (`GROUP_INFO_REPUBLISH_MAX_ATTEMPTS`) unchanged unless policy change is requested.

Why:
- Guarantees eventual publish when network recovers, without infinite tight loops.

### 3) Responder sync chain validation path
Primary file: `src/core/lib/group/group-responder.ts`  
Optional extraction target: `src/core/lib/group/group-state-sync.ts`

Work:
- Add/confirm a single sync routine:
  1. fetch latest pointer
  2. if `latestVersion <= localVersion`: stop
  3. fetch missing versioned records in ascending order
  4. verify creator signatures
  5. verify `prevVersionHash` continuity end-to-end
  6. only then apply local updates
- On any chain break:
  - do not mutate local version forward
  - log reason
  - allow retry later

Why:
- Prevents rollback or partial-chain apply under inconsistent DHT visibility.

### 4) Validator/selector consistency check
File: `src/core/lib/group/group-dht-validator.ts`

Work:
- Reconfirm latest `validateUpdate` rejects stale overwrite.
- Reconfirm versioned `validateUpdate` enforces immutability (byte-identical re-publish only).
- Reconfirm key-path and signature bindings remain strict.

Why:
- This is the last safety line when conflicting values exist in DHT.

### 5) Logging and diagnostics
Files:
- `src/core/lib/group/group-creator.ts`
- `src/core/lib/group/group-info-republisher.ts`
- `src/core/lib/group/group-responder.ts` (or `group-state-sync.ts` if extracted)

Work:
- Add concise tagged logs:
  - publish start/success/failure (`groupId`, `version`)
  - republish attempt/result
  - sync chain validation result/failure reason
- Avoid noisy per-peer loops unless debug logging is already enabled.

Why:
- Faster diagnosis of "state exists locally but not in DHT" and vice versa.

## Failure Behavior (Expected)

1. Versioned publish success, latest fail:
- Pending row remains/retries.
- No local "fully published" success state.

2. Latest points to N, but version N unavailable:
- Responder does not apply partial.
- Logs and retries on next sync trigger.

3. Chain mismatch at version K:
- Responder rejects chain and keeps local state unchanged.

## Acceptance Criteria

1. Join/leave/kick still complete under normal network.
2. Temporary DHT publish failures do not corrupt local state assumptions.
3. Pending group-info publishes eventually clear once peers are reachable.
4. Responder never applies a broken hash chain.
5. No rollback to older valid-looking versions.

## Validation Checklist

Run:
- `npm run -s transpile:electron`
- `npx tsc -p tsconfig.app.json --noEmit`

Manual scenarios:
1. Force DHT failure during publish, verify pending row and later republish.
2. Simulate stale latest pointer visibility, verify no invalid local apply.
3. Simulate chain break (tampered/missing version), verify rejection path.

