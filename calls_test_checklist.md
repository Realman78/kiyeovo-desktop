# Calls Hardening Test Checklist

## 1. Duplicate offer idempotency
- A calls B.
- While B is still ringing, trigger a second identical offer retry (wait for retry path or resend call start for the same `callId` if you have a debug hook).
- Expected:
  - Only one incoming card on B.
  - No duplicate incoming UI.
  - No call state corruption.

## 2. Duplicate accept guard
- B receives incoming call.
- Click `Accept` twice quickly.
- Expected:
  - Only one connection attempt.
  - No leaked/stuck second `RTCPeerConnection`.
  - Call either connects once or fails once cleanly.

## 3. Stale control signal drop
- Establish a call, then end it.
- Replay or delay-deliver an older control signal (`CALL_ANSWER`, `CALL_END`, or `CALL_REJECT`) for the same peer/call context.
- Expected:
  - Stale signal is ignored.
  - Current call state is not overwritten.

## 4. 30s ring timeout
- A calls B, B does nothing.
- Expected at ~30s:
  - B incoming card disappears (timeout reject sent).
  - A exits ringing state and call ends.
  - No stuck call manager card on either side.

## 5. Shutdown-safe cleanup
- Start a call (ringing or active), then close app on one side.
- Expected:
  - Local side exits call UI immediately on shutdown.
  - Remote side receives end/disconnect when possible.
  - Remote side is not permanently stuck in ringing/active.
  - After restart, no ghost active call state.

## If a case fails, capture:
- Case number.
- Last ~30 call-related log lines from both peers.
- What each UI showed.
