# Mode-Scoped Identity Refactor (Privacy Hard Isolation)

## Goal
Implement full identity isolation between `fast` and `anonymous` modes:

- each mode has a different local peer identity (different peer ID)
- `users` and related profile/key data are mode-scoped
- no cross-mode mutation of usernames/keys/trust state
- no direct linkability through stable peer ID across modes

This is the privacy-hard version of mode isolation.

## Desired End State

1. `fast` mode runs with identity `A` (peer ID `P_fast`).
2. `anonymous` mode runs with identity `B` (peer ID `P_anon`).
3. `P_fast !== P_anon` always.
4. Any write/read of user profile data is scoped by active mode.
5. Auto-register, trust, block, login cooldowns, and key material do not bleed across modes.

## Assumptions

- Reset/new install is required for this rollout (no legacy migration path).
- Password can be the same for both mode identities.
- Recovery phrase is shared UX surface, but maps to mode-specific encrypted payloads.

## Final Decisions (locked)

1. Identity rows are mode-scoped:
- key shape: `(network_mode, identity_kind)` where `identity_kind in ('primary','recovery')`.

2. Users are mode-scoped:
- unique key: `(network_mode, peer_id)`.
- username policy: mode-local (not global).

3. Recovery model is fixed:
- one phrase shown to user
- mode-specific recovery keys derived internally (`HKDF(phrase, mode)`).

4. No migration:
- hard reset/new install only.

5. Deletion behavior:
- user rows are mode-scoped and may be deleted within current mode without affecting the other mode.

## Database Changes

## 1) `encrypted_user_identities`
Current table is global by `peer_id` only.

Required:
- add `network_mode TEXT NOT NULL CHECK(...)`
- add `identity_kind TEXT NOT NULL CHECK(identity_kind IN ('primary','recovery'))`
- unique index on `(network_mode, identity_kind)`
- stop encoding recovery in `peer_id` suffix (`-recovery`)

Methods to replace:
- `createEncryptedUserIdentity(...)`
- `getEncryptedUserIdentity()`
- `getEncryptedUserIdentityByPeerId(peerId)`

New methods:
- `createEncryptedUserIdentityForMode(mode, kind, payload)`
- `getEncryptedUserIdentityForMode(mode, kind)`

## 2) `users`
Current table is global by `peer_id` only.

Required:
- add `network_mode TEXT NOT NULL CHECK(...)`
- unique index on `(network_mode, peer_id)`
- optional index on `(network_mode, username)`

Update all write/read methods to include mode:
- `createUser`
- `updateUserKeys`
- `updateUsername`
- `getUserByPeerId`
- `getUserByUsername`
- `getUserByPeerIdThenUsername`
- `getUsersPeerIds`
- `getUsernamesForPeerIds`
- `deleteUserByPeerId`

## 3) Related tables keyed by peer only (evaluate and scope)

- `blocked_peers` (currently global): add `network_mode`
- `contact_attempts` (currently global): add `network_mode`
- `failed_key_exchanges` (currently global): add `network_mode`
- `login_attempts` (currently global and keyed by peer): add `network_mode`

Reason: these tables can leak behavior across modes and affect UX/security logic.

## Core Runtime Changes

## 1) Identity load/create must be mode-aware

Files:
- `src/core/lib/encrypted-user-identity.ts`
- `src/core/lib/db/database.ts`
- `src/core/index.ts`

Current issue:
- `EncryptedUserIdentity.loadOrCreateEncrypted(...)` loads one global identity.

Required:
- new API: `loadOrCreateEncryptedForMode(database, mode, ...)`
- choose mode identity before libp2p node init
- keychain account keys must include mode (avoid collisions)

## 2) Startup + mode switch lifecycle

Files:
- `src/core/index.ts`
- `src/electron/main.ts`
- mode switching IPC paths

Required:
- when mode changes, app must reinitialize core with mode identity
- clear mode-bound caches/sessions safely
- no reuse of previous mode's in-memory session state

## 3) Username registry + self-registration

Files:
- `src/core/lib/username-registry.ts`

Required:
- already mode-scoped DHT keys; keep that
- ensure DB user writes are mode-scoped
- ensure auto-register setting stays mode-scoped (already done)

## 4) Key exchange + user upserts

Files:
- `src/core/lib/key-exchange.ts`
- `src/core/lib/message-handler.ts`

Required:
- all `users` reads/writes must resolve with active mode
- contact authorization lookups (`getUserByPeerId`) must be mode-aware
- no global fallback to user rows from other mode

## 5) UI-level user editing/deletion

Files:
- `src/ui/components/chat/header/ChatHeader.tsx`
- `src/electron/ipc-handlers.ts`

Required:
- username edits affect current mode user only
- delete chat/user logic affects only current mode users/chats unless explicit global delete action is added

## Mode Selector Helper Text (final UX)

Only this explicit UX change is required for now:

- Under Fast mode:
  - `Fast mode: uses your Fast identity (separate peer ID).`
- Under Anonymous mode:
  - `Anonymous mode: uses your Anonymous identity (separate peer ID).`

## API and Type Changes

Update method signatures to accept optional mode explicitly where needed:

- DB user APIs should be `(..., mode?: NetworkMode)` with default session mode.
- IPC handlers that mutate user state should operate in active mode only.
- Any shared type named `User` should include `network_mode` when persisted.

## Security and Privacy Hardening

1. Ensure no logs print cross-mode peer correlations.
2. Ensure recovery flow cannot accidentally restore wrong mode identity.
3. Ensure notifications/contact attempts are not shared between modes.
4. Verify blocked peer in one mode does not block in the other (unless explicitly desired).

## Test Plan (must pass before merge)

## A) Identity separation
- Start in fast mode, record peer ID.
- Switch to anonymous mode, record peer ID.
- assert peer IDs differ.

## B) No cross-mode contact mutation
- Create contact in fast, edit username.
- switch anonymous, ensure same peer row not mutated there.

## C) Auto-register isolation
- enable in one mode, disable in other.
- restart in each mode and verify behavior is independent.

## D) Deletion isolation
- delete chat/user in mode A.
- verify mode B contact remains intact.

## E) Block/trust isolation
- block in mode A.
- verify not blocked in mode B.

## F) Recovery
- recover fast identity only.
- recover anonymous identity only.
- verify no accidental swap.

## Implementation Plan (recommended order)

1. DB schema + DB methods (mode-scoped users + identity rows).
2. Mode-aware encrypted identity load/create.
3. Core startup and mode-switch reinit.
4. Key exchange + message handler mode-safe user access.
5. UI/IPC adjustments for user edit/delete semantics.
6. Privacy validation + integration tests.

## Notes

- This refactor is worth doing for privacy.  
- It is not just SQL filtering; identity lifecycle and recovery handling are the high-risk parts.  
- The safest path is a reset-first rollout with explicit tests above.
