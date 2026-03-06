# Phase 11 Implementation: Group Status State Machine

## Goal
Enforce valid `group_status` transitions in one place so join/leave/kick/reinvite flows cannot accidentally move chats into invalid states.

## What Was Added

### 1) Central state machine module
File: `src/core/lib/group/group-state-machine.ts`

Added:
- `ALLOWED_TRANSITIONS` map (source of truth)
- `isGroupStatus(value)`
- `isGroupTransitionAllowed(from, to)`
- `assertGroupTransition(from, to, context?)`

Implemented transition set:
- `invited_pending -> awaiting_activation | invite_expired | left | removed | rekeying | active`
- `awaiting_activation -> active | left | removed | invite_expired`
- `active -> rekeying | left | removed`
- `rekeying -> active | removed | invited_pending`
- `left -> invited_pending | awaiting_activation`
- `removed -> invited_pending | awaiting_activation`
- `invite_expired -> invited_pending | awaiting_activation | left | removed`
- same-state transition is treated as valid no-op

Notes:
- Some defensive transitions are intentionally allowed (for legacy/reinvite/user-action edge paths).
- Strictly invalid jumps still throw.

### 2) Guarded DB transition method
File: `src/core/lib/db/database.ts`

Added:
- `transitionChatGroupStatus(chatId, nextStatus, reason)`

Behavior:
- Reads current `group_status` from DB.
- No-op if same status.
- Validates current status shape (`isGroupStatus`), then validates transition (`assertGroupTransition`).
- Applies status update via existing `updateChatGroupStatus(...)`.
- Logs transition:
  - `[GROUP][STATE][TRANSITION] chatId=... from=... to=... reason=...`

Important:
- Existing `updateChatGroupStatus(...)` remains in place for lower-level/internal/recovery usage.
- Transition method is now used in group flow code paths.

## Where Group Flow Was Switched To Guarded Transitions

### Creator side
File: `src/core/lib/group/group-creator.ts`

Replaced status writes with `transitionChatGroupStatus(...)` in:
- Group creation local state set
- Leave rotation start/done/rollback/partial-failure handling
- Kick rotation start/done/rollback/partial-failure handling
- Welcome rotation start/done/rollback/partial-failure handling

### Responder side
File: `src/core/lib/group/group-responder.ts`

Replaced status writes with `transitionChatGroupStatus(...)` in:
- Invite apply local state
- Invite-expired on respond
- Respond local state (`awaiting_activation` / `invite_expired` / `removed`)
- Welcome apply (`active`)
- State update apply (`active`)
- Local leave apply (`left`)
- Local removed apply (`removed`)

## Why This Is Safe

1. Existing business logic was not reordered.
- Only status-write calls were routed through validation.

2. Rollback and partial-failure paths remain intact.
- Creator still handles rotation commit/rollback exactly as before.

3. Defensive transitions are included for known edge behavior.
- Avoids breaking existing reinvite and user-local cleanup paths.

4. Removed-chat catchup logic remains unchanged.
- Status update function still keeps removed metadata semantics.

## Validation Run

Executed successfully:
- `npm run -s transpile:electron`
- `npx tsc -p tsconfig.app.json --noEmit`

## Practical Outcome

- Invalid state transitions now fail fast instead of silently mutating DB.
- Valid transitions are logged with reasons, making race/flow debugging easier.
- Join/leave/kick/reinvite flows are now guarded by explicit transition invariants.

