## Kiyeovo Desktop — Technical Documentation (EN)

### Purpose of the document

This document is the single-source technical overview of the current desktop version of the Kiyeovo application.
Its goal is to provide complete context quickly in new AI conversations without having to manually explain the architecture, flows, and key design decisions.

---

### TL;DR (quick context)

- Kiyeovo Desktop is an **Electron + React + libp2p** P2P messenger.
- It supports two network modes:
  - `fast` (TCP + Circuit Relay v2 + DCUtR)
  - `anonymous` (Tor onion path)
- Mode isolation is built in through:
  - mode-specific protocols
  - mode-specific DHT namespaces/prefixes
  - mode-specific pubsub topic prefixes
  - mode-aware DB queries
- Direct chat uses:
  - key exchange (X25519 + Ed25519 signatures)
  - session symmetric keys (HKDF)
  - online sending + offline fallback into a DHT bucket
- Group chat uses:
  - mode-scoped GossipSub topics for realtime messaging
  - control messages via a pairwise offline bucket mechanism
  - ACK/republish mechanisms for reliability
  - group key epoch rotation
- DHT records are validated/selected by validators (username, offline, group offline, group info latest/versioned).

---

### 1. High-level architecture

Kiyeovo Desktop is split into two main processes:

1. **Electron Main process (Node.js runtime)**
   - initializes the P2P core
   - manages the Tor lifecycle
   - holds the SQLite connection
   - exposes an IPC API to the UI

2. **Renderer process (React UI + Redux)**
   - renders the login/chat/settings UI
   - sends requests through the `preload` bridge
   - receives events from the core (new messages, KX events, file progress, group updates)

In the background, a **P2P Core** runs with the key modules:
- `MessageHandler`
- `KeyExchange`
- `SessionManager`
- `UsernameRegistry`
- `GroupCreator` / `GroupResponder` / `GroupMessaging` / `GroupOfflineManager`
- `FileHandler`
- `OfflineMessageManager`

---

### 2. Network modes and isolation

#### 2.1 Modes

- `fast`
  - transport: TCP + relay transport
  - uses Circuit Relay v2 and DCUtR
  - focus: lower latency and better UX responsiveness

- `anonymous`
  - outgoing traffic through a Tor SOCKS5 path
  - onion announce addresses
  - focus: privacy/anonymity

#### 2.2 No-bridge rule

The system is designed so that records from one mode are not visible in the other mode:
- different protocol IDs (`chat`, `file-transfer`, `bucket-nudge`, `dht`)
- different DHT namespace prefixes (`offline`, `username`, `groupOffline`, `groupInfoLatest`, `groupInfoVersion`)
- different pubsub topic prefixes
- mode-aware DB queries and queue processing

#### 2.3 Mode switch

Changing the mode is done through settings + **app restart** (there is no hot re-initialization within the same process).

---

### 3. Startup and lifecycle flow

1. The Electron app starts and opens the main window.
2. The Main process reads `network_mode` from DB settings.
3. The Tor manager is started only when needed (`anonymous`).
4. An encrypted user identity for the active mode is loaded/created.
5. A libp2p node is created (`node-setup`) with the mode-appropriate stack.
6. It attempts to connect to bootstrap nodes.
7. The DHT status checker starts (connected = DHT-reachable, not just “has a connection”).
8. The username registry is initialized.
9. The message/group/file handler layer is initialized.
10. The UI receives events and populates state (chat list, status, pending state).

---

### 4. Identity and authentication

Kiyeovo uses encrypted identities stored locally in SQLite.

The identity includes:
- libp2p identity key (Peer ID)
- signing key (Ed25519)
- offline encryption key (RSA)
- notifications key pair

Security model:
- identity encryption: AES-GCM
- KDF: scrypt
- optional password storage in the OS keychain (`keytar`)
- fallback: prompt in the UI
- recovery phrase (BIP39) for recovery
- login attempts + cooldown protection

Note: in the current implementation, the identity is mode-aware in the database (per-mode record), so the architecture is ready for stronger privacy separation between modes.

---

### 5. Direct chat flow

#### 5.1 Online flow

1. The user sends a message to a username or peer ID.
2. `MessageHandler.sendMessage` calls `ensureUserSession`:
   - finds the contact locally or through a DHT lookup
   - starts key exchange if a session does not exist
3. If the session is active, the message goes through `chatProtocol`.
4. The message content is encrypted with the session key.
5. The message is stored locally and a UI event is emitted.

#### 5.2 Key exchange

- `key_exchange_init` / `response` / `rejected`
- signatures on the key exchange payload (Ed25519)
- protection against replay/stale messages (timestamp age check)
- directional keys are derived from the ECDH shared secret (HKDF)
- automatic key rotation after a message threshold

#### 5.3 Offline fallback

If the online dial fails (peer offline / relay failure / timeout), fallback is used:
- the message is encrypted for the offline bucket
- the record is stored in the DHT
- the store is signed, validated, and versioned
- the ACK mechanism clears read messages from the sender bucket

---

### 6. Group chat flow

The group system has two transfer planes:

1. **Data plane (realtime):** GossipSub on the group topic
2. **Control plane (reliability/reconciliation):** control messages through the pairwise offline bucket + ACK/republish

#### 6.1 Lifecycle

- The creator creates a group and sends an invite.
- The invitee accepts/rejects.
- The creator sends `GROUP_WELCOME` + state update.
- Activated members subscribe to the current key epoch topic.

#### 6.2 Key rotation and epoch model

- The group key rotates on membership changes (join/leave/kick).
- Each epoch has a `key_version`.
- The system stores history and boundaries for secure processing of old/new messages.
- Old topics may remain active briefly (grace period) to reduce the transition gap.

#### 6.3 Offline group content

If publish has no active subscribers:
- the message goes into the group offline bucket
- the bucket is per-group, per-key-version, per-sender
- the store is compressed, signed, and versioned

#### 6.4 Nudge mechanism

Bucket nudges act as a best-effort signal for faster refetching.
Nudges are limited and validated (e.g. blocked/unknown sender guard), while the fallback remains the periodic DHT check.

---

### 7. File transfer

File transfer runs through a separate protocol (`fileTransferProtocol`) and uses the existing trust/session layer.

Flow:
1. The sender sends a `file_offer` (metadata + signature + timeout).
2. The receiver accepts/rejects.
3. If accepted, chunk transfer begins.
4. Chunks are encrypted, with checksum/integrity verification.
5. The UI receives progress/completion/failure events.

Protections:
- rate limits per peer and globally
- max pending file offers
- silent rejection after an abuse threshold
- filename/path traversal protection

---

### 8. DHT data model

Main categories of DHT records:

1. **Username registry**
   - by-name and by-peer mapping
   - signed payload
   - validator + selector + update rules

2. **Direct offline stores**
   - bucket per user pair
   - store-level and message-level signatures
   - anti-stale `validateUpdate`

3. **Group offline stores**
   - sender buckets per group/key-version

4. **Group info records**
   - `latest` pointer
   - `versioned` state records

All records go through the mode-aware namespace and validator/selector layer.

---

### 9. SQLite model (conceptual)

The application uses a single DB file, but with mode-aware scoping where it matters.

Most important tables:
- `users` (contact/public-key cache)
- `chats` (direct/group relationship source of truth)
- `messages`
- `encrypted_user_identities`
- `notifications`
- `chat_participants`
- `settings`
- `offline_sent_messages`
- `group_offline_sent_messages`
- `group_key_history`
- `group_offline_cursors`
- `group_pending_acks`
- `group_pending_info_publishes`
- `group_invite_delivery_acks`
- `group_sender_seq`, `group_member_seq`, `group_epoch_boundaries`
- `bootstrap_nodes`

Practical rule: contact visibility and chat operations should rely on relationship/context (`chats` + participants), not on the global users cache alone.

---

### 10. Connectivity and infrastructure

The desktop client can work with:

- **Bootstrap node** (`npm run bootstrap`)
  - mode-aware DHT protocol
  - validators active on the bootstrap node

- **Relay node** (`npm run relay`)
  - Circuit Relay v2 server
  - reservations and limits configurable through environment variables

The UI has a Connection Status dialog with:
- overview of bootstrap and relay nodes
- add/remove node actions
- retry bootstrap / retry relay reservations
- mode-sensitive display (e.g. relay tab only in fast mode)

---

### 11. UI and state management

The renderer uses React + Redux.

Main state slices:
- `userSlice` (peerId, connected, username, registration state)
- `chatSlice` (chat list, messages, pending key exchanges, contact attempts, file transfer state)

Event-driven sink from the main process:
- `onMessageReceived`
- `onChatCreated`
- `onKeyExchangeFailed`
- `onGroupChatActivated`
- `onGroupMembersUpdated`
- file transfer events

This allows the core to remain authoritative, while the UI is a reactive view of the state.

---

### 12. Security model and decisions

1. **E2EE direct chat**
   - session keys after key exchange
   - signed KX payload

2. **Offline protection**
   - message and store signatures
   - validators at the DHT layer

3. **Group integrity**
   - signed control messages
   - ACK + republish for delivery of key state updates

4. **Access control**
   - blocked peers
   - connection gater rules
   - contact mode (`active` / `silent` / `block`)

5. **Mode isolation**
   - protocols + DHT + pubsub + DB scoping

---

### 13. Reliability and operational strategies

The system has multiple resilience layers:

- DHT status probing (does not rely only on “socket up”)
- retry mechanisms for bootstrap/relay and republish queues
- single-flight protections in the group offline check path
- per-bucket mutation locks for offline store updates (avoiding lost update problems)
- periodic cleanup and cache prune tasks

---

### 14. Known tradeoffs and limits

- Mode switch requires restart (intentional in v1).
- A single SQLite file still carries the complexity of mode-aware queries.
- Offline fallback is robust, but still depends on DHT availability and propagation quality.
- Group control delivery is an eventual-consistency model (ACK + republish + refetch), not strict instant consistency.

---

### 15. Recommended "AI handoff" text

If you want to quickly start a new AI chat, it is enough to paste:

1. "Read `Kiyeovo_desktop_tehnicka_dokumentacija.md` as the source-of-truth architecture."
2. "I am currently working on [bug/feature description], in [fast/anonymous] mode, and the focus is on [direct/group/file/offline]."
3. "Give me a plan + minimal changes + regression risks."

---

### 16. Short glossary

- **KX**: key exchange
- **DCUtR**: Direct Connection Upgrade through Relay
- **Bucket nudge**: a lightweight signal to a peer to refetch the relevant offline bucket
- **Group epoch**: version of the group key (`key_version`)
- **Pending ACK queues**: local queues of messages periodically republished until an ACK arrives

---

### 17. Conclusion

The desktop version of Kiyeovo has evolved from a CLI prototype into a complex, mode-aware P2P system with clearly separated runtime layers (UI, IPC, core), multiple fallback mechanisms, and a serious focus on security and reliability.

For further development, the most important priorities are maintaining consistency of mode isolation, preserving simple and predictable flows in `MessageHandler`/group modules, and documenting every change that affects trust, identity, and DHT semantics.
