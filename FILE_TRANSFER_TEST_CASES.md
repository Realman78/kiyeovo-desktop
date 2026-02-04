# File Transfer Test Cases (Desktop)

Purpose: validate file-transfer behavior end-to-end and its interactions with chat, sessions, and UI state.

---

## 1) Session / Key Exchange Interactions
- First message in a session is a file offer (no prior text)
  - Expected: file send blocked with a clear error; no chat created if it didn’t exist.
- First message is a text, then file offer
  - Expected: send succeeds; session reused; no extra key exchange attempts.
- Out-of-band trusted chat → send file while upgrade to full key exchange is pending
  - Expected: either upgrade completes or file send is blocked with explicit error.
- Key exchange fails mid-file-offer (simulate offline or timeout)
  - Expected: sender sees rejection/failed status; no stuck pending message.

## 2) Offer Lifecycle (Sender)
- Send file, receiver accepts within timeout
  - Expected: pending → in_progress → completed; progress updates; message persists after restart.
- Send file, receiver rejects
  - Expected: sender sees “Offer rejected” status; DB reflects rejected.
- Send file, receiver never responds (timeout)
  - Expected: sender sees “Offer expired”; no lingering pending.
- Send multiple file offers in a row (same chat)
  - Expected: each offer is its own message with correct status.
- Send file while another offer is pending (same chat)
  - Expected: both offers remain visible and ordered by timestamp.

## 3) Offer Lifecycle (Receiver)
- Receive offer, accept
  - Expected: pending → in_progress → completed; saved to disk; open-in-folder works.
- Receive offer, reject
  - Expected: pending → rejected; no download; pending indicator cleared.
- Receive offer, ignore until timeout
  - Expected: pending → expired; pending indicator cleared.
- Receive multiple offers (same sender)
  - Expected: each offer independent; accept/reject doesn’t affect others.

## 4) Progress & Events
- Progress updates during transfer
  - Expected: progress bar moves; no jumps backwards.
- Large file (near MAX_FILE_SIZE)
  - Expected: progress updates; no UI lockups; completes successfully.
- Chunk receive timeout
  - Expected: status → failed; error message shown.
- Network interruption mid-transfer
  - Expected: status → failed; stream cleaned up.

## 5) Persistence & Restart
- App restart while offer pending
  - Expected: pending offers auto-marked expired on startup.
- App restart during in-progress transfer
  - Expected: status → failed (or expired); no stuck in_progress.
- App restart after completed transfer
  - Expected: message shows completed + open-in-folder; file path preserved.

## 6) Chat List / Unread / Preview
- Incoming offer while chat not active
  - Expected: unread count +1; chat moves to top; pending icon shown.
- Offer accepted/rejected/expired
  - Expected: chat preview updates to final status; pending icon removed.
- Multiple chats receiving offers
  - Expected: each chat updates independently; unread counts correct.

## 7) UI Behavior
- Sender sees countdown for receiver acceptance
  - Expected: countdown matches timeout; no negative values.
- Receiver sees countdown
  - Expected: countdown matches timeout; auto-expire at zero.
- Accept/Reject buttons only on receiver side
  - Expected: sender never sees those buttons.
- “Awaiting acceptance” text on sender
  - Expected: visible until accepted/rejected/expired.

## 8) File Handling & Storage
- File name conflicts (existing file in downloads)
  - Expected: _copy, _copy2 naming; saved file path shown.
- Invalid file (missing, 0 bytes, or too large)
  - Expected: send blocked with clear error; no pending message left.
- Downloads directory missing
  - Expected: directory created or error shown.

## 9) Notifications / Focus
- Incoming offer when app not focused
  - Expected: system notification + sound.
- Incoming offer when app focused
  - Expected: no system notification (but UI indicator appears).
- Muted chat
  - Expected: no sound/notification; UI indicators still update.

## 10) Permissions / Blocking
- Sender is blocked by receiver
  - Expected: offer rejected immediately; sender sees rejected/failed.
- Receiver blocks sender while offer pending
  - Expected: offer expires or rejects; no acceptance possible.

## 11) Edge / Concurrency
- Both users send offers at the same time
  - Expected: both offers visible; no disappearance; independent states.
- Rapid accept/reject clicks
  - Expected: only one action processed; no duplicate messages.
- Offer expiration while user clicks Accept
  - Expected: accept fails gracefully; status becomes expired.

## 12) Data Integrity / DB
- Verify DB row fields for file message:
  - file_name, file_size, file_path, transfer_status, transfer_progress, transfer_error
- Confirm message ordering by timestamp for file offers vs text.

