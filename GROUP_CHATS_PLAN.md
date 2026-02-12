# Group Chats Plan (Simple V1)

## Goal
Implement group chats with a simple, secure, and practical model on top of existing pairwise offline buckets.

V1 assumptions:
- Creator-managed groups (single admin model).
- Small groups (max 8-10 members).
- Correctness and maintainability first.

## Main Model
1. Invites and invite responses are pairwise (creator <-> user), not shared.
2. Group chat messages use sender-owned offline buckets.
3. Membership changes always rotate key version.
4. Creator can be offline; membership updates wait until creator is online.
5. Invite responses are kept alive with ACK-based re-publish by both creator and responder.

## Simple Terms
- `keyVersion`: version of the active group encryption key.
- Membership change: join, leave, kick.
- Rule: every membership change increments `keyVersion` and creates new key material.

## State Names
- `invited_pending`
- `awaiting_activation` (accepted, waiting for creator to deliver keys)
- `active`
- `rekeying`
- `left`
- `removed`
- `invite_expired`

## Invitation Flow
1. Creator creates local group state with `groupId`, `keyVersion=1`, and invite list.
2. Creator sends signed `GROUP_INVITE` to each invited user via pairwise offline bucket (or direct stream if online).
3. User sends signed `GROUP_INVITE_RESPONSE` (`accept` or `reject`) to creator via pairwise bucket.
4. Creator processes response; if valid and accepted, creator first rotates the group key
   (incrementing `keyVersion`), then sends signed `GROUP_WELCOME` with the **new** key to
   the joiner and `GROUP_STATE_UPDATE` with the new key to existing members.
   The new member never receives any key that predates their membership.
5. User transitions `awaiting_activation -> active` only after valid `GROUP_WELCOME`.

## Invite Expiry and Response Persistence
We explicitly keep V1 simple and do not attempt cryptographic proof of
"accepted before expiry while creator was offline."

Rules:
1. `GROUP_INVITE` includes creator-signed `createdAt`, `expiresAt`, `inviteId`.
2. Default invite lifetime is long: 14 days.
3. Creator validates on creator processing time (`now`), not responder-provided timestamp.
4. Responder timestamp is informational only.
5. Response acceptance uses ACK lifecycle:
   - Responder publishes signed `GROUP_INVITE_RESPONSE`.
   - Creator sends signed `GROUP_INVITE_RESPONSE_ACK` after processing it.
6. Until ACK arrives (or invite expires), both responder and creator re-publish
   the exact same signed response periodically (jittered interval, e.g. 6-12h).

## ACK Scope for Control Messages
ACK-based re-publish applies to **key-bearing control messages** where missing
delivery is unrecoverable:
- `GROUP_INVITE_RESPONSE` (invite flow, already described above)
- `GROUP_WELCOME` (carries symmetric key + roster — member cannot join without it)
- `GROUP_STATE_UPDATE` (carries new key material after rotation — member is locked out without it)

Creator re-publishes these to the recipient's pairwise offline bucket until ACK
is received. Timeout policy:
- `GROUP_INVITE_RESPONSE`: re-publish until ACK or invite expiry (14 days).
- `GROUP_WELCOME`, `GROUP_STATE_UPDATE`: **no timeout** — re-publish indefinitely
  until ACK is received or the member is removed/group is disbanded. These carry
  key material without which the member is permanently locked out.

ACK is **not required** for:
- `GROUP_KICK` (informational — kicked user is already locked out by key rotation)
- `GROUP_LEAVE_REQUEST` (best-effort — user has already left locally)

### ACK Re-publish Guardrails

**Retry interval and backoff:**
- First re-publish: immediately on login (or on first send).
- Subsequent re-publishes: every 30 minutes with jitter (25-35 min uniform random).
- No exponential backoff — the interval stays constant. Rationale: DHT records expire on
  a fixed schedule regardless of how many times they've been re-published, so backing off
  increases the chance of record loss. The cost of a DHT PUT every 30 min per pending ACK
  is negligible.

**Cleanup triggers (what stops the re-publish loop):**
1. **ACK received**: normal path. Remove from `group_pending_acks`, stop re-publishing.
2. **Invite expiry**: for `GROUP_INVITE_RESPONSE` only. On expiry (14 days from `createdAt`),
   remove from `group_pending_acks`. The invite is dead regardless.
3. **Member removed or left**: if the target member is kicked or leaves the group, remove
   all pending ACKs for that member. They no longer need the key material.
4. **Group disbanded**: creator disbands the group → remove all pending ACKs for that group.
5. **Superseded key version**: if the creator rotates again (new `keyVersion` N+1) while a
   `GROUP_STATE_UPDATE` for keyVersion N is still unACKed, replace the pending ACK payload
   with the newer `GROUP_STATE_UPDATE`. The member needs the latest key, not an intermediate
   one. Note: if the member was offline for multiple rotations, the latest `GROUP_STATE_UPDATE`
   should contain the current key — they don't need every intermediate key.
6. **Manual cleanup**: user can explicitly remove a group → remove all pending ACKs.

**Upper bound on pending ACKs:**
- Per group: at most `members.length - 1` pending ACKs (one per member, latest message type only).
- Per user: at most `numGroups * maxMembers` total pending ACKs. With 10 groups of 10 members,
  that is at most 90 entries — negligible storage and re-publish cost.

Consequence:
- If creator is offline past expiry, response may still be rejected in V1.
- Long expiry + periodic re-publish mitigates DHT disappearance risk.

## Idempotency and Replay
All control messages have stable IDs. Deduplicate by `messageId`.

Rules:
1. Duplicate invite with same `inviteId` is ignored.
2. Duplicate response with same `messageId` is ignored.
3. Same user sending conflicting responses: first valid response wins; later ones ignored.
4. Stale `keyVersion` updates are rejected.

## Leave Semantics
Leave is two-step:
1. Leaving user sends signed `GROUP_LEAVE_REQUEST` to creator (best effort).
2. Leaving user immediately removes local group data and unsubscribes locally.

Creator-side:
1. On processing leave request, creator rotates to next `keyVersion`.
2. Creator distributes new keys to remaining members only.

If creator is offline:
- leave request waits in creator pairwise bucket until processed.

## Kick Semantics
Kick is creator-initiated:
1. Creator rotates to next `keyVersion` and distributes new keys to remaining members only.
2. Creator sends signed `GROUP_KICK` notification to the kicked user via pairwise offline bucket.
3. Creator posts a `GROUP_STATE_UPDATE` to remaining members via pairwise offline buckets
   (canonical durable path), optionally also via GossipSub for faster delivery.
   The update includes the kick event, so it appears in group chat history.
4. Kicked user transitions to `removed` state locally.

## Key Rotation Policy
Mandatory on:
1. Join
2. Leave
3. Kick

No exceptions in V1.

## Sender Sequence Model

### Assignment
Each sender maintains a monotonically increasing sequence number **per group, per keyVersion**.
- Stored locally: `group_sender_seq` table — `(group_id, key_version)` → `next_seq INTEGER`.
- On each group message send (GossipSub or offline bucket), the sender increments `next_seq`
  and includes the value in the signed message payload as `seq`.
- `seq` starts at 1 for each new `keyVersion`. When a key rotation happens, the sender
  resets to 1 for the new keyVersion.

### Offline bucket store
The sender's offline bucket store at `/group-offline/<groupId>/<keyVersion>/<senderPubKey>`
already includes individual messages with signatures. Each message now also contains `seq`.
The store-level metadata includes `highestSeq` — the highest sequence number in the current
store. This is signed as part of the store payload.

### Rotation snapshot
When the creator initiates a key rotation, the creator records `senderSeqBoundaries` in the
new versioned group-info record. This is a map: `{ [senderPeerId]: lastValidSeq }`.

How the creator knows each sender's last sequence number:
1. **From GossipSub**: the creator tracks the highest `seq` seen from each sender in memory
   during normal message flow.
2. **From offline buckets**: at rotation time, the creator reads each sender's offline bucket
   for the current keyVersion and checks `highestSeq` in the store metadata.
3. **Final value**: `max(seen_via_gossipsub, seen_via_offline_bucket)` for each sender.

### Race condition: sender publishes message during rotation
A sender might publish a message with `seq=N+1` after the creator already snapshotted
the boundary at `seq=N`. This message would be rejected by receivers who check boundaries.

Mitigation: the creator **pauses outgoing group traffic** (stops accepting new messages
for the group) before snapshotting boundaries. The rotation flow is:
1. Creator marks group as `rekeying` locally (blocks new message sends).
2. Creator reads latest `highestSeq` from each sender's offline bucket + local GossipSub tracking.
3. Creator records `senderSeqBoundaries` in the new versioned group-info record.
4. Creator publishes new key, group-info records, and `GROUP_STATE_UPDATE` to all members.
5. Members receive update, switch to new keyVersion, reset their local `next_seq` to 1.

The window between step 2 and step 5 is the only race window. Messages sent by other
members during this window might exceed the boundary. This is acceptable because:
- The creator is the only one who initiates rotation, so they control the timing.
- Other members don't know rotation is happening until they receive the `GROUP_STATE_UPDATE`.
- If a message arrives with `seq > boundary` for the old keyVersion, receivers should
  **buffer it** rather than reject it immediately — it may be a legitimate message sent
  just before the sender received the rotation update. Apply a grace window of 60 seconds
  from when the receiver themselves processed the rotation.

## DHT Keys
### Group state (creator-owned)
`/group-info/<groupId>/<creatorSigningPubKeyB64url>/latest`

- Creator-signed latest pointer.
- Contains at least: `latestVersion`, `latestStateHash`, `lastUpdated`.
- Serves as discovery pointer for newest state.
- Others may re-publish unchanged signed value.
- **Requires version-monotonic DHT selector**: register a selector for this key namespace
  that picks the record with the highest `latestVersion` (tiebreak by `lastUpdated`).
  This mirrors the existing `offlineMessageSelector` pattern. Existing offline buckets
  are already protected by their `version` field + selector; this is the only new mutable
  DHT key that needs it.

`/group-info/<groupId>/<creatorSigningPubKeyB64url>/v/<version>`

- Immutable, creator-signed per-version state record.
- Contains at least:
  - `groupId`
  - `version`
  - `prevVersionHash`
  - `members`
  - `memberSigningPubKeys`
  - `activatedAt`
  - `usedUntil`
  - `senderSeqBoundaries` (map of senderPeerId → last valid sequence number for this keyVersion)
  - `stateHash`
- Authoritative roster and public keys are read from these versioned records.
- Re-publish trigger: each member re-publishes on login and periodically while online.

### Group offline messages (sender-owned)
`/group-offline/<groupId>/<keyVersion>/<senderSigningPubKeyB64url>`

- Validator verifies signatures with pubkey encoded in key path.
- Prevents unauthorized writes being accepted as valid sender data.

### Invite/response transport (pairwise)
Invite and response control messages use existing pairwise offline buckets between:
- creator <-> invitee

No separate invite-response DHT namespace in V1.

## State Sync and Rollback Protection
Rules:
1. Never downgrade local state version.
2. If user already has local state at version `N`, ignore incoming `latestVersion <= N`.
3. On fresh device (no local state), fetch `latest` multiple times and keep highest valid signed version seen.
4. For target version `V`, fetch `/v/<version>` records and validate chain continuity via `prevVersionHash`.
5. If chain is broken or signature invalid, do not apply that state.

## Offline Read Behavior
In group of 9 users, receiver may read up to 8 sender buckets per `keyVersion`.

Note on key version bucket checking: when a user comes online after missing multiple
membership changes, they need to check sender buckets across multiple `keyVersion` values.
Worst case: 8 senders * N key versions. In practice, most senders will have messages in
only 2-3 key versions. All fetches are parallelized. Accepted trade-off for V1.

V1 behavior:
1. Fetch sender buckets in parallel.
2. Keep per-sender cursor locally.
3. Process only unseen messages.
4. Accept message only if sender exists in roster for that `keyVersion`.
5. Accept message only if `message.timestamp <= usedUntil(keyVersion)` (with small clock-skew grace).
6. **Per-sender sequence boundary**: at key rotation, the creator records the last known
   message sequence number per sender for the old `keyVersion` in the versioned group-info
   record (`senderSeqBoundaries`). Receivers reject any message from a sender with a sequence
   number above that sender's boundary for the old keyVersion. This prevents removed members
   from publishing backdated messages with valid timestamps after being excluded.
7. Bucket cap: 50 messages per sender.

## Privacy Decision (V1)
Invite does not include full roster by default.

- User sees full roster only after accept/activation sync.
- This matches the Discord-like flow and reduces pre-accept exposure.

## Recovery Decision (V1)
Use existing DB backup/restore as primary recovery path.

- Full trustless remote reconstruction is out of scope for now.

## Security Rules
1. All group control messages are signed (Ed25519).
2. All group messages and control messages bind to `groupId`.
3. Membership enforcement is strict per `keyVersion`.
4. Replay protection via `messageId` dedupe and sequence/cursor checks.
5. Re-published responses must be byte-identical to the original signed response.
6. Versioned state records must form a valid hash-linked chain.
7. Per-sender sequence boundaries prevent backdated message injection by removed members.

## Edge Cases Covered
1. Creator sends inconsistent invites to different users (accepted trust tradeoff in V1).
2. Creator offline for long period (membership updates delayed, responses can expire).
3. Attackers attempt DHT overwrite (signature-bound validation rejects forged state).
4. Late joiner must not read old ciphertext (rotation happens before welcome, new member only gets post-join key).
5. Kicked user keeps old local history but cannot read new traffic.
6. DHT record disappearance is mitigated by ACK-based re-publish from both sides.
7. Creator permanently disappears: no membership changes possible. Accepted V1 limitation.
   `lastUpdated` in group-info enables future "stale group" detection if needed.
8. Stale rollback attempt (old valid state re-published) is rejected by version monotonic checks.
9. Removed member publishes backdated messages: rejected by per-sender sequence boundary check.

## Out of Scope (V1)
1. Multi-admin/co-admin governance.
2. Trustless invite transparency.
3. Shared multi-writer CRDT buckets.
4. Key-update migration flow.

## Implementation Order
1. Define message schemas:
   - `GROUP_INVITE`
   - `GROUP_INVITE_RESPONSE`
   - `GROUP_INVITE_RESPONSE_ACK`
   - `GROUP_WELCOME`
   - `GROUP_STATE_UPDATE`
   - `GROUP_LEAVE_REQUEST`
   - `GROUP_KICK`
2. Implement signature verification and ID dedupe.
3. Implement invite expiry checks (14-day default) using creator processing time.
4. Implement response ACK and periodic re-publish (both sides) until ACK/expiry.
5. Implement versioned group-state records (`/v/<version>`) and latest pointer updates.
6. Add local state machine transitions (`awaiting_activation`, `left`, etc.).
7. Implement mandatory key rotation path for join/leave/kick.
8. Add tests for duplicates, replay, stale keyVersion, rollback attempts, expired responses, ACK flow, and offline creator behavior.

---

## Not Directly Group Related Improvement

### Aggressive DHT Re-publishing
During group chat design, we identified that the best defense against stale DHT record
attacks (where a malicious node re-publishes an old valid signed record) is frequent
re-publishing by both the record owner AND interested recipients.

**Proposed change (applies to ALL DHT records, not just group):**
1. **Owner re-publishes** all their mutable DHT records on login and periodically
   while online (every 30 minutes with jitter).
2. **Recipient re-publishes** DHT records they care about on login and periodically
   while online (every 30 minutes with jitter). Recipients re-publish the exact
   signed bytes they last fetched — they cannot modify the record, only refresh it.

This increases DHT record availability and makes it harder for stale records to
win over fresh ones, since more nodes will hold the latest version. Combined with
version-monotonic selectors, this provides strong (though not absolute) protection
against rollback attacks.

**Applies to:**
- Pairwise offline buckets (owner = sender, recipient = receiver)
- Group-info `/latest` pointer (owner = creator, recipients = all members)
- Group-info `/v/<N>` records (owner = creator, recipients = all members)
- Group offline buckets (owner = sender, recipients = all group members)
- Username registry records, notification buckets, etc.

---

## Implementation Plan

### Phase 1: Message Schemas and Types

**Goal:** Define all group control message types and the group state structures.

**New file:** `src/core/lib/group/types.ts`

Define TypeScript interfaces for:
- `GroupInvite` — `groupId`, `groupName`, `inviter` (peerId), `inviteId`, `createdAt`, `expiresAt`, `signature`. See [Invitation Flow](#invitation-flow).
- `GroupInviteResponse` — `groupId`, `inviteId`, `messageId`, `responderPeerId`, `response` (accept/reject), `timestamp`, `signature`.
- `GroupInviteResponseAck` — `groupId`, `inviteId`, `messageId`, `signature`.
- `GroupWelcome` — `groupId`, `keyVersion`, `encryptedGroupKey` (RSA-encrypted per recipient), `roster` (current member list with signing pubkeys), `groupInfoLatestPointer` (DHT key), `signature`. See [ACK Scope](#ack-scope-for-control-messages).
- `GroupStateUpdate` — `groupId`, `keyVersion`, `encryptedGroupKey`, `roster`, `event` (join/leave/kick + target peerId), `signature`. See [ACK Scope](#ack-scope-for-control-messages).
- `GroupLeaveRequest` — `groupId`, `peerId`, `messageId`, `timestamp`, `signature`. See [Leave Semantics](#leave-semantics).
- `GroupKick` — `groupId`, `kickedPeerId`, `messageId`, `timestamp`, `signature`. See [Kick Semantics](#kick-semantics).
- `GroupInfoLatest` — `groupId`, `latestVersion`, `latestStateHash`, `lastUpdated`, `creatorSignature`. See [DHT Keys > Group state](#group-state-creator-owned).
- `GroupInfoVersioned` — `groupId`, `version`, `prevVersionHash`, `members`, `memberSigningPubKeys`, `activatedAt`, `usedUntil`, `senderSeqBoundaries` (map of peerId → last valid seq for this keyVersion), `stateHash`, `creatorSignature`. See [DHT Keys > Group state](#group-state-creator-owned) and [Sender Sequence Model](#sender-sequence-model).
- `GroupState` (local) — `groupId`, `status` (one of the [State Names](#state-names)), `keyVersion`, `groupKey`, `roster`, `creatorPeerId`.

Define a `GROUP_MESSAGE_TYPES` enum to tag messages in pairwise offline buckets so the
receiver can distinguish group control messages from regular DMs.

---

### Phase 2: Database Schema

**Goal:** Extend the database to store group state, key history, and offline cursors.

**File:** `src/core/lib/db/database.ts`

New tables:
- `group_key_history` — `group_id`, `key_epoch` (= keyVersion), `encrypted_key` (encrypted at rest with user's password-derived key), `created_at`. Unique on `(group_id, key_epoch)`. Needed to decrypt offline messages from older key versions.
- `group_offline_cursors` — `group_id`, `sender_peer_id`, `last_read_timestamp`, `last_read_message_id`, `updated_at`. Primary key `(group_id, sender_peer_id)`. See [Offline Read Behavior](#offline-read-behavior).
- `group_pending_acks` — `group_id`, `target_peer_id`, `message_type` (WELCOME/STATE_UPDATE/INVITE_RESPONSE), `message_payload` (the signed bytes to re-publish), `created_at`, `last_published_at`. Used by the ACK re-publish loop. See [ACK Scope](#ack-scope-for-control-messages) and [ACK Re-publish Guardrails](#ack-re-publish-guardrails).
- `group_sender_seq` — `group_id`, `key_version`, `next_seq INTEGER DEFAULT 1`. Primary key `(group_id, key_version)`. Tracks sender's own monotonic sequence number per group per keyVersion. See [Sender Sequence Model](#sender-sequence-model).

Schema changes to existing tables:
- `chats` — add `key_epoch INTEGER DEFAULT 0`, `group_creator_peer_id TEXT`, `group_info_dht_key TEXT`.
- `chat_participants` — already exists with `chat_id`, `peer_id`, `role`. Reuse as-is for group rosters.
- `notifications` — already exists. Reuse for group invite notifications with `notification_type = 'group_invite'`.

New DB query methods:
- `insertGroupKeyHistory(groupId, keyEpoch, encryptedKey)`
- `getGroupKeyForEpoch(groupId, keyEpoch)` — returns decrypted key for a specific version
- `upsertGroupOfflineCursor(groupId, senderPeerId, timestamp, messageId)`
- `getGroupOfflineCursor(groupId, senderPeerId)`
- `insertPendingAck(groupId, targetPeerId, messageType, payload)`
- `removePendingAck(groupId, targetPeerId, messageType)`
- `getAllPendingAcks()` — for the re-publish loop on login

---

### Phase 3: DHT Validators, Selectors, and Re-publishing

**Goal:** Register DHT infrastructure for group buckets and the group-info pointer. Also implement aggressive re-publishing for ALL DHT records (not just group).

**New file:** `src/core/lib/group/group-dht-validator.ts`

- `groupOfflineMessageValidator(key, value)` — validates `/group-offline/<groupId>/<keyVersion>/<senderPubKey>` writes. Same pattern as `offlineMessageValidator`: extract sender pubkey from key path, verify store signature, verify individual message signatures. Reference: [DHT Keys > Group offline messages](#group-offline-messages-sender-owned).
- `groupOfflineMessageSelector(key, records[])` — picks highest `version`, tiebreak by `last_updated`. Same logic as `offlineMessageSelector`.
- `groupInfoLatestValidator(key, value)` — validates `/group-info/<groupId>/<creatorPubKey>/latest` writes. Extracts creator pubkey from key path, verifies creator signature over the payload.
- `groupInfoLatestSelector(key, records[])` — **version-monotonic**: picks record with highest `latestVersion`, tiebreak by `lastUpdated`. See [DHT Keys > Group state](#group-state-creator-owned).
- `groupInfoVersionedValidator(key, value)` — validates `/group-info/<groupId>/<creatorPubKey>/v/<version>` writes. Verifies creator signature and that `version` in the payload matches the version in the key path.

**File:** `src/core/lib/node-setup.ts`

Register new validators and selectors alongside the existing `kiyeovo-offline` ones:
```
validators: {
  'kiyeovo-offline': offlineMessageValidator,
  'kiyeovo-group-offline': groupOfflineMessageValidator,
  'kiyeovo-group-info-latest': groupInfoLatestValidator,
  'kiyeovo-group-info-v': groupInfoVersionedValidator,
}
selectors: {
  'kiyeovo-offline': offlineMessageSelector,
  'kiyeovo-group-offline': groupOfflineMessageSelector,
  'kiyeovo-group-info-latest': groupInfoLatestSelector,
}
```

**New file:** `src/core/lib/dht-republisher.ts`

Aggressive DHT re-publishing service (applies to ALL DHT records, see [Not Directly Group Related Improvement](#not-directly-group-related-improvement)):
- On login: re-publish all mutable DHT records the user owns (pairwise offline buckets, group offline buckets, group-info records if creator) AND all records the user is a recipient of (other users' offline buckets for them, group-info records for groups they're in).
- While online: re-publish every 30 minutes with jitter (25-35 min random).
- Re-publishes use the exact signed bytes last stored/fetched — no re-signing needed for records owned by others.
- Tracks what to re-publish via a local registry (list of DHT keys + last raw bytes fetched).

---

### Phase 4: Invite Flow (Creator Side)

**Goal:** Creator can create a group, send invitations, process responses, and send GROUP_WELCOME.

**New file:** `src/core/lib/group/group-creator.ts`

Methods:
- `createGroup(groupName, invitedPeerIds)` — generates `groupId` (UUID), creates local group state with `keyVersion=1`, `status=invited_pending`. Stores in `chats` table with `type='group'`. See [Invitation Flow](#invitation-flow) step 1.
- `sendGroupInvites(groupId)` — for each invitee, constructs signed `GroupInvite`, delivers via pairwise offline bucket (reuse `OfflineMessageManager.storeOfflineMessage`) or direct stream if online. See [Invitation Flow](#invitation-flow) steps 2-3. Stores each invite in `group_pending_acks` for re-publish.
- `processInviteResponse(response: GroupInviteResponse)` — validates signature, checks `inviteId` matches, checks expiry using creator's `now` (see [Invite Expiry](#invite-expiry-and-response-persistence) rule 3), deduplicates by `messageId` (see [Idempotency](#idempotency-and-replay)). If accepted: sends `GroupInviteResponseAck`, marks user as accepted locally, calls `sendGroupWelcome()`. If rejected: marks user as rejected, sends ACK.
- `sendGroupWelcome(groupId, acceptedPeerId)` — first calls `rotateGroupKey` to generate new key and increment `keyVersion`. Then RSA-encrypts the **new** key for the joiner using their offline public key, constructs `GroupWelcome` with current roster. Delivers via pairwise offline bucket. Stores in `group_pending_acks` for ACK re-publish (no timeout — re-publish indefinitely until ACK). Also publishes group-info DHT records (both `/latest` and `/v/<newVersion>`). Sends `GroupStateUpdate` with the new key to existing members. Stores key in `group_key_history`. The new member never receives any key that predates their join.

---

### Phase 5: Invite Flow (Responder Side)

**Goal:** Invited user can see, accept/reject invitations, and activate after receiving GROUP_WELCOME.

**New file:** `src/core/lib/group/group-responder.ts`

Methods:
- `handleGroupInvite(invite: GroupInvite)` — validates creator signature, checks creator is a known contact in local DB, checks not blocked, checks `expiresAt` is in the future. Creates local group state with `status=invited_pending`. Shows notification in UI. See [Invitation Flow](#invitation-flow) step 2.
- `respondToInvite(groupId, accept: boolean)` — constructs signed `GroupInviteResponse`, delivers via pairwise offline bucket to creator. If accepted, transitions local state to `awaiting_activation`. Stores response in `group_pending_acks` for re-publish until ACK. See [Invite Expiry](#invite-expiry-and-response-persistence) rules 5-6.
- `handleInviteResponseAck(ack: GroupInviteResponseAck)` — removes from `group_pending_acks`, stops re-publishing.
- `handleGroupWelcome(welcome: GroupWelcome)` — validates creator signature, decrypts group key with own RSA private key, stores key in `group_key_history`, saves roster to `chat_participants`, transitions to `status=active`. Subscribes to GossipSub topic. Sends ACK back to creator. See [Invitation Flow](#invitation-flow) step 5.

---

### Phase 6: GossipSub Group Messaging

**Goal:** Active group members can send and receive real-time messages via GossipSub.

**New file:** `src/core/lib/group/group-messaging.ts`

- Topic derivation: `SHA256(groupId + SHA256(groupKey))` encoded as hex. Topic changes on every key rotation.
- `subscribeToGroupTopic(groupId)` — subscribe to GossipSub topic for current keyVersion. Unsubscribe from old topic if rotating.
- `sendGroupMessage(groupId, content)` — increment `next_seq` from `group_sender_seq` table, encrypt with group symmetric key (XChaCha20-Poly1305), sign with Ed25519, publish to GossipSub topic. Include `groupId`, `keyVersion`, `senderId`, `messageId`, `timestamp`, `seq` in signed payload. See [Sender Sequence Model](#sender-sequence-model).
- `handleGroupMessage(msg)` — verify sender signature using signing pubkey from local roster (look up in `chat_participants` first, NOT DHT). Verify sender is in roster for current `keyVersion`. Decrypt, deduplicate by `messageId`, store in `messages` table.
- Keep-alive: signed heartbeat every 90 seconds on each active group topic. Doubles as presence info (track who's online).

**File:** `src/core/lib/message-handler.ts`

Add group message routing: when a GossipSub message arrives, check topic against known group topics, route to `group-messaging.ts` handler.

---

### Phase 7: Group Offline Buckets

**Goal:** Members can send and receive group messages while some peers are offline.

**New file:** `src/core/lib/group/group-offline-manager.ts`

- `storeGroupOfflineMessage(groupId, keyVersion, message)` — writes to sender's own bucket at `/group-offline/<groupId>/<keyVersion>/<senderPubKey>`. Same store structure as pairwise offline (`OfflineMessageStoreDHT`), capped at 50 messages per sender. See [Offline Read Behavior](#offline-read-behavior).
- `checkGroupOfflineMessages(groupId)` — for each `keyVersion` the user might have missed (current and any versions since their last cursor), for each sender in the roster of that version (excluding self and creator if not a sender), fetch their bucket in parallel. Filter by local cursor (`group_offline_cursors`). Validate: sender in roster for that keyVersion, timestamp <= usedUntil(keyVersion) with clock-skew grace, and message sequence number <= sender's sequence boundary for that keyVersion (from `senderSeqBoundaries` in versioned group-info). See [Offline Read Behavior](#offline-read-behavior) rules 4-6.
- `cleanupExpiredBuckets(groupId)` — remove local cursor entries for key versions that are no longer relevant.

**Integrate with Phase 3:** The DHT re-publisher (`dht-republisher.ts`) must also track and re-publish
group offline buckets that the user reads from. When `checkGroupOfflineMessages` fetches a sender's
bucket, cache the raw bytes so the re-publisher can refresh them periodically.

---

### Phase 8: ACK Re-publish Loop

**Goal:** Ensure key-bearing control messages survive DHT record expiration.

**New file:** `src/core/lib/group/group-ack-manager.ts`

- `startAckLoop()` — on login, load all entries from `group_pending_acks`. For each, re-publish the stored signed bytes to the target's pairwise offline bucket. Schedule next re-publish at 30 min with jitter (25-35 min uniform random). No exponential backoff. See [ACK Scope](#ack-scope-for-control-messages) and [ACK Re-publish Guardrails](#ack-re-publish-guardrails).
- `onAckReceived(groupId, targetPeerId, messageType)` — remove from `group_pending_acks`, stop re-publishing for that entry.
- `onInviteExpired(groupId)` — remove all invite-related pending ACKs for that group.
- `onMemberRemoved(groupId, peerId)` — remove all pending ACKs for that member (they no longer need key material).
- `onGroupDisbanded(groupId)` — remove all pending ACKs for that group.
- `onKeyRotation(groupId, newKeyVersion)` — for any unACKed `GROUP_STATE_UPDATE` for this group, replace the payload with the latest `GROUP_STATE_UPDATE` (member needs the current key, not intermediate ones). See [ACK Re-publish Guardrails](#ack-re-publish-guardrails) cleanup trigger 5.

Timeout policy:
- `GROUP_INVITE_RESPONSE`: re-publish until ACK or invite expiry (14 days).
- `GROUP_WELCOME`, `GROUP_STATE_UPDATE`: no timeout — re-publish indefinitely until ACK or cleanup trigger fires (member removed, group disbanded, superseded by newer rotation).

Upper bound: at most `(members - 1)` pending ACKs per group, latest message type only.
With 10 groups of 10 members max, that is at most 90 entries total.

Applies to: `GROUP_INVITE_RESPONSE`, `GROUP_WELCOME`, `GROUP_STATE_UPDATE`.
Does NOT apply to: `GROUP_KICK`, `GROUP_LEAVE_REQUEST`.

---

### Phase 9: Key Rotation (Join/Leave/Kick)

**Goal:** Mandatory key rotation on every membership change.

**File:** `src/core/lib/group/group-creator.ts` (extend)

- `rotateGroupKey(groupId, newRoster)` — follows the rotation flow from [Sender Sequence Model > Rotation snapshot](#rotation-snapshot):
  1. Mark group as `rekeying` locally (blocks new outgoing messages).
  2. Snapshot `senderSeqBoundaries`: for each sender, `max(seen_via_gossipsub, seen_via_offline_bucket)`.
  3. Generate new symmetric key, increment `keyVersion`.
  4. RSA-encrypt new key for each member in `newRoster`.
  5. Construct `GroupStateUpdate` with event info (who joined/left/was kicked).
  6. Deliver via pairwise offline bucket to each member (with ACK re-publish, no timeout). Call `onKeyRotation` on ACK manager to supersede any unACKed older `GROUP_STATE_UPDATE`.
  7. Publish new `/group-info/.../v/<newVersion>` (including `senderSeqBoundaries`) and update `/group-info/.../latest`.
  8. Set `usedUntil` on previous version record. Store new key in `group_key_history`.
  See [Key Rotation Policy](#key-rotation-policy).

**File:** `src/core/lib/group/group-responder.ts` (extend)

- `handleGroupStateUpdate(update: GroupStateUpdate)` — validates creator signature, validates `keyVersion > localKeyVersion` (see [State Sync](#state-sync-and-rollback-protection) rule 2), decrypts new key, updates local roster, stores key in `group_key_history`, re-subscribes to new GossipSub topic, sends ACK to creator. Fetches new versioned group-info record from DHT and validates hash chain (rule 4).

Specific flows:
- **Join:** creator calls `rotateGroupKey` **first**, then sends `GroupWelcome` with the new key to the joiner and `GroupStateUpdate` to existing members. The new member never receives a pre-rotation key.
- **Leave:** creator calls `rotateGroupKey` after processing `GroupLeaveRequest`. Departed user not in new roster. See [Leave Semantics](#leave-semantics).
- **Kick:** creator calls `rotateGroupKey` excluding kicked user. Creator sends `GroupKick` to kicked user (no ACK needed). Remaining members get `GroupStateUpdate` with event=kick. See [Kick Semantics](#kick-semantics).

---

### Phase 10: Leave and Kick Handlers

**Goal:** Clean leave and kick flows.

**File:** `src/core/lib/group/group-responder.ts` (extend)

- `leaveGroup(groupId)` — sends signed `GroupLeaveRequest` to creator via pairwise bucket. Immediately unsubscribes from GossipSub topic, sets local state to `left`, removes group key from memory (keep in `group_key_history` for old message display). See [Leave Semantics](#leave-semantics).
- `handleGroupKick(kick: GroupKick)` — validates creator signature, transitions to `removed`, unsubscribes from GossipSub topic, removes group key from memory. See [Kick Semantics](#kick-semantics).

**File:** `src/core/lib/group/group-creator.ts` (extend)

- `processLeaveRequest(request: GroupLeaveRequest)` — validates signature, validates sender is in roster, calls `rotateGroupKey`.
- `kickMember(groupId, peerId)` — sends `GroupKick` to target via pairwise bucket, calls `rotateGroupKey` excluding target, sends `GroupStateUpdate` to remaining members.

---

### Phase 11: State Machine and Local Transitions

**Goal:** Enforce valid state transitions locally.

**New file:** `src/core/lib/group/group-state-machine.ts`

Valid transitions:
```
invited_pending  → awaiting_activation  (on accept)
invited_pending  → invite_expired       (on expiry)
awaiting_activation → active            (on GROUP_WELCOME received)
active           → rekeying             (on GROUP_STATE_UPDATE received, awaiting new key)
rekeying         → active               (on new key applied)
active           → left                 (on voluntary leave)
active           → removed              (on GROUP_KICK received)
```

- `transitionGroupState(groupId, from, to)` — validates the transition is allowed, updates `chats` table, emits event to UI.
- Any transition not in the allowed set throws an error and is logged.

---

### Phase 12: Versioned Group-Info DHT Records

**Goal:** Publish and validate the hash-linked chain of group state versions.

**File:** `src/core/lib/group/group-creator.ts` (extend)

- `publishGroupInfoVersion(groupId, version, members, memberPubKeys, activatedAt, usedUntil, prevVersionHash)` — constructs `GroupInfoVersioned`, computes `stateHash = SHA256(JSON(payload))`, signs with creator key, publishes to `/group-info/<groupId>/<creatorPubKey>/v/<version>`.
- `updateGroupInfoLatest(groupId, latestVersion, latestStateHash)` — constructs `GroupInfoLatest` with `lastUpdated = now`, signs, publishes to `/group-info/<groupId>/<creatorPubKey>/latest`.

**File:** `src/core/lib/group/group-responder.ts` (extend)

- `syncGroupState(groupId)` — fetches `/latest`, compares with local version. If remote is higher, fetches `/v/<N>` records from local version+1 to remote version, validates `prevVersionHash` chain continuity (see [State Sync](#state-sync-and-rollback-protection) rules 4-5). Updates local state if valid.

---

### Phase 13: Tests

Comprehensive tests for:
- Message schema validation and signature verification
- ID deduplication (see [Idempotency](#idempotency-and-replay))
- Invite expiry using creator processing time (see [Invite Expiry](#invite-expiry-and-response-persistence) rule 3)
- Stale `keyVersion` rejection (see [State Sync](#state-sync-and-rollback-protection) rule 2)
- Rollback attempts: old valid group-info re-published → rejected by version-monotonic selector
- ACK re-publish loop: message persists until ACK received
- Offline creator: response waits in bucket, re-published periodically
- Key rotation on join/leave/kick: old key cannot decrypt new messages, new key cannot decrypt old
- DHT validators: reject unsigned writes, reject wrong-sender writes, reject tampered content
- DHT selectors: pick highest version, tiebreak by timestamp
- State machine: valid transitions succeed, invalid transitions throw
- Hash chain validation: broken chain rejected, valid chain accepted
- Group offline buckets: per-sender cap at 50, cursor-based reads, roster/timestamp validation
- Sequence boundary enforcement: message above sender's boundary for old keyVersion is rejected
- Backdated message from removed member: valid timestamp but sequence above boundary → rejected
- Join flow: new member receives only post-rotation key, cannot decrypt pre-join offline messages
- ACK timeout: key-bearing messages re-published indefinitely, invite responses expire at 14 days
