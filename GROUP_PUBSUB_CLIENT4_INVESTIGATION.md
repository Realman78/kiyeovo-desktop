# Group Realtime Delivery Failure on Client4 (Fast Mode)

Date: 2026-03-08  
Scope: Fast mode, group chat realtime delivery, relay-based connectivity

## Summary

Realtime group messaging fails only on `client4` (the only client on a different physical PC/network).  
Group messages from `client4` consistently fall back to offline buckets with:

- `PublishError.NoPeersSubscribedToTopic`
- `subscribers=none` in diagnostics

Meanwhile, other clients (local VMs) can exchange group messages in realtime.

This happens even when:

- `client4` is the **group creator**
- topic/key version are correct
- invite/accept/activation flow succeeds
- relay connections exist

## Environment / Topology

- Clients 1/2/3: local VMs on same host/network
- Client4: separate PC and separate network
- Mode: `fast`
- Relay configured and connected
- Bootstrap connected

## Reproduction Flow (reliable)

1. `client4` offline
2. `client1` kicks `client4`
3. `client1` invites `client4` back
4. `client4` comes online, accepts invite, waits for activation
5. `client4` sends group message
6. Message goes offline (not realtime)

Also reproduced when `client4` creates the group itself.

## Expected vs Actual

Expected:

- Client4 sends group message realtime to online members.

Actual:

- `client4` send path reports no remote subscribers and falls back to offline bucket.
- Other members may still communicate realtime among themselves.

## Key Evidence from Logs

### 1) Topic/key alignment is correct

Example:

- `keyVersion=11`
- `topic=295a4e557548e65f...`
- Local subscription succeeds (`SUBSCRIBE][SKIP_ALREADY` / previously `SUCCESS`)

So this is **not** a key/version mismatch.

### 2) Client4 has peer connections, but no pubsub recipients

From client4 diagnostics:

- `connectedPeers=... qNgJUnQk,UdLkQPN2`
- `GROUP-DIAG][PUBSUB ... subscribers=none`
- `PublishError.NoPeersSubscribedToTopic`

So transport-level connectivity exists, but pubsub publish sees zero remote subscribers.

### 3) Connection-gater is not blocking

All relevant logs are:

- `[ConnectionGater][DIAG][INBOUND][ALLOW] ...`

No inbound deny reasons observed.

### 4) Stream-level signal

Per-connection diagnostics on client4 often show:

- `streams=none` (or only ping stream)

for relay/circuit connections to group peers at publish time.  
This indicates no active meshsub/pubsub stream on those links when sending.

### 5) Cross-check from another client

On client1 publish result:

- recipients include some peers
- client4 is missing from `remoteRecipients`

This matches client4 not being in effective topic mesh.

## Ruled Out

1. Username/validator/DHT key ownership issue
2. Group key version mismatch
3. Topic mismatch
4. Connection-gater deny/block mode issue

## Observed Secondary Symptom

- `Muxer closed locally` sometimes appears on direct-message attempts after failed group realtime send.
- This is intermittent and not present in all failing group runs.
- Likely related to unstable stream lifecycle after degraded connectivity path, but not primary root trigger for this bug.

## Current Best Root-Cause Hypothesis

Client4 is connected at transport level (mostly relay/circuit paths), but GossipSub mesh is not being established/maintained for group topics on client4 in this topology.  
Therefore:

- local node is subscribed
- but no remote subscribers are visible from client4’s pubsub perspective
- publish returns `NoPeersSubscribedToTopic`
- offline fallback triggers

In short: **transport connected != pubsub mesh connected** for client4.

## Why Creator Role Does Not Prevent This

Being group creator only affects authority/state flows.  
Realtime delivery still depends on active pubsub mesh links at send time.  
Creator can still get `NoPeersSubscribedToTopic` if mesh is absent.

## Diagnostics Added During Investigation

1. `GROUP-DIAG][PUBSUB` with:
   - local topic subscription state
   - `getSubscribers(topic)`
   - per-participant connection count/details
   - peerstore addresses/protocol support
   - connection stream protocols (`streams=...`)

2. `GROUP-DIAG][MESH` events:
   - `graft`
   - `prune`

3. `ConnectionGater` inbound allow/deny reason logs.

## Candidate Next Steps (for design decision)

### Option A: Keep current behavior (safe fallback)

- Accept that relay-only / cross-network nodes may be offline-bucket-first for groups.
- Keep offline fallback as primary reliability path.

### Option B: Improve realtime chance before fallback

- Add pre-publish warmup:
  - establish/refresh peer connections for group members
  - short bounded wait for pubsub mesh readiness (`getSubscribers(topic)` non-empty)
  - then publish retry

### Option C: Focus on pubsub mesh establishment over this topology

- Instrument/verify GossipSub peer set (`pubsub.getPeers()`) at send time.
- Investigate relay/DCUtR behavior for pubsub streams specifically on client4.

## Minimal Data Needed for External Review

For one failing run:

1. Client4:
   - `GROUP-MSG][SEND][CTX`
   - `GROUP-DIAG][PUBSUB phase=pre_publish`
   - `GROUP-MSG][PUBLISH][RESULT` (if present)
   - `PublishError.NoPeersSubscribedToTopic`
   - `GROUP-DIAG][PUBSUB phase=offline_fallback`

2. Another sender (client1):
   - `GROUP-MSG][PUBLISH][RESULT` for same topic/keyVersion
   - whether client4 appears in `remoteRecipients`

3. Any `GROUP-DIAG][MESH]` graft/prune lines for the same topic hash.

