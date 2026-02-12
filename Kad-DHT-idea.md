# Kad-DHT Fork: Version-Aware Validation

## The Problem

In libp2p's kad-dht, the PUT_VALUE RPC handler **blindly overwrites** stored records.

Verified against the actual source (`node_modules/@libp2p/kad-dht/src/rpc/handlers/put-value.ts`):

```typescript
// Actual PUT_VALUE handler — complete logic:
const deserializedRecord = Libp2pRecord.deserialize(msg.record)
await verifyRecord(this.validators, deserializedRecord)     // only checks signature/format
deserializedRecord.timeReceived = new Date()
const recordKey = bufferToRecordKey(this.datastorePrefix, deserializedRecord.key)
await this.components.datastore.put(recordKey, deserializedRecord.serialize().subarray())
// ^ unconditional overwrite — no comparison with existing record
```

There is:
- **No `datastore.get()` call** to check the existing record before writing.
- **No selector invocation** in the PUT path.
- **No version comparison** of any kind.

### Where Selectors Actually Run

Selectors are only used **client-side** in `ContentFetching.get()` (`src/content-fetching/index.ts`).
When a DHT client queries multiple peers, it collects responses, uses `bestRecord()` with the
selector to pick the best one, and sends corrections to peers with stale records via
`sendCorrectionRecord()`. But this is reactive — it doesn't prevent the overwrite on the
receiving node.

The PutValueHandler constructor doesn't even accept selectors:
```typescript
export interface PutValueHandlerInit {
  validators: Validators    // ← only validators
  logPrefix: string
  datastorePrefix: string
  // NO selectors field
}
```

### Why This Matters

All mutable DHT records in Kiyeovo (offline buckets, group-info pointers, group offline buckets)
are signed by their owner and include a monotonically increasing `version` field.

A **malicious user who holds a valid old signed record** can trivially overwrite newer records:

1. Attacker has a legitimately signed record at version 3 (obtained when they were a group member, or just from normal DHT participation).
2. The legitimate owner has since published version 7.
3. Attacker re-publishes version 3 aggressively — much more frequently than the legitimate owner re-publishes version 7.
4. **Every DHT node that receives the stale PUT overwrites its stored record**, even if it previously held version 7. There is no protection at all on the PUT path.
5. Over time, the majority of DHT nodes end up holding version 3. Version 7 only survives on nodes that haven't received the attacker's PUT yet.
6. The client-side selector (GET path) can still pick version 7 if at least one queried peer has it, but as more nodes are overwritten, this becomes less likely.

This is not a theoretical attack. It's straightforward to execute: just call `dht.put()` in a loop with the old signed bytes. No cryptographic break needed.

### Why Aggressive Re-publishing Alone Doesn't Solve It

The countermeasure without a fork is for the owner (and friendly recipients) to re-publish the latest record more frequently. But this is an arms race: the attacker can always re-publish faster. The attacker also has the advantage of running multiple nodes, each re-publishing independently.

## The Solution

Fork `@libp2p/kad-dht` to make the **validator version-aware** by giving it access to the existing locally stored record.

### Current Flow (unmodified, verified from source)

```
PUT_VALUE RPC arrives for key K with value V_new
  → validator(K, V_new) → valid signature/format?
    → yes → unconditionally overwrite datastore[K] = V_new
            (NO comparison with existing record, NO selector)
    → no  → reject

GET (client-side, separate path)
  → query N peers → collect responses
  → selector picks best from responses (client-side only)
  → send corrections to peers with stale records (reactive, not preventive)
```

The entire PUT path is: validate signature → overwrite. That's it.

### Proposed Flow (forked)

```
PUT arrives for key K with value V_new
  → validator(K, V_new) → valid on its own?
    → yes → is there an existing V_old for K?
      → yes → validateUpdate(K, V_old, V_new) → V_new.version >= V_old.version?
        → yes → store V_new
        → no  → reject (STALE RECORD BLOCKED)
      → no  → store V_new (no existing record, accept any valid value)
    → no → reject
```

### Where Records Are Stored Locally

Each DHT node already stores records locally via a `Datastore` (injected through libp2p's
component system). Records live at key paths like `/dht/records/<base32-encoded-key>`.

The PUT_VALUE handler (`rpc/handlers/put-value.ts`) has access to the datastore via
`this.components.datastore` but currently does NOT read from it before writing.
The actual source:

```typescript
// put-value.ts (actual source, lines 37-62)
async handle (peerId: PeerId, msg: Message): Promise<Message> {
  const key = msg.key

  if (msg.record == null) {
    throw new InvalidMessageError(`Empty record from: ${peerId.toString()}`)
  }

  try {
    const deserializedRecord = Libp2pRecord.deserialize(msg.record)
    await verifyRecord(this.validators, deserializedRecord)
    deserializedRecord.timeReceived = new Date()
    const recordKey = bufferToRecordKey(this.datastorePrefix, deserializedRecord.key)
    await this.components.datastore.put(recordKey, deserializedRecord.serialize().subarray())
    // ^ blind overwrite — no datastore.get() before this
  } catch (err: any) {
    this.log('did not put record for key %b into datastore %o', key, err)
  }

  return msg
}
```

The datastore is **right there** via `this.components.datastore`. It just isn't used for
comparison — only for the final write. No new storage mechanism is needed for the fork.

### What Changes in the DHT Code

1. Add a new optional callback: `validateUpdate(key: Uint8Array, existing: Uint8Array, incoming: Uint8Array) → Promise<void>` (throws to reject).
2. In `put-value.ts`, after the standard validator passes, the datastore lookup **already happens**. Move it slightly earlier and pass the existing record to `validateUpdate` before the selector runs.
3. If `validateUpdate` throws, reject the PUT immediately (don't even run the selector).
4. If no `validateUpdate` is registered for the key prefix, fall back to existing behavior (selector picks winner).

The concrete change in `put-value.ts`:

```typescript
// BEFORE (current — blind overwrite)
const deserializedRecord = Libp2pRecord.deserialize(msg.record)
await verifyRecord(this.validators, deserializedRecord)
deserializedRecord.timeReceived = new Date()
const recordKey = bufferToRecordKey(this.datastorePrefix, deserializedRecord.key)
await this.components.datastore.put(recordKey, deserializedRecord.serialize().subarray())

// AFTER (fork — version-aware)
const deserializedRecord = Libp2pRecord.deserialize(msg.record)
await verifyRecord(this.validators, deserializedRecord)
deserializedRecord.timeReceived = new Date()
const recordKey = bufferToRecordKey(this.datastorePrefix, deserializedRecord.key)

// NEW: check existing record before overwriting
if (this.validateUpdate != null) {
  try {
    const existingRaw = await this.components.datastore.get(recordKey)
    const existing = Libp2pRecord.deserialize(existingRaw)
    // throws if incoming version < existing version
    await this.validateUpdate(deserializedRecord.key, existing.value, deserializedRecord.value)
  } catch (err: any) {
    if (err.message === 'stale record rejected') {
      this.log('rejected stale record for %b (version too old)', key)
      return msg  // reject the PUT, keep existing record
    }
    // datastore.get threw "not found" — no existing record, continue to store
  }
}

await this.components.datastore.put(recordKey, deserializedRecord.serialize().subarray())
```

Changes needed to support this:
1. Add `validateUpdate` to `PutValueHandlerInit` interface (optional callback).
2. Store it as `this.validateUpdate` in the constructor.
3. The ~15 lines of version-check logic shown above, inserted before `datastore.put()`.

### What Kiyeovo Registers

```typescript
// For offline buckets (already have version field)
validateUpdate: {
  'kiyeovo-offline': (key, existing, incoming) => {
    const oldVersion = decode(existing).version;
    const newVersion = decode(incoming).version;
    if (newVersion < oldVersion) throw new Error('stale record rejected');
  },
  'kiyeovo-group-offline': /* same pattern */,
  'kiyeovo-group-info-latest': (key, existing, incoming) => {
    const oldVersion = decode(existing).latestVersion;
    const newVersion = decode(incoming).latestVersion;
    if (newVersion < oldVersion) throw new Error('stale record rejected');
  },
}
```

### Properties

- **Nodes that have the latest record become immune.** Without the fork, ANY node can be downgraded by a stale PUT. With the fork, once a node stores version N, it rejects all PUTs with version < N.
- **Nodes with no record still accept the first valid value they see** (could be stale). This is unavoidable — you can't compare against nothing.
- **Combined with aggressive re-publishing**, this makes the attack window very narrow: the attacker can only "win" on nodes that have never seen the latest version, and once those nodes receive the latest version via a legitimate PUT, they become permanently immune.
- **The client-side selector still helps** as a secondary defense: when a client GETs from multiple peers, it picks the best response and sends corrections. But this is reactive — the fork provides proactive protection at the storage layer.

### Maintenance Burden

The change is ~20-30 lines in the DHT's record store logic. `@libp2p/kad-dht` is a stable package that doesn't change frequently. The modification is isolated to the PUT handling path and doesn't affect routing, queries, or any other DHT behavior.

### How to Apply: patch-package (npm)

`@libp2p/kad-dht` lives inside the libp2p monorepo. No need to fork the whole repo.
Use `patch-package` to store the diff as a `.patch` file that re-applies on every `npm install`.

**One-time setup:**
```bash
npm install patch-package --save-dev
```

Add to `package.json`:
```json
{
  "scripts": {
    "postinstall": "patch-package"
  }
}
```

**Creating the patch:**
```bash
# 1. Edit the source directly in node_modules/@libp2p/kad-dht/
#    (the put-value handler — see "What Changes in the DHT Code" above)
# 2. Generate the patch file:
npx patch-package @libp2p/kad-dht
# 3. Commit the generated file: patches/@libp2p+kad-dht+<version>.patch
```

**What happens on npm install:**
1. npm installs `@libp2p/kad-dht` at whatever version is in `package-lock.json`.
2. `postinstall` runs `patch-package`.
3. `patch-package` applies `patches/@libp2p+kad-dht+<version>.patch` on top.

**When you update `@libp2p/kad-dht`:**
- If the patched lines didn't change upstream → patch applies cleanly, nothing to do.
- If the patched lines changed → `patch-package` fails at install time with a clear error.
  Re-make the patch: edit `node_modules`, run `npx patch-package @libp2p/kad-dht` again,
  commit the updated `.patch` file.

This keeps the fork to a single auditable file in the repo, and you stay on the latest
upstream version for all security updates.
