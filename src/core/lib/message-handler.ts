import { peerIdFromString } from '@libp2p/peer-id';
import type { ChatNode, StreamHandlerContext, AuthenticatedEncryptedMessage, OfflineMessage, OfflineSenderInfo, ConversationSession, EncryptedMessage, ContactMode, KeyExchangeEvent, ContactRequestEvent, ChatCreatedEvent, KeyExchangeFailedEvent, MessageReceivedEvent } from '../types.js';
import { CHAT_PROTOCOL, MESSAGE_TIMEOUT, SESSION_MANAGER_CLEANUP_INTERVAL } from '../constants.js';
import { SessionManager } from './session-manager.js';
import { MessageEncryption } from './message-encryption.js';
import { PeerConnectionHandler } from './peer-connection-handler.js';
import { StreamHandler } from './stream-handler.js';
import { KeyExchange } from './key-exchange.js';
import { ChatDatabase, Message, User } from './db/database.js';
import { OfflineMessageManager } from './offline-message-manager.js';
import { UsernameRegistry } from './username-registry.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { PeerId } from '@libp2p/interface';

/**
 * Main message handler that orchestrates all message handling components
 */
export class MessageHandler {
  private node: ChatNode;
  private usernameRegistry: UsernameRegistry;
  private sessionManager: SessionManager;
  private keyExchange: KeyExchange;
  private database: ChatDatabase;
  private cleanupPeerEvents: (() => void) | null = null;
  private onMessageReceived: (data: MessageReceivedEvent) => void;

  constructor(
    node: ChatNode,
    usernameRegistry: UsernameRegistry,
    database: ChatDatabase,
    onKeyExchangeSent: (data: KeyExchangeEvent) => void,
    onContactRequestReceived: (data: ContactRequestEvent) => void,
    onChatCreated: (data: ChatCreatedEvent) => void,
    onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void,
    onMessageReceived: (data: MessageReceivedEvent) => void,
  ) {
    this.node = node;
    this.usernameRegistry = usernameRegistry;
    this.database = database;
    this.sessionManager = new SessionManager();
    this.onMessageReceived = onMessageReceived;
    this.keyExchange = new KeyExchange(node, usernameRegistry, this.sessionManager, database, onKeyExchangeSent, onContactRequestReceived, onChatCreated, onKeyExchangeFailed);
    this.setupProtocolHandler();
    this.cleanupPeerEvents = PeerConnectionHandler.setupPeerEvents(node, this.sessionManager);
    this.startSessionCleanup();
  }

  /**
   * Sets up the chat protocol handler for incoming messages
   */
  private setupProtocolHandler(): void {
    void this.node.handle(CHAT_PROTOCOL, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      // Immediately check if the user is blocked
      try {
        if (this.database.isBlocked(remoteId)) {
          return;
        }
      } catch (e) {
        generalErrorHandler(e, `Error checking if user is blocked`);
        return;
      }
      StreamHandler.logIncomingConnection(remoteId, CHAT_PROTOCOL);

      try {
        const message = await StreamHandler.readMessageFromStream<EncryptedMessage>(stream);
        StreamHandler.logReceivedMessage(message);

        if (MessageEncryption.isKeyExchange(message)) {
          await this.keyExchange.handleKeyExchange(remoteId, message as AuthenticatedEncryptedMessage, stream);
          return;
        }

        const session = this.sessionManager.getSession(remoteId);
        if (!session) {
          console.log(`No session found, something went wrong.`);
          return;
        }
        const decryptedContent = MessageEncryption.decryptMessage(message, session);

        // Process ACK if included - clear acknowledged messages from our bucket
        if (message.offline_ack_timestamp) {
          console.log(`Clearing acknowledged messages up to ${message.offline_ack_timestamp}`);
          await this.processOfflineAck(remoteId, message.offline_ack_timestamp);
        }

        try {
          const chat = this.database.getChatByPeerId(remoteId);
          if (!chat) {
            throw new Error('Chat not found');
          }
          const messageId = crypto.randomUUID();
          await this.database.createMessage({
            id: messageId,
            chat_id: chat.id,
            sender_peer_id: remoteId,
            content: decryptedContent,
            message_type: 'text',
            timestamp: new Date()
          });
          console.log(`Saved message with ID: ${messageId}`);

          // Get sender username for the event
          const sender = this.database.getUserByPeerId(remoteId);
          const senderUsername = sender?.username || 'Unknown';

          // Fire message received event
          this.onMessageReceived({
            chatId: chat.id,
            messageId: messageId,
            content: decryptedContent,
            senderPeerId: remoteId,
            senderUsername: senderUsername,
            timestamp: Date.now()
          });
        } catch (error: unknown) {
          generalErrorHandler(error, `Error saving message to database`);
        }
        StreamHandler.logDecryptedMessage(remoteId, decryptedContent);
        this.sessionManager.incrementMessageCount(remoteId);
        this.sessionManager.updateSessionUsage(remoteId);
      } catch (error: unknown) {
        generalErrorHandler(error, `Error handling message from ${remoteId}`);
      }
    });
  }

  private startSessionCleanup(): void {
    setInterval(() => {
      if (this.sessionManager.getSessionsLength() !== 0) {
        this.sessionManager.cleanupExpiredSessions();
      }
      if (this.sessionManager.getPendingKeyExchangesLength() !== 0) {
        this.sessionManager.cleanupExpiredPendingKX();
      }
    }, SESSION_MANAGER_CLEANUP_INTERVAL);
  }

  /**
   * Ensures a user exists and has an active session with key rotation handling.
   */
  async ensureUserSession(targetUsernameOrPeerId: string, message: string): Promise<{
    user: User
    session: ConversationSession
    peerId: PeerId
  }> {
    let user = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
    let targetPeerId: PeerId;

    if (!user) {
      try {
        const userRegistration = await this.usernameRegistry.lookup(targetUsernameOrPeerId);
        targetPeerId = peerIdFromString(userRegistration.peerID);
      } catch (lookupErr: unknown) {
        throw new Error(`User '${targetUsernameOrPeerId}' not found: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}`);
      }

      user = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
      if (!user) {
        throw new Error('Key exchange failed');
      }
    } else {
      targetPeerId = peerIdFromString(user.peer_id);
      
      // Check if we need to upgrade from out-of-band trust to full key exchange
      const chat = this.database.getChatByPeerId(targetPeerId.toString());
      if (chat?.trusted_out_of_band) {
        try {
          console.log(`Chat with ${targetUsernameOrPeerId} was established out-of-band.
            Upgrading to full key exchange if user is online...`);
          const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
          if (exchangedUser) {
            user = exchangedUser;
            console.log(`✓ Upgraded to stronger encryption with ECDH-derived keys`);
          } else {
            console.warn(`Key exchange upgrade failed, falling back to out-of-band keys`);
          }
        } catch (err: unknown) {
          const errorText = String(err instanceof Error ? err.message : err).toLowerCase();
          console.log(errorText);
          if (errorText.includes('all multiaddr dials failed')) {
            throw new Error('Trusted user is offline. Cannot upgrade. Sending offline message.')
          }
          throw err;
        }
      }
    }

    if (this.database.isBlocked(targetPeerId.toString())) {
      throw new Error('User is blocked. Cannot send messages.');
    }

    // Get or create session
    let session = this.sessionManager.getSession(targetPeerId.toString());
    if (!session) {
      console.log(`No session found, initiating key exchange with ${targetUsernameOrPeerId}`);

      const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
      if (!exchangedUser) {
        throw new Error('Key exchange failed');
      }

      session = this.sessionManager.getSession(targetPeerId.toString());
      if (!session) {
        throw new Error('Key exchange succeeded but session not created');
      }
    }

    // Block message sending if rotation is in progress
    const hasPendingRotation = this.sessionManager.getPendingKeyExchange(targetPeerId.toString());
    if (hasPendingRotation) {
      throw new Error('Key rotation in progress - please wait and try again');
    }

    // Check if we need to rotate keys
    if (session.messageCount >= this.keyExchange.getKeyRotationThreshold()) {
      console.log(`Rotating keys for ${targetUsernameOrPeerId} (${session.messageCount} messages sent)`);
      const succeeded = await this.keyExchange.rotateSessionKeys(targetPeerId);
      if (succeeded) {
        session = this.sessionManager.getSession(targetPeerId.toString());
        if (!session) {
          throw new Error('Key rotation succeeded but session not found');
        }
      } else {
        this.sessionManager.clearSession(targetPeerId.toString());
        throw new Error('Key rotation failed - session cleared. Please try sending your message again.');
      }
    }

    return { user, session, peerId: targetPeerId };
  }

  async sendMessage(targetUsernameOrPeerId: string, message: string): Promise<{ success: boolean, messageSentStatus: 'online' | 'offline' | null, error: string | null }> {
    let user: User | null = null;
    try {
      const { user: resolvedUser, session, peerId: targetPeerId } = await this.ensureUserSession(targetUsernameOrPeerId, message);
      user = resolvedUser;

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(targetPeerId.toString());
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(targetPeerId.toString());
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      const sendWithTimeout = async (): Promise<boolean> => {
        const stream = await this.node.dialProtocol(targetPeerId, CHAT_PROTOCOL);

        const currentUsername = this.usernameRegistry.getCurrentUsername();
        const encryptedMessage = MessageEncryption.encryptMessage(
          message,
          session
        );

        if (currentUsername) {
          encryptedMessage.senderUsername = currentUsername;
        }

        // Include ACK if we've read new offline messages from this peer
        if (shouldSendAck) {
          encryptedMessage.offline_ack_timestamp = lastReadTimestamp;
        }

        await StreamHandler.writeMessageToStream(stream, encryptedMessage);

        this.sessionManager.incrementMessageCount(targetPeerId.toString());
        this.sessionManager.updateSessionUsage(targetPeerId.toString());
        return true;
      };

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => { reject(new Error('Message timeout')); }, MESSAGE_TIMEOUT)
      );

      const res = await Promise.race([sendWithTimeout(), timeoutPromise]);
      if (res) {
        await this.saveMessageToDatabase(targetPeerId.toString(), message);
        // Update ACK sent timestamp if we included an ACK
        if (shouldSendAck) {
          this.database.updateOfflineLastAckSentByPeerId(targetPeerId.toString(), lastReadTimestamp);
        }
        console.log(`Encrypted message sent to ${targetUsernameOrPeerId}`);
        return { success: true, messageSentStatus: 'online', error: null };
      }
      return { success: false, messageSentStatus: null, error: 'Failed to send message - timed out' };
    } catch (err: unknown) {
      console.error(`Failed to send message to ${targetUsernameOrPeerId}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const errorText = String(err instanceof Error ? err.message : err).toLowerCase();
        const shouldFallbackOffline = /econnrefused|user is offline|all multiaddr dials failed|message timeout|socks|tor transport|enetunreach|no valid addresses|ehostunreach|etimedout/.test(errorText);
        if (shouldFallbackOffline) {
          console.log(`Trying to send offline message to ${targetUsernameOrPeerId}`);
          // Use user from key exchange if available, otherwise query database
          user ??= this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
          if (!user) throw new Error('User not found in database');

          // Get the shared secret part of the bucket key
          const bucketSecret = this.database.getOfflineBucketSecretByPeerId(user.peer_id);
          if (!bucketSecret) {
            throw new Error('Offline bucket secret not found');
          }
          // Standard construction works for both ECDH-derived and random secrets
          const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);

          await this.storeOfflineMessageDB(user, writeBucketKey, message);
          console.log(`Peer likely offline; stored message for ${targetUsernameOrPeerId} as offline.`);
          return { success: true, messageSentStatus: 'offline', error: null };
        }

        console.log(`Offline message fallback failed`);
        throw err;
      } catch (offlineErr: unknown) {
        generalErrorHandler(offlineErr, `Failed to store offline message`);
        return { success: false, messageSentStatus: null, error: 'Failed to store offline message: ' + (
          offlineErr instanceof Error ? offlineErr.message : String(offlineErr)) };
      }
    }
  }

  private async storeOfflineMessageDB(user: User, writeBucketKey: string, message: string): Promise<void> {
    try {
      const currentUsername = this.usernameRegistry.getCurrentUsername() ?? 'unknown';
      const userIdentity = this.usernameRegistry.getUserIdentity();

      if (!userIdentity) throw new Error('User identity not available');

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(user.peer_id);
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(user.peer_id);
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      // Create offline message encrypted with recipient's RSA public key
      // The bucket key is included in the signature for DHT validation
      const offlineMessage = OfflineMessageManager.createOfflineMessage(
        this.node.peerId.toString(),
        currentUsername,
        message,
        Buffer.from(user.offline_public_key, 'base64').toString(), // RSA public key (PEM)
        userIdentity.signingPrivateKey,
        writeBucketKey,
        shouldSendAck ? lastReadTimestamp : undefined
      );

      // Store in DHT at our WRITE bucket
      await OfflineMessageManager.storeOfflineMessage(
        this.node,
        writeBucketKey,
        offlineMessage,
        userIdentity.signingPrivateKey,
        this.database
      );
      console.log(`Stored encrypted offline message for ${user.username}`);

      // Update ACK sent timestamp if we included an ACK
      if (shouldSendAck) {
        this.database.updateOfflineLastAckSentByPeerId(user.peer_id, lastReadTimestamp);
      }

      await this.saveMessageToDatabase(user.peer_id, message);
      console.log(`Saved offline message to sender's database`);
    } catch (error: unknown) {
      generalErrorHandler(error);
      throw error;
    }
  }

  private async saveMessageToDatabase(
    peerId: string,
    message: string
  ): Promise<void> {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) {
      console.log(`This should never happen!!!!`);
      throw new Error('Chat not found');
    }

    const messageId = await this.database.createMessage({
      id: crypto.randomUUID(),
      chat_id: chat.id,
      sender_peer_id: this.node.peerId.toString(),
      content: message,
      message_type: 'text',
      timestamp: new Date()
    });
    console.log(`Saved message with ID: ${messageId}`);
  }

  // Check offline messages (direct)
  private async performOfflineMessageCheck(): Promise<void> {
    console.log("Checking for offline direct messages...");

    // Get bucket info for reading: secret + peer's signing public key
    const bucketInfoList = this.database.getOfflineReadBucketInfo(10);

    if (bucketInfoList.length === 0) {
      console.log('No chats found for offline message check');
      return;
    }

    // Construct read bucket keys (uses peer's pubkey to read their messages)
    const readBuckets: Array<{ key: string; peerPubKey: string; peerId: string; lastReadTimestamp: number }> = [];
    for (const info of bucketInfoList) {
      // Standard construction works for both ECDH-derived and random secrets
      const readBucketKey = this.keyExchange.constructReadBucketKey(
        info.offline_bucket_secret,
        info.signing_public_key
      );
      readBuckets.push({
        key: readBucketKey,
        peerPubKey: info.signing_public_key,
        peerId: info.peer_id,
        lastReadTimestamp: info.offline_last_read_timestamp
      });
    }

    const bucketKeys = readBuckets.map(b => b.key);
    const store = await OfflineMessageManager.getOfflineMessages(this.node, bucketKeys);

    if (store.messages.length === 0) {
      console.log('No offline direct messages found');
      return;
    }

    console.log(`Found ${store.messages.length} offline direct message(s)`);

    // Track max timestamp per peer to update after processing
    const maxTimestampPerPeer: Map<string, number> = new Map();
    let processedCount = 0;

    for (const msg of store.messages) {
      if (!msg.bucket_key) continue;
      try {
        const userIdentity = this.usernameRegistry.getUserIdentity();
        if (!userIdentity) {
          console.log(`Skipping message - no user identity available`);
          continue;
        }

        const bucketInfo = readBuckets.find(b => b.key === msg.bucket_key);
        if (!bucketInfo) {
          console.log(`Skipping message - unknown bucket key`);
          continue;
        }

        // Skip messages we've already processed (based on last read timestamp)
        if (msg.timestamp <= bucketInfo.lastReadTimestamp) {
          continue;
        }

        const isSignatureValid = OfflineMessageManager.verifyOfflineMessageSignature(
          msg,
          bucketInfo.peerPubKey,
          msg.bucket_key
        );

        if (!isSignatureValid) {
          console.log(`Skipping message - signature verification failed`);
          continue;
        }

        // Decrypt sender info to get username for display
        const senderInfo = MessageEncryption.decryptSenderInfo(msg, userIdentity.offlinePrivateKey);
        if (!senderInfo) {
          console.log(`Skipping message - failed to decrypt sender info`);
          continue;
        }

        // Skip messages sent by ourselves (shouldn't happen)
        if (senderInfo.peer_id === this.node.peerId.toString()) {
          console.log(`Skipping own message`);
          continue;
        }

        // Process ACK if included - clear acknowledged messages from our bucket
        if (senderInfo.offline_ack_timestamp) {
          // eslint-disable-next-line no-await-in-loop
          await this.processOfflineAck(senderInfo.peer_id, senderInfo.offline_ack_timestamp);
        }

        // eslint-disable-next-line no-await-in-loop
        await this.saveOfflineMessageToDatabase(msg, senderInfo);
        processedCount++;

        // Track max timestamp for this peer
        const currentMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
        if (msg.timestamp > currentMax) {
          maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
        }

        console.log(`Delivered offline message from ${senderInfo.username}`);
      } catch (error: unknown) {
        generalErrorHandler(error, `Failed to process offline message`);
      }
    }

    // Update last read timestamp for each peer
    for (const [peerId, maxTimestamp] of maxTimestampPerPeer.entries()) {
      this.database.updateOfflineLastReadTimestampByPeerId(peerId, maxTimestamp);
    }

    if (processedCount > 0) {
      console.log(`Processed ${processedCount} new offline direct messages`);
    }
  }

  async checkOfflineMessages(): Promise<void> {
    try {
      await this.performOfflineMessageCheck();
    } catch (error: unknown) {
      generalErrorHandler(error);
    }
  }

  // Process an ACK from a peer - clear acknowledged messages from our bucket.
  private async processOfflineAck(peerId: string, ackTimestamp: number): Promise<void> {
    try {
      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) {
        console.log('Cannot process ACK - no user identity');
        return;
      }

      // Get the bucket key for messages we sent to this peer
      const bucketSecret = this.database.getOfflineBucketSecretByPeerId(peerId);
      if (!bucketSecret) {
        console.log('Cannot process ACK - no bucket secret found');
        return;
      }

      const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);

      // Clear acknowledged messages from our local store and update DHT
      await OfflineMessageManager.clearAcknowledgedMessages(
        this.node,
        writeBucketKey,
        ackTimestamp,
        userIdentity.signingPrivateKey,
        this.database
      );

      console.log(`Processed ACK from ${peerId} - cleared messages up to ${ackTimestamp}`);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to process offline ACK');
    }
  }

  /**
   * Save an offline message to the database.
   * Note: Signature verification is already done in performOfflineMessageCheck before calling this.
   */
  private async saveOfflineMessageToDatabase(
    msg: OfflineMessage,
    senderInfo: OfflineSenderInfo,
  ): Promise<void> {
    console.log(`Processing offline message from ${senderInfo.username} (${senderInfo.peer_id})`);

    const chat = this.database.getChatByPeerId(senderInfo.peer_id);
    if (!chat) {
      throw new Error('Chat not found');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    let decryptedContent = msg.content;
    if (msg.message_type === 'encrypted') {
      decryptedContent = MessageEncryption.decryptOfflineMessage(msg, userIdentity.offlinePrivateKey);
    }

    const messageId = await this.database.createMessage({
      id: crypto.randomUUID(),
      chat_id: chat.id,
      sender_peer_id: senderInfo.peer_id,
      content: decryptedContent,
      message_type: 'text',
      timestamp: new Date(msg.timestamp)
    });
    console.log(`Saved offline message with ID: ${messageId}`);
  }

  cleanup(): void {
    if (this.cleanupPeerEvents) {
      this.cleanupPeerEvents();
    }
    this.sessionManager.clearAll();
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getKeyExchange(): KeyExchange {
    return this.keyExchange;
  }

  getHistory(username: string): void {
    const user = this.database.getUserByUsername(username);
    if (!user) throw new Error('User not found');

    const chat = this.database.getChatByPeerId(user.peer_id);
    if (!chat) throw new Error('Chat not found');

    const messages = this.database.getMessagesByChatId(chat.id)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    console.log(`History with ${username}:`);
    if (messages.length === 0) {
      console.log('You have no messages with this user');
      return;
    }

    messages.forEach((message: Message) => {
      if (message.sender_peer_id === user.peer_id) {
        console.log(`${username} - ${message.content}`);
      } else {
        console.log(`${this.usernameRegistry.getCurrentUsername()} - ${message.content}`);
      }
    });
  }

  handleSetContactMode(mode: ContactMode): void {
    try {
      this.database.setContactMode(mode);
      console.log(`Contact mode set to: ${mode}`);

      if (mode === 'active') {
        console.log('You will see contact requests and can accept/reject them');
      } else if (mode === 'silent') {
        console.log('Contact requests will be logged silently (check with contact-log)');
      } else {
        console.log('All contact requests will be blocked');
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `Failed to set contact mode`);
    }
  }
} 