# Bucket Nudge and Mitigations

## What `BUCKET_NUDGE` does

`BUCKET_NUDGE` is a best-effort real-time hint for group control traffic (invite, response ACK, welcome, control ACK).

Flow:
1. Sender first writes the control message to the pairwise offline bucket (source of truth).
2. If sender already has an active libp2p connection to that peer, sender sends a tiny `BUCKET_NUDGE` stream.
3. Receiver closes nudge stream and schedules a targeted offline check for that peer/chat.
4. Receiver waits a short propagation delay before fetch (`BUCKET_NUDGE_FETCH_DELAY_MS = 4000`).
5. If no new data was observed, receiver schedules one retry (`BUCKET_NUDGE_RETRY_DELAY_MS = 30000`).
6. If nudge is lost or peer is offline, normal offline/startup checks still deliver.

## Nudge-specific mitigations

- Existing-connections only: no force-dial just for nudge.
- Per-peer cooldown: `BUCKET_NUDGE_COOLDOWN_MS = 5000`.
- Trailing nudge coalescing: if cooldown blocks a nudge, one follow-up nudge is scheduled at cooldown end.
- Untrusted hint model: nudge carries no message payload and no bucket/group secrets.
- Receiver-side filtering: nudges from blocked peers are ignored; unknown-chat nudges are ignored.

## Delivery/durability mitigations around nudges

- Pending ACK durability: control messages are stored in `group_pending_acks` before first send.
- Republisher safety net: pending group control messages are re-published after startup delay and periodically.
  - Startup delay: `GROUP_ACK_REPUBLISH_STARTUP_DELAY = 60s`
  - Interval: `GROUP_ACK_REPUBLISH_INTERVAL = 10m` with jitter
- Invite-delivered ACK: creator can stop re-sending invites once delivery is confirmed.
- Invalid pending payload cleanup: malformed pending payloads are removed instead of retried forever.

## Critical race mitigation (recent)

To prevent lost updates when multiple operations touch the same offline bucket at once:

- Added per-bucket mutation serialization in `OfflineMessageManager`.
- Both of these now run under the same bucket lock:
  - `storeOfflineMessage(...)`
  - `clearAcknowledgedMessages(...)`

This prevents concurrent write/write and write/clear races that previously caused last-write-wins overwrite behavior.
