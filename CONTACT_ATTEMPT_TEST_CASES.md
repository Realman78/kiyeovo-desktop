# Contact Attempt / Key Exchange Test Cases

## Test Case Categories
1. Happy Path Scenarios
2. Timeout Scenarios
3. Offline Scenarios
4. Race Conditions
5. Multiple Attempts
6. Network Issues
7. State Synchronization

---

## 1. Happy Path Scenarios

### TC-HP-001: Normal Accept (Both Online)
**Setup:**
- Sender (Alice) is online
- Receiver (Bob) is online

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives contact attempt
3. Bob accepts within timeout period
4. Key exchange completes

**Expected Results:**
- ✅ Chat created on both sides
- ✅ Both can send/receive messages
- ✅ Contact attempt removed from Bob's list
- ✅ Pending key exchange removed from Alice's list
- ✅ No orphaned chats
- ✅ `justCreated` flag cleared when first message arrives

**Status:** ✅ Already handled

---

### TC-HP-002: Normal Reject (Both Online)
**Setup:**
- Sender (Alice) is online
- Receiver (Bob) is online

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives contact attempt
3. Bob rejects within timeout period

**Expected Results:**
- ✅ No chat created on either side
- ✅ Contact attempt removed from Bob's list
- ✅ Pending key exchange removed from Alice's list
- ✅ Alice notified of rejection (if implemented)
- ✅ No orphaned state

**Status:** ⚠️ Needs verification

---

## 2. Timeout Scenarios

### TC-TO-001: Sender Times Out First (Receiver Never Responds)
**Setup:**
- Sender timeout: 30 seconds
- Receiver timeout: 2 minutes
- Receiver (Bob) doesn't respond

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives contact attempt
3. 30 seconds pass (Alice's timeout expires)
4. Bob still has contact attempt visible

**Expected Results:**
- ✅ Alice's pending key exchange removed after 30s
- ✅ Bob's contact attempt should remain until his 2-minute timeout
- ✅ If Bob accepts after Alice's timeout, he should get error/notification
- ✅ No chat created on Alice's side
- ⚠️ Bob's acceptance should be rejected gracefully

**Status:** ⚠️ Needs implementation/verification

---

### TC-TO-002: Receiver Times Out (Before Responding)
**Setup:**
- Sender timeout: 2 minutes
- Receiver timeout: 30 seconds
- Receiver (Bob) doesn't respond

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives contact attempt
3. 30 seconds pass (Bob's timeout expires)
4. Contact attempt auto-removed from Bob's UI

**Expected Results:**
- ✅ Bob's contact attempt removed after 30s
- ✅ Alice's pending key exchange should remain until her 2-minute timeout
- ⚠️ If Alice's stream is still open, she should be notified of Bob's timeout
- ✅ No chat created on either side

**Status:** ⚠️ Needs verification

---

### TC-TO-003: Receiver Accepts After Sender Timeout (Bug Scenario)
**Setup:**
- Sender timeout: 5 seconds (short for testing)
- Receiver timeout: 2 minutes

**Steps:**
1. Alice sends key exchange to Bob
2. 5 seconds pass (Alice's timeout expires)
3. Alice's pending key exchange removed, stream closed
4. Bob accepts at 10 seconds (within his timeout)

**Expected Results:**
- ✅ Bob creates chat locally
- ✅ Bob sees "No messages yet. Say hi! 👋" immediately
- ✅ After 10 seconds, `justCreated` flag cleared automatically
- ✅ No chat created on Alice's side
- ⚠️ Bob should get notification that sender is no longer available
- ✅ No infinite "Loading messages..." state

**Status:** ✅ Recently fixed with timeout + empty state

---

## 3. Offline Scenarios

### TC-OFF-001: Sender Goes Offline Before Receiver Responds
**Setup:**
- Both start online
- Sender goes offline mid-exchange

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives contact attempt
3. Alice goes offline (network disconnect / app close)
4. Bob accepts

**Expected Results:**
- ⚠️ Bob's acceptance should handle sender offline gracefully
- ⚠️ Chat created on Bob's side with appropriate status
- ⚠️ When Alice comes back online, state should sync
- ⚠️ Offline message queue should handle first messages

**Status:** ⚠️ Needs verification

---

### TC-OFF-002: Sender Offline When Receiver Accepts
**Setup:**
- Sender already offline
- Receiver has pending contact attempt from before

**Steps:**
1. Alice was online, sent key exchange to Bob
2. Alice goes offline
3. Bob accepts while Alice is offline

**Expected Results:**
- ✅ Bob creates chat locally
- ✅ Bob can send messages (stored as offline messages)
- ✅ When Alice comes back online, she receives offline messages
- ⚠️ Chat state syncs correctly on both sides
- ⚠️ Bob sees "offline" indicator for Alice

**Status:** ✅ Already handled (mentioned by user)

---

### TC-OFF-003: Receiver Offline When Sender Initiates
**Setup:**
- Receiver (Bob) is offline

**Steps:**
1. Alice tries to send key exchange to Bob
2. Bob is offline

**Expected Results:**
- ⚠️ Alice should get notification that Bob is offline
- ⚠️ OR key exchange should be queued as offline message
- ⚠️ When Bob comes online, he receives the key exchange attempt

**Status:** ❓ Design decision needed

---

### TC-OFF-004: Both Go Offline During Exchange
**Setup:**
- Both online initially

**Steps:**
1. Alice sends key exchange to Bob
2. Bob receives it
3. Both go offline before Bob responds

**Expected Results:**
- ⚠️ Contact attempt should persist in Bob's database
- ⚠️ When Bob comes back online, he can still accept/reject
- ⚠️ When Alice comes back online, pending key exchange restored
- ⚠️ Timeout handling should account for offline periods

**Status:** ❓ Needs clarification on timeout behavior during offline

---

## 4. Race Conditions

### TC-RC-001: Sender Cancels While Receiver Accepting
**Setup:**
- Both online
- Actions happen simultaneously

**Steps:**
1. Alice sends key exchange to Bob
2. Bob clicks "Accept"
3. Simultaneously, Alice cancels the key exchange
4. Both actions execute at nearly the same time

**Expected Results:**
- ⚠️ Deterministic outcome (either cancel wins or accept wins)
- ✅ No orphaned chats
- ✅ No partially created state
- ⚠️ Proper error handling on whichever side "loses"

**Status:** ⚠️ Needs verification

---

### TC-RC-002: Simultaneous Key Exchanges (A→B and B→A)
**Setup:**
- Alice wants to contact Bob
- Bob wants to contact Alice
- Both initiate at the same time

**Steps:**
1. Alice sends key exchange to Bob
2. Simultaneously, Bob sends key exchange to Alice
3. Both receive each other's contact attempts

**Expected Results:**
- ⚠️ Should detect duplicate exchange attempts
- ⚠️ Should merge into single chat (not two chats)
- ⚠️ OR reject one and accept the other deterministically
- ✅ No duplicate chats created

**Status:** ❓ Design decision needed

---

### TC-RC-003: Multiple Rapid Accepts (UI Double-Click)
**Setup:**
- Receiver double-clicks accept button

**Steps:**
1. Alice sends key exchange to Bob
2. Bob double-clicks "Accept" button rapidly
3. Multiple accept requests triggered

**Expected Results:**
- ✅ Only one acceptance processed
- ✅ Button should be disabled after first click
- ✅ No duplicate chats
- ✅ No errors in console

**Status:** ⚠️ Needs UI verification

---

## 5. Multiple Attempts

### TC-MA-001: Second Attempt After First Timeout
**Setup:**
- First attempt timed out on both sides

**Steps:**
1. Alice sends key exchange to Bob (Attempt 1)
2. Both timeouts expire without response
3. Alice sends another key exchange to Bob (Attempt 2)
4. Bob accepts Attempt 2

**Expected Results:**
- ✅ Attempt 1 fully cleaned up on both sides
- ✅ Attempt 2 succeeds normally
- ✅ Only one chat created
- ✅ No zombie timeouts from Attempt 1 interfering

**Status:** ✅ Fixed with timeout leak fix

---

### TC-MA-002: Second Attempt While First Still Pending
**Setup:**
- First attempt still within timeout period

**Steps:**
1. Alice sends key exchange to Bob (Attempt 1)
2. Before timeout, Alice sends another key exchange to Bob (Attempt 2)

**Expected Results:**
- ⚠️ Should either:
  - Cancel Attempt 1 and replace with Attempt 2, OR
  - Reject Attempt 2 with "already pending" error
- ✅ Bob should only see one contact attempt
- ✅ No duplicate pending exchanges

**Status:** ❓ Design decision needed

---

### TC-MA-003: Second Attempt After Rejection
**Setup:**
- First attempt was rejected by receiver

**Steps:**
1. Alice sends key exchange to Bob (Attempt 1)
2. Bob rejects it
3. Alice sends another key exchange to Bob (Attempt 2)
4. Bob accepts Attempt 2

**Expected Results:**
- ✅ Attempt 2 succeeds independently
- ✅ Chat created normally
- ✅ No state pollution from Attempt 1
- ⚠️ Optional: Rate limiting to prevent spam

**Status:** ⚠️ Needs verification + spam protection consideration

---

## 6. Network Issues

### TC-NET-001: Network Disconnect During Key Exchange
**Setup:**
- Exchange in progress
- Network drops

**Steps:**
1. Alice sends key exchange to Bob
2. Network disconnects mid-exchange
3. Network reconnects after 30 seconds

**Expected Results:**
- ⚠️ Timeouts should handle disconnection gracefully
- ⚠️ State should recover after reconnection
- ⚠️ No corrupted data
- ⚠️ Users notified of network issues

**Status:** ⚠️ Needs verification

---

### TC-NET-002: Flaky Connection (Intermittent Drops)
**Setup:**
- Connection drops and reconnects repeatedly

**Steps:**
1. Alice sends key exchange to Bob
2. Connection flakes during exchange
3. Bob tries to accept during connection drop

**Expected Results:**
- ⚠️ Acceptance should retry or queue until connection stable
- ⚠️ User gets feedback about connection issues
- ⚠️ Eventually succeeds or fails gracefully

**Status:** ⚠️ Needs verification

---

## 7. State Synchronization

### TC-SS-001: Chat Created on One Side Only (Orphaned Chat)
**Setup:**
- Some failure causes chat to exist on one side only

**Steps:**
1. Due to bug/race condition, Bob has a chat but Alice doesn't
2. Bob tries to send message

**Expected Results:**
- ⚠️ System detects orphaned chat
- ⚠️ Either:
  - Automatically cleans up Bob's orphaned chat, OR
  - Attempts to re-establish connection/sync state
- ✅ User is notified
- ✅ No silent message failures

**Status:** ⚠️ Needs verification + detection mechanism

---

### TC-SS-002: `justCreated` Flag Never Cleared
**Setup:**
- Chat created with `justCreated=true`
- First message never arrives

**Steps:**
1. Chat created with `justCreated=true`
2. No messages arrive (e.g., sender timeout bug)
3. 10 seconds pass

**Expected Results:**
- ✅ After 10 seconds, `justCreated` flag cleared automatically
- ✅ User sees "No messages yet. Say hi! 👋"
- ✅ Chat is usable (not stuck in loading state)

**Status:** ✅ Fixed with timeout mechanism

---

### TC-SS-003: Duplicate Contact Attempts (Same PeerID)
**Setup:**
- Multiple contact attempts from same sender

**Steps:**
1. Alice sends key exchange to Bob
2. System bug causes duplicate contact attempt with same PeerID

**Expected Results:**
- ✅ Only one contact attempt shown in UI
- ✅ Acceptance/rejection works correctly
- ✅ No duplicate processing

**Status:** ⚠️ Needs verification

---

## Priority Legend
- ✅ **Verified/Fixed**: Test case is confirmed working
- ⚠️ **Needs Verification**: Scenario should be manually tested
- ❓ **Needs Design Decision**: Behavior needs to be defined
- 🔴 **Known Issue**: Confirmed bug, needs fix

---

## Testing Recommendations

### High Priority (Must Test)
1. TC-TO-003: Receiver accepts after sender timeout (✅ recently fixed)
2. TC-OFF-002: Sender offline when receiver accepts (✅ mentioned as handled)
3. TC-MA-001: Second attempt after timeout (✅ fixed)
4. TC-RC-001: Sender cancels while receiver accepting
5. TC-SS-001: Orphaned chat detection

### Medium Priority (Should Test)
1. TC-HP-002: Normal rejection flow
2. TC-TO-001: Sender times out first
3. TC-OFF-001: Sender goes offline mid-exchange
4. TC-RC-002: Simultaneous key exchanges
5. TC-MA-002: Second attempt while first pending

### Low Priority (Nice to Test)
1. TC-RC-003: UI double-click protection
2. TC-NET-001: Network disconnect handling
3. TC-SS-003: Duplicate contact attempt handling
4. TC-MA-003: Second attempt after rejection

---

## Test Environment Setup

### Quick Test Configuration (For Fast Iteration)
```typescript
// In constants.ts or config file
export const TEST_CONFIG = {
  SENDER_TIMEOUT: 5000,        // 5 seconds (instead of 2 minutes)
  RECEIVER_TIMEOUT: 120000,    // 2 minutes (normal)
  JUST_CREATED_TIMEOUT: 10000  // 10 seconds
};
```

### How to Simulate Scenarios
1. **Timeout**: Use short timeout values in config
2. **Offline**: Disconnect network or kill process
3. **Race conditions**: Use multiple browser windows/app instances
4. **Network issues**: Use network throttling tools (e.g., `tc` on Linux)

---

## Automated Testing Suggestions

### Unit Tests Needed
- Key exchange timeout logic
- `justCreated` flag clearing
- Contact attempt deduplication
- State cleanup on timeout/rejection

### Integration Tests Needed
- Two-node key exchange flows
- Offline message handling
- Chat state synchronization

### Manual Tests Required
- UI responsiveness during exchanges
- Error message clarity
- Network disconnect recovery
- Multi-device synchronization
