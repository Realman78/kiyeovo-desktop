# Phase 9 Plan: Key Rotation (Join / Leave / Kick)

## Scope
Phase 9 implements mandatory key rotation for all membership changes, split into:
1. `9A Join`
2. `9B Leave`
3. `9C Kick`

Phase 10 remains handler-polish only.

## Final Decisions
1. Keep the strong boundary model: creator snapshots `senderSeqBoundaries` during rotation.
2. Do not replace boundaries with timestamp-only validation.
3. Use bounded concurrency (`5`) for:
   - sender-bucket reads during boundary snapshot
   - member key-distribution writes (`WELCOME`/`STATE_UPDATE`)
4. Block outgoing group sends while rotation is in progress (`rekeying`).
5. Send bucket nudge after successful control-message bucket writes.
6. Keep ACK re-publish behavior already implemented:
   - key-bearing control messages re-publish until ACK/cleanup.

## Security Invariants
1. Membership change always increments `keyVersion`.
2. New key is distributed only to new roster members.
3. Old key messages remain readable from local history; new traffic requires new key.
4. Receiver enforces:
   - roster membership for that epoch
   - `usedUntil + grace`
   - `senderSeqBoundaries` for old epoch

## Why Boundaries Are Required
Validators can reject malformed data and impossible future skew, but cannot prove true creation time for backdated messages.  
Therefore, timestamp checks are insufficient against removed-member backdated injection; sequence boundaries remain required.

## 9A: Join
### Flow
1. Creator receives valid `GROUP_INVITE_RESPONSE(accept)`.
2. Creator sets group state to `rekeying` (local send lock).
3. Creator snapshots per-sender boundary for previous epoch:
   - `max(highestSeenViaPubsub, highestSeqInSenderOfflineBucket)`
   - Read sender buckets with concurrency `5`.
4. Creator generates new key and increments `keyVersion`.
5. Creator publishes:
   - `GROUP_WELCOME` to joiner (new key only)
   - `GROUP_STATE_UPDATE(event=join)` to existing members
   - Writes in concurrency `5`.
6. Creator publishes group-info records:
   - `/v/<newVersion>` with `senderSeqBoundaries`
   - `/latest` pointer update
7. Previous epoch gets `usedUntil` set.
8. Group returns to `active`.

### Delivery/ACK
1. `GROUP_WELCOME` and `GROUP_STATE_UPDATE` inserted into `group_pending_acks` before first send.
2. ACK cleanup remains messageId-matched (already implemented).
3. After each successful pairwise bucket write, call `nudgePeer(...)` (best effort).

## 9B: Leave
### Flow
1. Member sends `GROUP_LEAVE_REQUEST`.
2. Member immediately transitions locally to `left`, unsubscribes from topic, clears active key from memory.
3. Creator processes request (when online), validates signer is current participant.
4. Creator runs the same rotation pipeline as Join, excluding leaver from new roster.
5. Remaining members receive `GROUP_STATE_UPDATE(event=leave)`.

### Cleanup
1. Remove pending ACK entries targeting the departed member.
2. Keep historical keys for old-message display only.

## 9C: Kick
### Flow
1. Creator initiates kick for target member.
2. Creator runs rotation pipeline excluding kicked member.
3. Remaining members receive `GROUP_STATE_UPDATE(event=kick)`.
4. Kicked member receives `GROUP_KICK` best effort (no ACK required).
5. Kicked member transitions locally to `removed`, unsubscribes, clears active key from memory.

### Cleanup
1. Remove pending ACK entries for kicked member.
2. Keep group history read-only on kicked side.

## Concurrency Model (Important)
Use a small worker pool with `maxConcurrency = 5` for network-heavy loops:
1. Boundary snapshot DHT bucket reads.
2. Per-member control-message distribution writes.

Failure policy:
1. Partial failures are persisted in pending ACK table and retried by republisher.
2. Rotation does not silently discard failed recipients.

## Data/Code Touchpoints
1. `src/core/lib/group/group-creator.ts`
   - extend `rotateGroupKey` pipeline
   - add bounded-concurrency helpers for reads/writes
2. `src/core/lib/group/group-responder.ts`
   - consume `GROUP_STATE_UPDATE` transitions for join/leave/kick outcomes
3. `src/core/lib/group/group-ack-republisher.ts`
   - keep as-is for key-bearing retry lifecycle
4. `src/core/lib/group/group-messaging.ts`
   - enforce send-block during `rekeying`

## Acceptance Checklist
1. Join rotates key before joiner activation; joiner cannot decrypt pre-join traffic.
2. Leave rotates key and excludes leaver from new epoch.
3. Kick rotates key and excludes kicked member from new epoch.
4. Boundary snapshot runs with concurrency `5`.
5. Distribution writes run with concurrency `5`.
6. Online recipients are nudged after control-message writes.
7. Missing recipients recover via pending ACK re-publish loop.
8. Group exits `rekeying` to `active` after rotation pipeline completion.
