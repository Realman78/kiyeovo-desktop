# Kad-DHT Fork: Version-Aware Validation

## The Problem

In libp2p's kad-dht, the **validator** and **selector** have separate responsibilities:

- **Validator** `(key, value) → valid/invalid` — checks if a record is valid on its own (signature, format, etc.). Has no access to the locally stored record.
- **Selector** `(key, [records]) → index` — picks the best record when a node holds multiple valid records for the same key.

This creates a vulnerability: when a DHT node receives a PUT for a key it has **no existing record for**, the validator accepts any correctly signed value — even if it's an old version. The selector never runs because there's nothing to compare against.

### Why This Matters

All mutable DHT records in Kiyeovo (offline buckets, group-info pointers, group offline buckets) are signed by their owner and include a monotonically increasing `version` field. The selector already picks the highest version when both old and new records exist on the same node.

But a **malicious user who holds a valid old signed record** can exploit the gap:

1. Attacker has a legitimately signed record at version 3 (obtained when they were a group member, or just from normal DHT participation).
2. The legitimate owner has since published version 7.
3. Attacker re-publishes version 3 aggressively — much more frequently than the legitimate owner re-publishes version 7.
4. DHT nodes that already hold version 7 are safe — the selector picks 7 over 3.
5. But DHT nodes that have **never seen version 7** (new nodes, nodes that restarted, nodes that evicted the record) accept version 3 because the validator only checks the signature, which is valid.
6. Over time, if the attacker re-publishes faster than the owner, the majority of DHT nodes end up holding the stale version 3. Version 7 becomes increasingly rare in the network.

This is not a theoretical attack. It's straightforward to execute: just call `dht.put()` in a loop with the old signed bytes. No cryptographic break needed.

### Why Aggressive Re-publishing Alone Doesn't Solve It

The countermeasure without a fork is for the owner (and friendly recipients) to re-publish the latest record more frequently. But this is an arms race: the attacker can always re-publish faster. The attacker also has the advantage of running multiple nodes, each re-publishing independently.

## The Solution

Fork `@libp2p/kad-dht` to make the **validator version-aware** by giving it access to the existing locally stored record.

### Current Flow (unmodified)

```
PUT arrives for key K with value V_new
  → validator(K, V_new) → valid?
    → yes → is there an existing V_old for K?
      → yes → selector(K, [V_old, V_new]) → pick winner → store
      → no  → store V_new (VULNERABLE: stale records accepted here)
    → no → reject
```

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

The PUT_VALUE handler (`rpc/handlers/put-value.ts` in `@libp2p/kad-dht`) already reads
from this datastore after validation to run the selector. The existing flow in the source:

```typescript
// put-value.ts (simplified from actual source)
async handle(peerId, msg) {
  const key = msg.key
  const incoming = msg.record

  // Step 1: validate incoming record (no access to local store)
  await this.validators[prefix](key, incoming.value)

  // Step 2: check if we already have a record for this key
  const recordKey = new Key(`/dht/records/${base32encode(key)}`)
  try {
    const existingRaw = await this.datastore.get(recordKey)
    const existing = Libp2pRecord.deserialize(existingRaw)

    // Step 3: selector picks winner
    const winner = this.selectors[prefix](key, [existing.value, incoming.value])
    if (winner === 0) return  // existing wins, discard incoming
  } catch (err) {
    // No existing record — fall through to store
  }

  // Step 4: store incoming
  await this.datastore.put(recordKey, incoming.serialize())
}
```

The datastore is **right there** in the same handler scope. The validator doesn't receive
it only because the API was designed as a pure function. No new storage mechanism is needed.

### What Changes in the DHT Code

1. Add a new optional callback: `validateUpdate(key: Uint8Array, existing: Uint8Array, incoming: Uint8Array) → Promise<void>` (throws to reject).
2. In `put-value.ts`, after the standard validator passes, the datastore lookup **already happens**. Move it slightly earlier and pass the existing record to `validateUpdate` before the selector runs.
3. If `validateUpdate` throws, reject the PUT immediately (don't even run the selector).
4. If no `validateUpdate` is registered for the key prefix, fall back to existing behavior (selector picks winner).

The concrete change in `put-value.ts`:

```typescript
// BEFORE (current)
await this.validators[prefix](key, incoming.value)
try {
  const existingRaw = await this.datastore.get(recordKey)
  const existing = Libp2pRecord.deserialize(existingRaw)
  const winner = this.selectors[prefix](key, [existing.value, incoming.value])
  if (winner === 0) return
} catch {}
await this.datastore.put(recordKey, incoming.serialize())

// AFTER (fork) — ~5 lines added
await this.validators[prefix](key, incoming.value)
try {
  const existingRaw = await this.datastore.get(recordKey)
  const existing = Libp2pRecord.deserialize(existingRaw)

  // NEW: version-aware rejection before selector
  if (this.validateUpdate?.[prefix]) {
    await this.validateUpdate[prefix](key, existing.value, incoming.value)
    // throws if incoming is stale → PUT rejected, never reaches selector or store
  }

  const winner = this.selectors[prefix](key, [existing.value, incoming.value])
  if (winner === 0) return
} catch (err) {
  if (err.message === 'stale record rejected') return  // NEW: don't store
  // No existing record — fall through to store
}
await this.datastore.put(recordKey, incoming.serialize())
```

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

- **Nodes that have the latest record are immune.** No amount of attacker re-publishing can downgrade them.
- **Nodes with no record still accept the first valid value they see** (could be stale). This is unavoidable — you can't compare against nothing.
- **Combined with aggressive re-publishing**, this makes the attack window very narrow: the attacker can only "win" on nodes that have never seen the latest version, and once those nodes receive the latest version, they become permanently immune.
- **The selector is still needed** as a fallback for edge cases (e.g., two records arrive near-simultaneously before either is stored), but the heavy lifting moves to `validateUpdate`.

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
