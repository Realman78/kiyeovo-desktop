import { peerIdFromString } from '@libp2p/peer-id';
import type { ChatNode, StreamHandlerContext, AuthenticatedEncryptedMessage, OfflineMessage, OfflineSenderInfo, ConversationSession, EncryptedMessage, ContactMode, KeyExchangeEvent, ContactRequestEvent, ChatCreatedEvent, KeyExchangeFailedEvent, MessageReceivedEvent, SendMessageResponse, StrippedMessage, MessageSentStatus, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, PendingFileReceivedEvent, GroupChatActivatedEvent, GroupMembersUpdatedEvent } from '../types.js';
import {
  CHAT_PROTOCOL,
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  MESSAGE_TIMEOUT,
  SESSION_MANAGER_CLEANUP_INTERVAL,
  BUCKET_NUDGE_PROTOCOL,
  BUCKET_NUDGE_COOLDOWN_MS,
  BUCKET_NUDGE_DIAL_TIMEOUT_MS,
  BUCKET_NUDGE_FETCH_DELAY_MS,
  BUCKET_NUDGE_RETRY_DELAY_MS,
  GROUP_ACK_REPUBLISH_STARTUP_DELAY,
  GROUP_ACK_REPUBLISH_INTERVAL,
  GROUP_ACK_REPUBLISH_JITTER
} from '../constants.js';
import { SessionManager } from './session-manager.js';
import { MessageEncryption } from './message-encryption.js';
import { PeerConnectionHandler } from './peer-connection-handler.js';
import { StreamHandler } from './stream-handler.js';
import { KeyExchange } from './key-exchange.js';
import { ChatDatabase, Message, User } from './db/database.js';
import { OfflineMessageManager } from './offline-message-manager.js';
import { UsernameRegistry } from './username-registry.js';
import { FileHandler } from './file-handler.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { PeerId } from '@libp2p/interface';
import { GroupMessageType, type GroupInvite } from './group/types.js';
import { GroupCreator } from './group/group-creator.js';
import { GroupResponder } from './group/group-responder.js';

/**
 * Main message handler that orchestrates all message handling components
 */
export class MessageHandler {
  private node: ChatNode;
  private usernameRegistry: UsernameRegistry;
  private sessionManager: SessionManager;
  private keyExchange: KeyExchange;
  private fileHandler: FileHandler;
  private database: ChatDatabase;
  private cleanupPeerEvents: (() => void) | null = null;
  private onMessageReceived: (data: MessageReceivedEvent) => void;
  private onGroupChatActivated: (data: GroupChatActivatedEvent) => void;
  private onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void;
  private onOfflineMessagesFetchComplete: ((chatIds: number[]) => void) | undefined;
  private nudgeCooldowns = new Map<string, number>();
  private nudgeFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private peerActivityCheckCooldowns = new Map<string, number>();
  private groupAckRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckRepublishInFlight = false;

  constructor(
    node: ChatNode,
    usernameRegistry: UsernameRegistry,
    database: ChatDatabase,
    onKeyExchangeSent: (data: KeyExchangeEvent) => void,
    onContactRequestReceived: (data: ContactRequestEvent) => void,
    onChatCreated: (data: ChatCreatedEvent) => void,
    onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void,
    onMessageReceived: (data: MessageReceivedEvent) => void,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void,
    onGroupChatActivated: (data: GroupChatActivatedEvent) => void,
    onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void,
    onOfflineMessagesFetchComplete?: (chatIds: number[]) => void,
  ) {
    this.node = node;
    this.usernameRegistry = usernameRegistry;
    this.database = database;
    this.sessionManager = new SessionManager();
    this.onMessageReceived = onMessageReceived;
    this.onGroupChatActivated = onGroupChatActivated;
    this.onGroupMembersUpdated = onGroupMembersUpdated;
    this.onOfflineMessagesFetchComplete = onOfflineMessagesFetchComplete;
    this.keyExchange = new KeyExchange(node, usernameRegistry, this.sessionManager, database, onKeyExchangeSent, onContactRequestReceived, onChatCreated, onKeyExchangeFailed);
    this.fileHandler = new FileHandler(node, this, database, onFileTransferProgress, onFileTransferComplete, onFileTransferFailed, onPendingFileReceived);
    this.setupProtocolHandler();
    this.cleanupPeerEvents = PeerConnectionHandler.setupPeerEvents(node, this.sessionManager);
    this.startSessionCleanup();
    this.startGroupAckRepublisher();
  }

  // Get configuration value from database with fallback to constant
  private getChatsToCheckForOfflineMessages(): number {
    const setting = this.database.getSetting('chats_to_check_for_offline_messages');
    return setting ? parseInt(setting, 10) : CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES;
  }

  public nudgePeer(peerId: string): void {
    // Do not force-dial just to send a nudge.
    const hasActiveConnection = this.node.getConnections().some(
      conn => conn.remotePeer.toString() === peerId
    );
    if (!hasActiveConnection) {
      return;
    }

    const last = this.nudgeCooldowns.get(peerId) ?? 0;
    if (Date.now() - last < BUCKET_NUDGE_COOLDOWN_MS) {
      console.log(`[NUDGE] Cooldown active for ${peerId.slice(-8)}, skipping`);
      return;
    }
    this.nudgeCooldowns.set(peerId, Date.now());

    void (async () => {
      try {
        const targetPeerId = peerIdFromString(peerId);
        const stream = await this.node.dialProtocol(targetPeerId, BUCKET_NUDGE_PROTOCOL, {
          signal: AbortSignal.timeout(BUCKET_NUDGE_DIAL_TIMEOUT_MS),
        });
        await stream.close();
        console.log(`[NUDGE] Sent bucket nudge to ${peerId.slice(-8)}`);
      } catch {
        // Best-effort — peer offline or unreachable, offline bucket still delivers
      }
    })();
  }

  /**
   * Sets up the chat protocol handler for incoming messages
   */
  private setupProtocolHandler(): void {
    void this.node.handle(BUCKET_NUDGE_PROTOCOL, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      await stream.close();

      // Ignore nudges from blocked peers
      if (this.database.isBlocked(remoteId)) return;

      const chat = this.database.getChatByPeerId(remoteId);
      if (!chat) {
        console.log(`[NUDGE] Received nudge from ${remoteId.slice(-8)} but no chat found, ignoring`);
        return;
      }

      console.log(`[NUDGE] Received bucket nudge from ${remoteId.slice(-8)}, scheduling check for chat ${chat.id}`);
      this.scheduleNudgeOfflineCheck(remoteId, chat.id);
    });

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
          const hadUserAtStart = !!this.database.getUserByPeerId(remoteId);
          await this.keyExchange.handleKeyExchange(remoteId, message as AuthenticatedEncryptedMessage, stream);
          // Fallback B only for initial handshake from an existing known contact.
          if (message.content === 'key_exchange_init' && hadUserAtStart) {
            this.schedulePeerActivityOfflineCheck(remoteId);
          }
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
            timestamp: Date.now(),
            messageSentStatus: 'online'
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

  private scheduleNudgeOfflineCheck(remoteId: string, chatId: number): void {
    const existingTimer = this.nudgeFetchTimers.get(remoteId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.nudgeFetchTimers.delete(remoteId);
      void this.runNudgeOfflineCheck(remoteId, chatId, false, true);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.nudgeFetchTimers.set(remoteId, timer);
  }

  private async runNudgeOfflineCheck(remoteId: string, chatId: number, isRetry: boolean, allowRetry: boolean): Promise<void> {
    try {
      const beforeTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      const { checkedChatIds } = await this.checkOfflineMessages([chatId]);
      const afterTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      const hasNewData = afterTimestamp > beforeTimestamp;

      if (checkedChatIds.length > 0 && hasNewData) {
        this.onOfflineMessagesFetchComplete?.(checkedChatIds);
      }

      if (!isRetry && allowRetry && !hasNewData) {
        setTimeout(() => {
          void this.runNudgeOfflineCheck(remoteId, chatId, true, allowRetry);
        }, BUCKET_NUDGE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[NUDGE] Failed offline bucket check for ${remoteId.slice(-8)}`);
    }
  }

  private schedulePeerActivityOfflineCheck(peerId: string): void {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) return;

    const last = this.peerActivityCheckCooldowns.get(peerId) ?? 0;
    if (Date.now() - last < BUCKET_NUDGE_COOLDOWN_MS) {
      return;
    }
    this.peerActivityCheckCooldowns.set(peerId, Date.now());

    // If a nudge/activity check is already queued for this peer, do not reset it.
    if (this.nudgeFetchTimers.has(peerId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.nudgeFetchTimers.delete(peerId);
      // Fallback B is a single extra check on key-exchange activity (no retry).
      void this.runNudgeOfflineCheck(peerId, chat.id, false, false);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.nudgeFetchTimers.set(peerId, timer);
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

  private startGroupAckRepublisher(): void {
    if (this.groupAckStartupTimer) {
      clearTimeout(this.groupAckStartupTimer);
    }
    this.groupAckStartupTimer = setTimeout(() => {
      this.groupAckStartupTimer = null;
      void this.runGroupAckRepublishCycle();
      this.scheduleNextGroupAckRepublish();
    }, GROUP_ACK_REPUBLISH_STARTUP_DELAY);
  }

  private scheduleNextGroupAckRepublish(): void {
    if (this.groupAckRepublishTimer) {
      clearTimeout(this.groupAckRepublishTimer);
    }
    const jitter = (Math.random() * 2 - 1) * GROUP_ACK_REPUBLISH_JITTER;
    const delay = Math.max(1000, GROUP_ACK_REPUBLISH_INTERVAL + jitter);
    this.groupAckRepublishTimer = setTimeout(() => {
      void this.runGroupAckRepublishCycle();
      this.scheduleNextGroupAckRepublish();
    }, delay);
  }

  private async runGroupAckRepublishCycle(): Promise<void> {
    if (this.groupAckRepublishInFlight) return;
    this.groupAckRepublishInFlight = true;
    try {
      // No peers connected means no useful republish work right now.
      if (this.node.getConnections().length === 0) return;

      const pendingAcks = this.database.getAllPendingAcks();
      if (pendingAcks.length === 0) return;

      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) return;

      const myPeerId = this.node.peerId.toString();
      const myUser = this.database.getUserByPeerId(myPeerId);
      const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

      const deps = {
        node: this.node,
        database: this.database,
        userIdentity,
        myPeerId,
        myUsername,
        onGroupChatActivated: this.onGroupChatActivated,
        onGroupMembersUpdated: this.onGroupMembersUpdated,
        nudgePeer: this.nudgePeer.bind(this),
      };

      const creator = new GroupCreator(deps);
      const responder = new GroupResponder(deps);

      for (const pending of pendingAcks) {
        try {
          if (pending.message_type === 'GROUP_INVITE') {
            let inviteId: string | null = null;
            try {
              const invite = JSON.parse(pending.message_payload) as GroupInvite;
              inviteId = invite.inviteId;
            } catch {
              console.warn(
                `[GROUP-ACK] Removing invalid pending payload: type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)}`
              );
              this.database.removePendingAck(
                pending.group_id,
                pending.target_peer_id,
                pending.message_type,
              );
              continue;
            }

            if (
              inviteId &&
              this.database.isInviteDeliveryAckReceived(
                pending.group_id,
                pending.target_peer_id,
                inviteId,
              )
            ) {
              console.log(
                `[GROUP-ACK] Skipping delivered invite ${inviteId} for ${pending.target_peer_id.slice(-8)}`
              );
              continue;
            }
          }

          // TODO extend to support other group message types
          if (pending.message_type === 'GROUP_INVITE_RESPONSE') {
            // Responder -> creator flow
            // eslint-disable-next-line no-await-in-loop
            await responder.republishPendingControl(pending.target_peer_id, pending.message_payload);
          } else {
            // Creator -> members flow
            // eslint-disable-next-line no-await-in-loop
            await creator.republishPendingControl(pending.target_peer_id, pending.message_payload);
          }

          this.database.updatePendingAckLastPublished(
            pending.group_id,
            pending.target_peer_id,
            pending.message_type,
          );
        } catch (error: unknown) {
          generalErrorHandler(
            error,
            `[GROUP-ACK] Failed to re-publish ${pending.message_type} to ${pending.target_peer_id.slice(-8)}`,
          );
        }
      }
    } finally {
      this.groupAckRepublishInFlight = false;
    }
  }

  /**
   * Ensures a user exists and has an active session with key rotation handling.
   */
  async ensureUserSession(
    targetUsernameOrPeerId: string,
    message: string,
    isFileTransfer = false,
    initialUser?: User | null
  ): Promise<{
    user: User
    session: ConversationSession
    peerId: PeerId
    keyExchangeOccurred: boolean
  }> {
    const initialUserProvided = initialUser !== undefined;
    let user = initialUserProvided
      ? initialUser
      : this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
    let targetPeerId: PeerId;
    let keyExchangeOccurred = false;

    if (!user) {
      if (isFileTransfer) {
        throw new Error('Cannot send file as first message. Send a text message first.');
      }

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
      keyExchangeOccurred = true;
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
            keyExchangeOccurred = true;
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

      try {
        const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
        if (!exchangedUser) {
          throw new Error('Key exchange failed');
        }
        keyExchangeOccurred = true;

        session = this.sessionManager.getSession(targetPeerId.toString());
        if (!session) {
          throw new Error('Key exchange succeeded but session not created');
        }
      } catch (error: unknown) {
        // Silently abort if user cancelled - don't show error
        if (error instanceof Error && error.message === 'KEY_EXCHANGE_CANCELLED') {
          throw error; // Propagate to sendMessage for silent handling
        }
        throw error; // Re-throw other errors normally
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

    return { user, session, peerId: targetPeerId, keyExchangeOccurred };
  }

  async sendMessage(targetUsernameOrPeerId: string, message: string): Promise<SendMessageResponse> {
    let user: User | null = null;
    try {
      const initialUser = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
      const hadUserAtStart = !!initialUser;
      const hadConnectionBefore = initialUser
        ? this.node.getConnections().some(conn => conn.remotePeer.toString() === initialUser.peer_id)
        : false;

      const { user: resolvedUser, session, peerId: targetPeerId, keyExchangeOccurred } = await this.ensureUserSession(
        targetUsernameOrPeerId,
        message,
        false,
        initialUser
      );
      user = resolvedUser;

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(targetPeerId.toString());
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(targetPeerId.toString());
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      const sendWithTimeout = async (): Promise<boolean> => {
        const stream = await this.node.dialProtocol(targetPeerId, CHAT_PROTOCOL);

        // Get my own username from database (last registered username) or generate fallback
        const myPeerId = this.node.peerId.toString();
        const myUser = this.database.getUserByPeerId(myPeerId);
        const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

        const encryptedMessage = MessageEncryption.encryptMessage(
          message,
          session
        );

        encryptedMessage.senderUsername = myUsername;

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
        const strippedMessage = await this.saveMessageToDatabase(targetPeerId.toString(), message, 'online');
        // Update ACK sent timestamp if we included an ACK
        if (shouldSendAck) {
          this.database.updateOfflineLastAckSentByPeerId(targetPeerId.toString(), lastReadTimestamp);
        }

        // Fallback B:
        // only after key exchange with an already-known contact and only if no connection existed
        // before this send (meaning connected-only BUCKET_NUDGE path could not have helped).
        if (keyExchangeOccurred && hadUserAtStart && !hadConnectionBefore) {
          this.schedulePeerActivityOfflineCheck(targetPeerId.toString());
        }

        console.log(`Encrypted message sent to ${targetUsernameOrPeerId}`);
        return { success: true, messageSentStatus: 'online', error: null, message: strippedMessage };
      }
      return { success: false, messageSentStatus: null, error: 'Failed to send message - timed out' };
    } catch (err: unknown) {
      // Silently handle cancelled key exchanges - user intentionally cancelled
      if (err instanceof Error && err.message === 'KEY_EXCHANGE_CANCELLED') {
        console.log(`Message not sent - key exchange was cancelled by user`);
        return { success: true, messageSentStatus: null, error: null }; // Return success to avoid showing error
      }

      console.error(`Failed to send message to ${targetUsernameOrPeerId}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const errorText = String(err instanceof Error ? err.message : err).toLowerCase();
        console.log("errorText :>> ", errorText);
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

          const strippedMessage = await this.storeOfflineMessageDB(user, writeBucketKey, message);
          console.log(`Peer likely offline; stored message for ${targetUsernameOrPeerId} as offline.`);
          return { success: true, messageSentStatus: 'offline', message: strippedMessage, error: null };
        } else if (errorText.includes("username not found")) {
          return { success: false, messageSentStatus: null, error: `User ${targetUsernameOrPeerId} not found`};
        }

        console.log(`Offline message fallback failed`);
        throw err;
      } catch (offlineErr: unknown) {
        generalErrorHandler(offlineErr, `Failed to send message`);
        return { success: false, messageSentStatus: null, error: 'Failed to send message: ' + (
          offlineErr instanceof Error ? offlineErr.message : String(offlineErr)) };
      }
    }
  }

  private async storeOfflineMessageDB(user: User, writeBucketKey: string, message: string): Promise<StrippedMessage> {
    try {
      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) throw new Error('User identity not available');

      // Get my own username from database (last registered username) or generate fallback
      const myPeerId = this.node.peerId.toString();
      const myUser = this.database.getUserByPeerId(myPeerId);
      const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(user.peer_id);
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(user.peer_id);
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      // Create offline message encrypted with recipient's RSA public key
      // The bucket key is included in the signature for DHT validation
      const offlineMessage = OfflineMessageManager.createOfflineMessage(
        this.node.peerId.toString(),
        myUsername,
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

      const strippedMessage = await this.saveMessageToDatabase(user.peer_id, message, 'offline');
      console.log(`Saved offline message to sender's database`);
      return strippedMessage;
    } catch (error: unknown) {
      generalErrorHandler(error);
      throw error;
    }
  }

  private async saveMessageToDatabase(
    peerId: string,
    message: string,
    messageSentStatus: MessageSentStatus
  ): Promise<StrippedMessage> {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) {
      console.log(`This should never happen!!!!`);
      throw new Error('Chat not found');
    }

    const timestamp = new Date();
    const messageId = await this.database.createMessage({
      id: crypto.randomUUID(),
      chat_id: chat.id,
      sender_peer_id: this.node.peerId.toString(),
      content: message,
      message_type: 'text',
      timestamp
    });
    console.log(`Saved message with ID: ${messageId}`);

    // Notify frontend so sender's UI updates
    // Get my own username from database (last registered username) or generate fallback
    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    this.onMessageReceived({
      messageId,
      chatId: chat.id,
      senderPeerId: this.node.peerId.toString(),
      senderUsername: myUsername,
      content: message,
      timestamp: timestamp.getTime(),
      messageSentStatus
    });

    return {chatId: chat.id, messageId, content: message, timestamp: timestamp.getTime(), messageType: 'text'};
  }

  // Check offline messages (direct)
  private async performOfflineMessageCheck(chatIds?: number[]): Promise<{checkedChatIds: number[], unreadFromChats: Map<number, number>}> {
    console.log(chatIds
      ? `Checking for offline messages in ${chatIds.length} chat${chatIds.length > 1 ? 's' : ''}...`
      : "Checking for offline direct messages (top 10)...");

    // Get bucket info for reading: secret + peer's signing public key
    const bucketInfoList = chatIds
      ? this.database.getOfflineReadBucketInfoForChats(chatIds)
      : this.database.getOfflineReadBucketInfo(this.getChatsToCheckForOfflineMessages());

    if (bucketInfoList.length === 0) {
      console.log('No chats found for offline message check');
      return {checkedChatIds: [], unreadFromChats: new Map()};
    }

    // Construct read bucket keys (uses peer's pubkey to read their messages)
    const readBuckets: Array<{ chatId?: number; key: string; peerPubKey: string; peerId: string; lastReadTimestamp: number }> = [];
    const checkedChats: number[] = [];

    for (const info of bucketInfoList) {
      // Standard construction works for both ECDH-derived and random secrets
      const readBucketKey = this.keyExchange.constructReadBucketKey(
        info.offline_bucket_secret,
        info.signing_public_key
      );

      const chatId = 'chat_id' in info ? (info as any).chat_id as number : undefined;

      if (chatId !== undefined) {
        readBuckets.push({
          chatId,
          key: readBucketKey,
          peerPubKey: info.signing_public_key,
          peerId: info.peer_id,
          lastReadTimestamp: info.offline_last_read_timestamp
        });
        checkedChats.push(chatId);
      } else {
        readBuckets.push({
          key: readBucketKey,
          peerPubKey: info.signing_public_key,
          peerId: info.peer_id,
          lastReadTimestamp: info.offline_last_read_timestamp
        });
      }
    }

    const bucketKeys = readBuckets.map(b => b.key);
    const store = await OfflineMessageManager.getOfflineMessages(this.node, bucketKeys);

    if (store.messages.length === 0) {
      console.log('No offline direct messages found');
      return {checkedChatIds: checkedChats, unreadFromChats: new Map()};
    }

    console.log(`Found ${store.messages.length} offline direct message(s)`);
    const byBucket = new Map<string, number>();
    const uniquePerBucket = new Map<string, Set<string>>();
    for (const msg of store.messages) {
      const bucket = msg.bucket_key ?? 'unknown';
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
      if (!uniquePerBucket.has(bucket)) {
        uniquePerBucket.set(bucket, new Set());
      }
      uniquePerBucket.get(bucket)!.add(msg.id);
    }
    for (const [bucket, count] of byBucket.entries()) {
      const uniqueCount = uniquePerBucket.get(bucket)?.size ?? 0;
      const duplicates = count - uniqueCount;
      const bucketInfo = readBuckets.find(b => b.key === bucket);
      console.log(
        `[OFFLINE][PROCESS] bucket=${bucket.slice(0, 48)}... fetched=${count} uniqueIds=${uniqueCount} duplicates=${Math.max(0, duplicates)} ` +
        `lastReadTs=${bucketInfo?.lastReadTimestamp ?? 'n/a'} peer=${bucketInfo?.peerId ?? 'n/a'}`
      );
    }

    // Track max timestamp per peer to update after processing
    const maxTimestampPerPeer: Map<string, number> = new Map();
    let processedCount = 0;

    const unreadFromChats: Map<number, number> = new Map();

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

        // Decrypt message content early so we can inspect its type
        let decryptedContent = msg.content;
        if (msg.message_type === 'encrypted' || msg.message_type === 'hybrid') {
          decryptedContent = MessageEncryption.decryptOfflineMessage(msg, userIdentity.offlinePrivateKey);
        }

        // Check if this is a group control message
        // eslint-disable-next-line no-await-in-loop
        const groupResult = await this.tryRouteGroupControlMessage(decryptedContent, senderInfo);
        if (groupResult === 'retry') {
          // Handler failed — skip saving as text, skip advancing timestamp so it is retried next check
          console.log(`Group control message from ${senderInfo.username} failed, will retry`);
          continue;
        }
        if (groupResult === 'handled') {
          // Advance timestamp so we don't re-process, but don't save as a regular message
          const currentMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
          if (msg.timestamp > currentMax) {
            maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
          }
          console.log(`Routed group control message from ${senderInfo.username}`);
          continue;
        }
        // 'not_group': fall through to regular message handling

        // Regular text message — save to database
        // eslint-disable-next-line no-await-in-loop
        const msgChatId = await this.saveOfflineMessageToDatabase(msg, senderInfo, decryptedContent);
        const unreadCount = unreadFromChats.get(msgChatId) ?? 0;
        unreadFromChats.set(msgChatId, unreadCount + 1);
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
      console.log(`[OFFLINE][PROCESS] Updated lastRead timestamp for peer=${peerId} to ${maxTimestamp}`);
    }

    if (processedCount > 0) {
      console.log(`Processed ${processedCount} new offline direct messages`);
    }

    return {checkedChatIds: checkedChats, unreadFromChats: unreadFromChats};
  }

  async checkOfflineMessages(chatIds?: number[]): Promise<{checkedChatIds: number[], unreadFromChats: Map<number, number>}> {
    try {
      return await this.performOfflineMessageCheck(chatIds);
    } catch (error: unknown) {
      generalErrorHandler(error);
      return {checkedChatIds: [], unreadFromChats: new Map()};
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
   *
   * TODO: Consider yielding offline messages as they're processed for real-time UI updates.
   * Current approach: UI refreshes all chats after batch completes (simple but less efficient).
   * Future optimization: Return message summaries per chat and emit batched events to avoid
   * re-fetching all chats from database. See discussion in implementation notes.
   */
  private async saveOfflineMessageToDatabase(
    msg: OfflineMessage,
    senderInfo: OfflineSenderInfo,
    decryptedContent: string,
  ): Promise<number> {
    console.log(`Processing offline message from ${senderInfo.username} (${senderInfo.peer_id})`);

    const chat = this.database.getChatByPeerId(senderInfo.peer_id);
    if (!chat) {
      throw new Error('Chat not found');
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

    // Fire message received event so UI updates
    this.onMessageReceived({
      chatId: chat.id,
      messageId: messageId,
      content: decryptedContent,
      senderPeerId: senderInfo.peer_id,
      senderUsername: senderInfo.username,
      timestamp: msg.timestamp,
      messageSentStatus: 'offline'
    });

    return chat.id;
  }

  cleanup(): void {
    if (this.groupAckStartupTimer) {
      clearTimeout(this.groupAckStartupTimer);
      this.groupAckStartupTimer = null;
    }
    if (this.groupAckRepublishTimer) {
      clearTimeout(this.groupAckRepublishTimer);
      this.groupAckRepublishTimer = null;
    }
    for (const timer of this.nudgeFetchTimers.values()) {
      clearTimeout(timer);
    }
    this.nudgeFetchTimers.clear();
    this.peerActivityCheckCooldowns.clear();

    if (this.cleanupPeerEvents) {
      this.cleanupPeerEvents();
    }
    this.sessionManager.clearAll();
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getUserIdentity() {
    return this.usernameRegistry.getUserIdentity();
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

  getFileHandler(): FileHandler {
    return this.fileHandler;
  }

  /**
   * Attempts to parse decrypted content as a group control message and route it
   * to the appropriate handler (GroupCreator or GroupResponder).
   * Returns 'handled' if processed OK, 'retry' if it was a group message but failed (no timestamp advance),
   * or 'not_group' if this is a regular text message.
   */
  private async tryRouteGroupControlMessage(
    decryptedContent: string,
    senderInfo: OfflineSenderInfo,
  ): Promise<'handled' | 'retry' | 'not_group'> {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      // Not JSON — regular text message
      return 'not_group';
    }

    if (!parsed || typeof parsed.type !== 'string') return 'not_group';

    const type = parsed.type;

    // Check if this is a known group message type
    const groupTypes = Object.values(GroupMessageType) as string[];
    if (!groupTypes.includes(type)) return 'not_group';

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      console.log(`[GROUP] Cannot route group message — no user identity, will retry`);
      return 'retry';
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    const deps = {
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      nudgePeer: this.nudgePeer.bind(this),
    };

    try {
      switch (type) {
        // --- Messages handled by GroupResponder (we are the invitee) ---
        case GroupMessageType.GROUP_INVITE: {
          const responder = new GroupResponder(deps);
          await responder.handleGroupInvite(parsed as any);
          console.log(`[GROUP] Processed GROUP_INVITE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_RESPONSE_ACK: {
          const responder = new GroupResponder(deps);
          await responder.handleInviteResponseAck(parsed as any);
          console.log(`[GROUP] Processed GROUP_INVITE_RESPONSE_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_WELCOME: {
          const responder = new GroupResponder(deps);
          await responder.handleGroupWelcome(parsed as any);
          console.log(`[GROUP] Processed GROUP_WELCOME from ${senderInfo.username}`);
          break;
        }

        // --- Messages handled by GroupCreator (we are the creator) ---
        case GroupMessageType.GROUP_INVITE_RESPONSE: {
          const creator = new GroupCreator(deps);
          await creator.processInviteResponse(parsed as any);
          console.log(`[GROUP] Processed GROUP_INVITE_RESPONSE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_DELIVERED_ACK: {
          const creator = new GroupCreator(deps);
          await creator.handleInviteDeliveredAck(parsed as any, senderInfo.peer_id);
          console.log(`[GROUP] Processed GROUP_INVITE_DELIVERED_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_CONTROL_ACK: {
          const creator = new GroupCreator(deps);
          await creator.handleControlAck(parsed as any, senderInfo.peer_id);
          console.log(`[GROUP] Processed GROUP_CONTROL_ACK from ${senderInfo.username}`);
          break;
        }

        // --- Messages not yet implemented — consume without saving as text ---
        case GroupMessageType.GROUP_STATE_UPDATE:
        case GroupMessageType.GROUP_LEAVE_REQUEST:
        case GroupMessageType.GROUP_KICK:
        case GroupMessageType.GROUP_MESSAGE:
          console.log(`[GROUP] Received ${type} from ${senderInfo.username} — handler not yet implemented, consuming`);
          break;

        default:
          console.log(`[GROUP] Unknown group message type: ${type}`);
          return 'retry';
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[GROUP] Error handling ${type} from ${senderInfo.username}`);
      return 'retry'; // Handler failed — don't advance timestamp so message is retried
    }

    return 'handled';
  }
} 
