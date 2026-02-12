# Group Chats: Rollback + Control Channel Notes

This file elaborates two open design points:
- Point 4: stale/rollback state handling
- Point 5: why control events should have a durable canonical path

## 1) Your Direction Is Correct
You said:
- Bob learns current version from `group-info`.
- We can add group-info history with version + roster/pubkeys + `usedUntil`.

That is the right approach.

Recommended key layout:
- Latest pointer:
  - `/group-info/<groupId>/<creatorPubKey>/latest`
- Immutable versioned records:
  - `/group-info/<groupId>/<creatorPubKey>/v/<version>`

Each `/v/<version>` record should be creator-signed and include:
- `groupId`
- `version`
- `prevVersionHash`
- `members[]`
- `memberSigningPubKeys[]`
- `activatedAt`
- `usedUntil`
- `stateHash`

`latest` should include at least:
- `latestVersion`
- `latestStateHash`
- creator signature

## 2) Point 4: What Is Rollback / Stale-State Risk?

### Scenario A (existing member)
- Bob already has local state at version 5.
- Attacker re-publishes old but valid signed `latest` for version 3.
- If Bob accepts blindly, he can switch to stale state.

Rule that prevents this:
- If `incomingVersion <= localVersion`, ignore incoming state.

### Scenario B (fresh device, no local state)
- Bob installs app on a new machine.
- DHT returns stale `latest` version 3 first.
- Real latest is version 5.

Mitigation:
1. Fetch `latest` multiple times (with short retries / from multiple peers if possible).
2. Keep highest valid signed version seen.
3. Fetch `/v/1..v/latest` chain (or at least `/v/latest` then walk backward via `prevVersionHash`).
4. Accept only if chain is consistent.

This is why immutable history records matter, not just one `/latest` object.

## 3) Why `usedUntil` Helps
You proposed `usedUntil` to stop reading old buckets after rotation. Good idea.

Use rule:
- For version `v`, accept messages only if `message.timestamp <= usedUntil(v)`.

This bounds damage from users who still know old key and try to post later messages.

Important note:
- `usedUntil` must be in creator-signed state record for that version.
- If clocks drift, include small grace window (for example 60-120s).

Optional stronger rule (later):
- Also track per-sender sequence and final accepted sequence boundary when rotating.

## 4) Point 5: Why Canonical Durable Control Channel?
You asked: "If online, send immediately; if offline, use buckets. What's wrong with that?"

Nothing is wrong with that concept. The key is defining one canonical source of truth.

Recommended split:
- Durable canonical path for control events:
  - pairwise offline buckets (creator <-> member)
- Fast path for UX latency:
  - immediate online push (direct stream and/or pubsub)

Why this matters:
- Online packet can be missed (temporary disconnect, app restart).
- Durable copy ensures eventual delivery and replay safety.

### Example: Kick event
1. Alice rotates to version 6.
2. Alice sends immediate online `GROUP_KICK` to Derek (fast path).
3. Alice also writes signed `GROUP_KICK` + new state/version info into Derek pairwise offline bucket (durable path).
4. Remaining members get `GROUP_STATE_UPDATE` via fast path and durable path.
5. Any client that missed fast path still converges by reading durable path.

So your model is good, but define it as:
- "online immediate" = optimization
- "offline bucket write" = required canonical delivery

## 5) Concrete V1 Acceptance Rules
1. Never downgrade local version.
2. Accept only creator-signed state records.
3. Validate version chain (`prevVersionHash`) for missing versions.
4. For each message, verify:
   - sender signature valid
   - sender exists in roster of that version
   - message time is within that version's `usedUntil` window
5. Control events are applied once (`messageId` dedupe).

## 6) Suggested V1 Defaults
- Offline per-sender bucket cap: 50 messages.
- Re-publish cadence: on login + every 30 minutes with jitter.
- Invite expiry: 14 days.
