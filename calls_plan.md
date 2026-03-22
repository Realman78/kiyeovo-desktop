# Calls Plan (Fast Mode, Direct Contacts, Audio Only)

## Scope
- Add 1:1 audio calls for direct contacts in Fast mode only.
- No video, no mute, no call history persistence in this phase.
- Defaults agreed for this implementation:
- Online-only signaling (no offline persistence).
- Outgoing offer send timeout: 5 seconds.
- Offer retry: 1 retry after 2 seconds.
- Ring timeout target: 30 seconds (renderer-owned UX timeout).
- Single active/ringing call globally per app instance.
- UI requirements:
- `ChatHeader` gets a call button for direct chats.
- If target is offline/unreachable, caller gets immediate feedback and no ring UI is started.
- Incoming call shows floating notification in top-right with `Accept` / `Reject`.
- Call manager is always floating in top-right while call is ongoing/ringing, with `Hang up`.

## High-Level Architecture

### 1) Signaling transport
- Use app realtime signaling over libp2p (not offline buckets).
- Keep call signaling online-only and short-lived.
- Do not store call signaling in DB.

### 2) Media transport
- Use WebRTC (`RTCPeerConnection`) for audio media path.
- Use mic track only (`getUserMedia({ audio: true })`).
- ICE config includes STUN/TURN (coturn running on the bootstrap/relay server).

### 3) Separation of concerns
- Core process (P2P side):
- Receive/route call signaling messages.
- Verify signatures and enforce policy.
- Emit IPC events to renderer.
- Renderer process (UI side):
- Own WebRTC peer connection lifecycle.
- Own floating call UI state.
- Send signaling commands via IPC to core.

## Call Signaling Model

### Message types
- `CALL_OFFER`
- `CALL_ANSWER`
- `CALL_ICE`
- `CALL_REJECT`
- `CALL_END`
- `CALL_BUSY`

### Shared fields
- `callId` (UUID)
- `fromPeerId`
- `toPeerId`
- `timestamp`
- `signature`

### Payload specifics
- `CALL_OFFER`: SDP offer
- `CALL_ANSWER`: SDP answer
- `CALL_ICE`: ICE candidate payload
- `CALL_REJECT`: reason (`rejected`, `timeout`, `offline`, `policy`)
- `CALL_END`: reason (`hangup`, `disconnect`, `failed`)
- `CALL_BUSY`: reason `busy`

## State Machine (single active call per app)
- `idle`
- `ringing_out`
- `ringing_in`
- `connecting`
- `active`
- `ended`

Transitions:
- Outgoing: `idle -> ringing_out -> connecting -> active -> ended`
- Incoming accepted: `idle -> ringing_in -> connecting -> active -> ended`
- Incoming rejected: `ringing_in -> ended`
- Timeout/failure from any non-idle state -> `ended`

## Policy and Guards
- Fast mode only.
- Direct chats only (no group calls).
- Must be known contact and not blocked.
- One active/ringing call at a time:
- If busy and another offer arrives, reply `CALL_BUSY`.
- Offer ring timeout (suggested: 30s).
- Ignore stale signaling by timestamp and `callId` checks.

## UX Flow

### Outgoing
1. User clicks call button in `ChatHeader`.
2. UI requests call start via IPC.
3. Core checks policy + quick reachability.
4. If unreachable/offline, return immediate error and show toast.
5. If reachable, send `CALL_OFFER`; show floating call manager in `ringing_out`.

### Incoming
1. Core receives `CALL_OFFER` and validates.
2. Renderer shows floating top-right incoming notification.
3. Accept -> create WebRTC answer and send `CALL_ANSWER`.
4. Reject -> send `CALL_REJECT` and dismiss incoming UI.

### In-call
- Floating top-right manager shows status and `Hang up`.
- `Hang up` sends `CALL_END` and performs full cleanup.

## TURN/STUN
- Configure ICE servers from app config (or environment-backed settings):
- `stun:<host>:3478`
- `turn:<host>:3478` with username/password
- Start with `iceTransportPolicy: all`.
- Optional debug mode to force relay-only (`iceTransportPolicy: relay`) for validation.

## IPC Surface (proposed)

### Renderer -> Core
- `CALL_START(peerId)`
- `CALL_ACCEPT(callId)`
- `CALL_REJECT(callId)`
- `CALL_HANGUP(callId)`
- `CALL_SIGNAL_SEND(callSignalPayload)`

### Core -> Renderer events
- `CALL_INCOMING` (offer metadata)
- `CALL_SIGNAL_RECEIVED` (answer/ice/end/reject/busy)
- `CALL_STATE_CHANGED`
- `CALL_ERROR`

## File-Level Implementation Plan

### Phase 1: Core signaling and plumbing
- Add call message types in core shared types.
- Add call signaling handlers in `message-handler` route layer.
- Add policy checks (fast mode/direct/not blocked/not busy).
- Add IPC channels for start/accept/reject/hangup + signal relay.

### Phase 2: Renderer WebRTC service
- Implement `CallService` to own `RTCPeerConnection` lifecycle.
- Outgoing: create offer, set local description, emit `CALL_OFFER`.
- Incoming accept: set remote offer, create answer, set local, emit `CALL_ANSWER`.
- ICE gathering/relay through `CALL_ICE` messages.
- Full cleanup routine for end/fail/reject paths.

### Phase 3: UI integration
- Add call button in `src/ui/components/chat/header/ChatHeader.tsx`.
- Add top-right incoming call notification component.
- Add persistent top-right floating call manager with hangup.
- Add toasts/errors for offline/unreachable/busy/failed.

### Phase 4: Hardening
- Ring timeout handling.
- Stale signal rejection (`callId`, timestamp windows).
- Duplicate signal idempotency.
- App shutdown cleanup to ensure calls end cleanly.

## Test Checklist
- Outgoing call success between two online Fast-mode direct contacts.
- Incoming reject path (`CALL_REJECT`) and UI cleanup.
- Busy path (`CALL_BUSY`) when callee already in another call.
- Offline/unreachable caller feedback (no ringing stuck state).
- Hang up from both sides.
- Recovery after transient network interruption.
- TURN fallback path works when direct path fails.

## Out of Scope for this phase
- Video calling
- Mute/deafen controls
- Call transfer / conference
- Persisted call history/records
- Anonymous mode call support
