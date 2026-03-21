import { peerIdFromString } from '@libp2p/peer-id';
import type { ChatNode, StreamHandlerContext, AuthenticatedEncryptedMessage, OfflineMessage, OfflineSenderInfo, ConversationSession, EncryptedMessage, ContactMode, KeyExchangeEvent, ContactRequestEvent, ChatCreatedEvent, KeyExchangeFailedEvent, MessageReceivedEvent, SendMessageResponse, StrippedMessage, MessageSentStatus, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, PendingFileReceivedEvent, GroupChatActivatedEvent, GroupMembersUpdatedEvent, GroupOfflineGapWarning } from '../types.js';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  MESSAGE_TIMEOUT,
  SESSION_MANAGER_CLEANUP_INTERVAL,
  BUCKET_NUDGE_COOLDOWN_MS,
  BUCKET_NUDGE_DIAL_TIMEOUT_MS,
  BUCKET_NUDGE_FETCH_DELAY_MS,
  BUCKET_NUDGE_RETRY_DELAY_MS,
  GROUP_ACK_REPUBLISH_STARTUP_DELAY,
  GROUP_ACK_REPUBLISH_INTERVAL,
  GROUP_ACK_REPUBLISH_JITTER,
  GROUP_INFO_REPUBLISH_STARTUP_DELAY,
  GROUP_INFO_REPUBLISH_INTERVAL,
  GROUP_INFO_REPUBLISH_JITTER,
  GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS,
  OFFLINE_ACK_MAX_FUTURE_SKEW_MS,
  OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS,
  ERRORS,
  getNetworkModeRuntime,
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
import { GroupMessageType } from './group/types.js';
import { GroupCreator } from './group/group-creator.js';
import { GroupResponder } from './group/group-responder.js';
import { GroupMessaging } from './group/group-messaging.js';
import { GroupOfflineManager } from './group/group-offline-manager.js';
import type { GroupOfflineCheckOptions } from './group/group-offline-manager.js';
import { GroupAckRepublisher } from './group/group-ack-republisher.js';
import { GroupInfoRepublisher } from './group/group-info-republisher.js';
import { dialProtocolWithRelayFallback } from './protocol-dialer.js';

type OfflineReadBucketInfo = ReturnType<ChatDatabase['getOfflineReadBucketInfo']>[number];
type OfflineReadBucketInfoForChats = ReturnType<ChatDatabase['getOfflineReadBucketInfoForChats']>[number];
type OfflineReadBucketInfoAny = OfflineReadBucketInfo | OfflineReadBucketInfoForChats;

function hasChatId(info: OfflineReadBucketInfoAny): info is OfflineReadBucketInfoForChats {
  return 'chat_id' in info;
}

type BucketNudgePayload =
  | { kind: 'GROUP_REKEY_REFETCH'; groupId: string }
  | { kind: 'DIRECT_SESSION_RESET' };

/**
 * Main message handler that orchestrates all message handling components
 */
export class MessageHandler {
  private static readonly GROUP_CONTROL_MAX_RETRIES = 3;
  private static readonly GROUP_CONTROL_RETRY_TTL_MS = 10 * 60 * 1000;
  private static readonly GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES = 200;
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
  private nudgeTrailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nudgeFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private groupNudgeFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private groupStateCatchupInFlight = new Set<number>();
  private groupStateCatchupPending = new Map<number, { groupId: string; targetKeyVersion: number; reason: string }>();
  private peerActivityCheckCooldowns = new Map<string, number>();
  private groupAckRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckImmediateRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckImmediateTargets = new Set<string>();
  private groupInfoRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupInfoStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupControlRetryState = new Map<string, { attempts: number; lastSeenAt: number; lastError: string }>();
  private groupStateResyncRequestCooldowns = new Map<string, number>();
  private groupInfoSyncInFlight = new Map<string, Promise<void>>();
  private groupInfoSyncPending = new Set<string>();
  private offlineCheckRunSeq = 0;
  private nudgeSendAttemptSeq = 0;
  private groupOfflineManager: GroupOfflineManager;
  private groupMessaging: GroupMessaging;
  private groupAckRepublisher: GroupAckRepublisher;
  private groupInfoRepublisher: GroupInfoRepublisher;
  private readonly bucketNudgeProtocol: string;
  private readonly chatProtocol: string;
  private readonly expectedOfflineBucketPrefix: string;

  private formatNudgeTarget(payload: BucketNudgePayload): string {
    if (payload.kind === 'GROUP_REKEY_REFETCH') {
      return `group=${payload.groupId.slice(0, 8)}`;
    }
    return 'kind=direct_session_reset';
  }

  private getNudgeConnectionSnapshot(peerId: string): {
    totalConnections: number;
    peerConnectionCount: number;
    peerConnectionAddrs: string;
    peerSuffixes: string;
  } {
    const allConnections = this.node.getConnections();
    const peerConnections = allConnections.filter((conn) => conn.remotePeer.toString() === peerId);
    const peerConnectionAddrs = peerConnections
      .map((conn) => conn.remoteAddr.toString())
      .join(',') || 'none';
    const peerSuffixes = allConnections
      .map((conn) => conn.remotePeer.toString().slice(-8))
      .join(',') || 'none';

    return {
      totalConnections: allConnections.length,
      peerConnectionCount: peerConnections.length,
      peerConnectionAddrs,
      peerSuffixes,
    };
  }

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
    this.keyExchange = new KeyExchange(
      node,
      usernameRegistry,
      this.sessionManager,
      database,
      onKeyExchangeSent,
      onContactRequestReceived,
      onChatCreated,
      onKeyExchangeFailed,
      this.handleDirectLinkReset.bind(this)
    );
    this.fileHandler = new FileHandler(node, this, database, onFileTransferProgress, onFileTransferComplete, onFileTransferFailed, onPendingFileReceived);
    const sessionNetworkMode = database.getSessionNetworkMode();
    const modeConfig = getNetworkModeRuntime(sessionNetworkMode).config;
    this.bucketNudgeProtocol = modeConfig.bucketNudgeProtocol;
    this.chatProtocol = modeConfig.chatProtocol;
    this.expectedOfflineBucketPrefix = `${modeConfig.dhtNamespaces.offline}/`;
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }
    this.groupOfflineManager = new GroupOfflineManager({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId: this.node.peerId.toString(),
      onMessageReceived: this.onMessageReceived,
    });
    this.groupMessaging = new GroupMessaging({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId: this.node.peerId.toString(),
      myUsername: this.database.getUserByPeerId(this.node.peerId.toString())?.username || `user_${this.node.peerId.toString().slice(-8)}`,
      onMessageReceived: this.onMessageReceived,
      groupOfflineManager: this.groupOfflineManager,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });
    this.groupAckRepublisher = new GroupAckRepublisher({
      node: this.node,
      database: this.database,
      networkMode: sessionNetworkMode,
      usernameRegistry: this.usernameRegistry,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });
    this.groupInfoRepublisher = new GroupInfoRepublisher({
      node: this.node,
      database: this.database,
      networkMode: sessionNetworkMode,
    });
    const recoveredRekeying = this.database.recoverRekeyingGroupsOnStartup();
    if (recoveredRekeying > 0) {
      console.warn(
        `[GROUP] Recovered ${recoveredRekeying} group chat(s) stuck in rekeying state on startup`,
      );
    }
    this.setupProtocolHandler();
    this.groupMessaging.start();
    this.cleanupPeerEvents = PeerConnectionHandler.setupPeerEvents(node, this.sessionManager);
    this.startSessionCleanup();
    this.startGroupAckRepublisher();
    this.startGroupInfoRepublisher();
  }

  // Get configuration value from database with fallback to constant
  private getChatsToCheckForOfflineMessages(): number {
    const setting = this.database.getSetting('chats_to_check_for_offline_messages');
    return setting ? parseInt(setting, 10) : CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES;
  }

  public nudgePeerGroupRefetch(peerId: string, groupId: string): void {
    this.sendBucketNudge(peerId, { kind: 'GROUP_REKEY_REFETCH', groupId }, `group:${peerId}:${groupId}`);
  }

  public nudgePeerDirectSessionReset(peerId: string): void {
    this.sendBucketNudge(peerId, { kind: 'DIRECT_SESSION_RESET' }, `direct-reset:${peerId}`);
  }

  private sendBucketNudge(
    peerId: string,
    payload: BucketNudgePayload,
    cooldownKey: string
  ): void {
    const attemptId = ++this.nudgeSendAttemptSeq;
    const startSnapshot = this.getNudgeConnectionSnapshot(peerId);
    console.log(
      `[NUDGE][SEND][START] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
      `cooldownKey=${cooldownKey} totalConnections=${startSnapshot.totalConnections} ` +
      `peerConnections=${startSnapshot.peerConnectionCount} peerConnAddrs=${startSnapshot.peerConnectionAddrs}`,
    );

    // Do not force-dial just to send a nudge.
    const hasActiveConnection = startSnapshot.peerConnectionCount > 0;
    if (!hasActiveConnection) {
      console.log(
        `[NUDGE][SKIP_NO_CONN] peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
        `reason=no_active_connection attempt=${attemptId} totalConnections=${startSnapshot.totalConnections} ` +
        `connectedPeers=${startSnapshot.peerSuffixes}`,
      );
      return;
    }

    const now = Date.now();
    const last = this.nudgeCooldowns.get(cooldownKey) ?? 0;
    const elapsed = now - last;

    console.log("MARINPARIN aCTUALLY sent to at", peerId, now)

    if (elapsed < BUCKET_NUDGE_COOLDOWN_MS) {
      const remaining = BUCKET_NUDGE_COOLDOWN_MS - elapsed;
      if (!this.nudgeTrailingTimers.has(cooldownKey)) {
        const timer = setTimeout(() => {
          this.nudgeTrailingTimers.delete(cooldownKey);
          this.sendBucketNudge(peerId, payload, cooldownKey);
        }, remaining);
        this.nudgeTrailingTimers.set(cooldownKey, timer);
      }
      console.log(
        `[NUDGE][COOLDOWN] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
        `elapsed=${elapsed} remaining=${remaining} cooldownMs=${BUCKET_NUDGE_COOLDOWN_MS}`,
      );
      return;
    }
    this.nudgeCooldowns.set(cooldownKey, now);

    void (async () => {
      const dialStartedAt = Date.now();
      try {
        const targetPeerId = peerIdFromString(peerId);
        console.log(
          `[NUDGE][DIAL][START] attempt=${attemptId} peer=${peerId.slice(-8)} protocol=${this.bucketNudgeProtocol} ` +
          `timeoutMs=${BUCKET_NUDGE_DIAL_TIMEOUT_MS}`,
        );
        const stream = await this.node.dialProtocol(targetPeerId, this.bucketNudgeProtocol, {
          signal: AbortSignal.timeout(BUCKET_NUDGE_DIAL_TIMEOUT_MS),
          runOnLimitedConnection: true,
        });
        const dialMs = Date.now() - dialStartedAt;
        const postDialSnapshot = this.getNudgeConnectionSnapshot(peerId);
        console.log(
          `[NUDGE][DIAL][OK] attempt=${attemptId} peer=${peerId.slice(-8)} dialMs=${dialMs} ` +
          `totalConnections=${postDialSnapshot.totalConnections} ` +
          `peerConnections=${postDialSnapshot.peerConnectionCount} peerConnAddrs=${postDialSnapshot.peerConnectionAddrs}`,
        );

        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const sinkStartedAt = Date.now();
        await stream.sink([payloadBytes]);
        const sinkMs = Date.now() - sinkStartedAt;
        console.log(
          `[NUDGE][WRITE][OK] attempt=${attemptId} peer=${peerId.slice(-8)} bytes=${payloadBytes.length} sinkMs=${sinkMs}`,
        );

        const closeStartedAt = Date.now();
        await stream.close();
        const closeMs = Date.now() - closeStartedAt;
        const totalMs = Date.now() - dialStartedAt;
        console.log(
          `[NUDGE][SEND][OK] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
          `totalMs=${totalMs} closeMs=${closeMs}`,
        );
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        const errorCode = typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'n/a';
        const elapsedMs = Date.now() - dialStartedAt;
        const failSnapshot = this.getNudgeConnectionSnapshot(peerId);
        console.log(
          `[NUDGE][SEND_FAIL] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
          `reason=${reason} errorName=${errorName} errorCode=${errorCode} elapsedMs=${elapsedMs} ` +
          `totalConnections=${failSnapshot.totalConnections} peerConnections=${failSnapshot.peerConnectionCount} ` +
          `peerConnAddrs=${failSnapshot.peerConnectionAddrs}`,
        );
        // Best-effort — peer offline or unreachable, offline bucket still delivers
      }
    })();
  }

  /**
   * Sets up the chat protocol handler for incoming messages
   */
  private setupProtocolHandler(): void {
    void this.node.handle(this.bucketNudgeProtocol, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      const recvStartedAt = Date.now();
      console.log(
        `[NUDGE][RECV][IN] from=${remoteId.slice(-8)} protocol=${this.bucketNudgeProtocol} ` +
        `totalConnections=${this.node.getConnections().length}`,
      );
      try {
        if (this.database.isBlocked(remoteId)) return;
        if (!this.isKnownNudgeSender(remoteId)) {
          console.log(`[NUDGE] Ignoring nudge from unknown peer ${remoteId.slice(-8)}`);
          return;
        }

        const nudgePayload = await this.readBucketNudgePayload(stream);
        console.log("MARINPARIN nudgepayloag", nudgePayload)
        console.log(
          `[NUDGE][RECV][PAYLOAD] from=${remoteId.slice(-8)} payload=${nudgePayload ? JSON.stringify(nudgePayload) : 'null'} ` +
          `readMs=${Date.now() - recvStartedAt}`,
        );
        await this.routeBucketNudge(remoteId, nudgePayload);
      } catch (error: unknown) {
        generalErrorHandler(error, `[NUDGE] Failed to process nudge from ${remoteId.slice(-8)}`);
      } finally {
        try {
          await stream.close();
          console.log(
            `[NUDGE][RECV][DONE] from=${remoteId.slice(-8)} totalMs=${Date.now() - recvStartedAt}`,
          );
        } catch {
          // Best-effort close.
        }
      }
    }, {
      runOnLimitedConnection: true,
    });

    void this.node.handle(this.chatProtocol, async (context: StreamHandlerContext) => {
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
      StreamHandler.logIncomingConnection(remoteId, this.chatProtocol);

      try {
        const message = await StreamHandler.readMessageFromStream<EncryptedMessage>(stream);
        StreamHandler.logReceivedMessage(message);

        if (MessageEncryption.isKeyExchange(message)) {
          const hadUserAtStart = !!this.database.getUserByPeerId(remoteId);
          await this.keyExchange.handleKeyExchange(remoteId, message as AuthenticatedEncryptedMessage, stream);
          this.reactivateRetiredPendingAcksForPeer(remoteId);
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
        this.reactivateRetiredPendingAcksForPeer(remoteId);

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
    }, {
      runOnLimitedConnection: true,
    });
  }

  private isKnownNudgeSender(remoteId: string): boolean {
    const hasDirectChat = this.database.getChatByPeerId(remoteId) !== null;
    const knownUser = this.database.getUserByPeerId(remoteId) !== null;
    return hasDirectChat || knownUser;
  }

  private async routeBucketNudge(remoteId: string, nudgePayload: BucketNudgePayload | null): Promise<void> {
    if (!nudgePayload) {
      console.log(`[NUDGE] Ignoring non-group nudge from ${remoteId.slice(-8)}`);
      return;
    }

    if (nudgePayload.kind === 'DIRECT_SESSION_RESET') {
      this.handleDirectSessionResetNudge(remoteId);
      return;
    }

    if (nudgePayload.kind === 'GROUP_REKEY_REFETCH') {
      this.handleGroupRefetchNudge(remoteId, nudgePayload.groupId);
      return;
    }
  }

  private handleDirectSessionResetNudge(remoteId: string): void {
    const directChat = this.database.getChatByPeerId(remoteId);
    if (!directChat) {
      console.log(`[NUDGE] Received direct-session-reset from ${remoteId.slice(-8)} but no direct chat exists, ignoring`);
      return;
    }

    this.keyExchange.deletePendingAcceptanceByPeerId(remoteId);
    this.sessionManager.removePendingKeyExchange(remoteId);
    this.sessionManager.clearSession(remoteId);
    console.log(`[NUDGE] Applied direct-session-reset from ${remoteId.slice(-8)} (chatId=${directChat.id})`);
  }

  private handleGroupRefetchNudge(remoteId: string, groupId: string): void {
    const groupChat = this.database.getChatByGroupId(groupId);
    const directChat = this.database.getChatByPeerId(remoteId);

    if (!groupChat) {
      if (directChat) {
        console.log(
          `[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for unknown group=${groupId.slice(0, 8)}, triggering direct offline check for chat ${directChat.id}`,
        );
        this.scheduleNudgeOfflineCheck(remoteId, directChat.id);
        return;
      }

      console.log(
        `[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for unknown group=${groupId.slice(0, 8)}, ignoring`,
      );
      return;
    }

    if (!this.isGroupRefetchNudgeSenderEligible(remoteId, groupChat.id, groupId)) {
      console.log(
        `[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for group=${groupId.slice(0, 8)} but sender is neither participant nor pending_invitee, ignoring`,
      );
      return;
    }

    if (directChat) {
      console.log(
        `[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for group=${groupId.slice(0, 8)}, scheduling direct offline check for chat ${directChat.id}`,
      );
      this.scheduleNudgeOfflineCheck(remoteId, directChat.id);
    }

    console.log(
      `[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)}, scheduling group check for chat ${groupChat.id}`,
    );
    this.scheduleGroupNudgeOfflineCheck(remoteId, groupChat.id, groupId);
  }

  private isGroupRefetchNudgeSenderEligible(remoteId: string, groupChatId: number, groupId: string): boolean {
    const isParticipant = this.database.getChatParticipants(groupChatId).some((p) => p.peer_id === remoteId);
    const hasPendingInvite = this.database.getPendingAcksForGroup(groupId).some(
      (ack) => ack.message_type === 'GROUP_INVITE' && ack.target_peer_id === remoteId,
    );
    return isParticipant || hasPendingInvite;
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

  private scheduleGroupNudgeOfflineCheck(remoteId: string, chatId: number, groupId: string): void {
    const key = `${remoteId}:${groupId}`;
    const existingTimer = this.groupNudgeFetchTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.groupNudgeFetchTimers.delete(key);
      void this.runGroupNudgeOfflineCheck(remoteId, chatId, groupId, false, true);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.groupNudgeFetchTimers.set(key, timer);
  }

  private async runNudgeOfflineCheck(remoteId: string, chatId: number, isRetry: boolean, allowRetry: boolean): Promise<void> {
    try {
      const beforeTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      console.log(
        `MARINPARIN [NUDGE][CHECK][START] peer=${remoteId.slice(-8)} chatId=${chatId} isRetry=${isRetry} allowRetry=${allowRetry} beforeTs=${beforeTimestamp}`,
      );
      const { checkedChatIds } = await this.checkOfflineMessages([chatId]);
      const afterTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      const hasNewData = afterTimestamp > beforeTimestamp;
      console.log(
        `MARINPARIN [NUDGE][CHECK][DONE] peer=${remoteId.slice(-8)} chatId=${chatId} isRetry=${isRetry} checkedChats=${checkedChatIds.length} beforeTs=${beforeTimestamp} afterTs=${afterTimestamp} hasNewData=${hasNewData}`,
      );

      if (checkedChatIds.length > 0 && hasNewData) {
        this.onOfflineMessagesFetchComplete?.(checkedChatIds);
      }

      if (!isRetry && allowRetry && !hasNewData) {
        setTimeout(() => {
          console.log(
            `[NUDGE][CHECK][RETRY_SCHEDULED] peer=${remoteId.slice(-8)} chatId=${chatId} retryInMs=${BUCKET_NUDGE_RETRY_DELAY_MS}`,
          );
          void this.runNudgeOfflineCheck(remoteId, chatId, true, allowRetry);
        }, BUCKET_NUDGE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[NUDGE] Failed offline bucket check for ${remoteId.slice(-8)}`);
    }
  }

  private async runGroupNudgeOfflineCheck(
    remoteId: string,
    chatId: number,
    groupId: string,
    isRetry: boolean,
    allowRetry: boolean
  ): Promise<void> {
    try {
      console.log(
        `MARINPARIN [NUDGE][GROUP-CHECK][START] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `isRetry=${isRetry} allowRetry=${allowRetry}`,
      );
      const { checkedChatIds, unreadFromChats } = await this.checkGroupOfflineMessages([chatId], { mode: 'nudge' });
      const unread = unreadFromChats.get(chatId) ?? 0;
      const hasNewData = unread > 0;
      console.log(
        `MARINPARIN [NUDGE][GROUP-CHECK][DONE] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `isRetry=${isRetry} checkedChats=${checkedChatIds.length} unread=${unread} hasNewData=${hasNewData}`,
      );

      if (checkedChatIds.length > 0 && hasNewData) {
        this.onOfflineMessagesFetchComplete?.(checkedChatIds);
      }

      if (!isRetry && allowRetry && !hasNewData) {
        setTimeout(() => {
          console.log(
            `[NUDGE][GROUP-CHECK][RETRY_SCHEDULED] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
            `retryInMs=${BUCKET_NUDGE_RETRY_DELAY_MS}`,
          );
          void this.runGroupNudgeOfflineCheck(remoteId, chatId, groupId, true, allowRetry);
        }, BUCKET_NUDGE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[NUDGE] Failed group offline bucket check for ${remoteId.slice(-8)} group=${groupId.slice(0, 8)}`);
    }
  }

  private scheduleGroupStateUpdateCatchup(chatId: number, groupId: string, reason: string): void {
    const targetKeyVersion = this.database.getChatByGroupId(groupId)?.key_version ?? 0;
    const pending = this.groupStateCatchupPending.get(chatId);
    if (!pending || targetKeyVersion >= pending.targetKeyVersion) {
      this.groupStateCatchupPending.set(chatId, { groupId, targetKeyVersion, reason });
    }

    if (this.groupStateCatchupInFlight.has(chatId)) {
      console.log(
        `[GROUP-OFFLINE][STATE-CATCHUP][QUEUED] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `reason=in_flight trigger=${reason} targetKeyVersion=${targetKeyVersion}`,
      );
      return;
    }

    void this.runQueuedGroupStateCatchup(chatId);
  }

  private handleDirectLinkReset(peerId: string): void {
    const myPeerId = this.node.peerId.toString();
    const userIdentity = this.usernameRegistry.getUserIdentity();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = userIdentity
      ? new GroupCreator({
        node: this.node,
        database: this.database,
        userIdentity,
        myPeerId,
        myUsername,
        onGroupMembersUpdated: this.onGroupMembersUpdated,
        onMessageReceived: this.onMessageReceived,
        nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
        onRegisterPrevEpochGrace: (groupId: string, keyVersion: number) => {
          this.groupMessaging.registerGraceContextForEpoch(groupId, keyVersion);
        },
      })
      : null;
    const groupChats = this.database.getAllGroupChats();

    for (const chat of groupChats) {
      if (!chat.group_id) continue;

      const isParticipant = this.database
        .getChatParticipants(chat.id)
        .some((participant) => participant.peer_id === peerId);
      const hasPendingInvite = this.database
        .getPendingAcksForGroup(chat.group_id)
        .some((pending) => pending.message_type === 'GROUP_INVITE' && pending.target_peer_id === peerId);
      if (!isParticipant && !hasPendingInvite) continue;

      if (chat.group_creator_peer_id === myPeerId) {
        if (hasPendingInvite && creator) {
          console.log(
            `[DIRECT-RESET][INVITE_REPUBLISH] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_local`,
          );
          void creator.republishPendingInvitesForPeer(chat.group_id, peerId).then((count) => {
            if (count > 0) {
              console.log(
                `[DIRECT-RESET][INVITE_REPUBLISH][DONE] peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)} count=${count}`,
              );
            }
          }).catch((error: unknown) => {
            generalErrorHandler(
              error,
              `[DIRECT-RESET] Failed invite re-publish peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)}`,
            );
          });
        }

        if (!isParticipant) continue;

        console.log(
          `[DIRECT-RESET][STATE_RESYNC] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_local`,
        );
        if (!creator) {
          console.warn(
            `[DIRECT-RESET][STATE_RESYNC][SKIP] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=missing_identity`,
          );
        } else {
          void creator.resendCurrentStateToPeer(chat.group_id, peerId, 'direct_link_reset').catch((error: unknown) => {
            generalErrorHandler(
              error,
              `[DIRECT-RESET] Failed creator state resync peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)}`,
            );
          });
        }
      }

      if (chat.group_creator_peer_id === peerId) {
        console.log(
          `[DIRECT-RESET][CATCHUP] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_remote`,
        );
        this.scheduleGroupStateUpdateCatchup(chat.id, chat.group_id, 'direct_link_reset');
      }
    }
  }

  private scheduleCreatorGroupCatchupForPeer(peerId: string, reason: string): void {
    const groupChats = this.database.getAllGroupChats();
    for (const chat of groupChats) {
      if (!chat.group_id) continue;
      if (chat.group_creator_peer_id !== peerId) continue;
      console.log(
        `[GROUP-OFFLINE][STATE-CATCHUP][RELINK] peer=${peerId.slice(-8)} chatId=${chat.id} group=${chat.group_id.slice(0, 8)} reason=${reason}`,
      );
      this.scheduleGroupStateUpdateCatchup(chat.id, chat.group_id, reason);
    }
  }

  private async runQueuedGroupStateCatchup(chatId: number): Promise<void> {
    while (true) {
      const pending = this.groupStateCatchupPending.get(chatId);
      if (!pending) {
        return;
      }
      this.groupStateCatchupPending.delete(chatId);

      const { groupId, reason, targetKeyVersion } = pending;
      const preCheckVersion = this.database.getChatByGroupId(groupId)?.key_version ?? targetKeyVersion;
      this.groupStateCatchupInFlight.add(chatId);
      const startedAt = Date.now();

      try {
        console.log(
          `[GROUP-OFFLINE][STATE-CATCHUP][START] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
          `trigger=${reason} targetKeyVersion=${targetKeyVersion} preCheckVersion=${preCheckVersion}`,
        );
        const { checkedChatIds, unreadFromChats, gapWarnings } = await this.checkGroupOfflineMessages([chatId], { mode: 'nudge' });
        const unread = unreadFromChats.get(chatId) ?? 0;
        console.log(
          `[GROUP-OFFLINE][STATE-CATCHUP][DONE] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
          `checked=${checkedChatIds.length} unread=${unread} gaps=${gapWarnings.length} took=${Date.now() - startedAt}ms`,
        );
        if (checkedChatIds.length > 0 && unread > 0) {
          this.onOfflineMessagesFetchComplete?.(checkedChatIds);
        }
      } catch (error: unknown) {
        generalErrorHandler(error, `[GROUP-OFFLINE] State-update catch-up failed for chat ${chatId}`);
      } finally {
        this.groupStateCatchupInFlight.delete(chatId);
      }

      const postCheckVersion = this.database.getChatByGroupId(groupId)?.key_version ?? preCheckVersion;
      if (postCheckVersion > preCheckVersion && !this.groupStateCatchupPending.has(chatId)) {
        this.groupStateCatchupPending.set(chatId, {
          groupId,
          reason: 'version_advanced_during_catchup',
          targetKeyVersion: postCheckVersion,
        });
      }
    }
  }

  private async readBucketNudgePayload(stream: StreamHandlerContext['stream']): Promise<BucketNudgePayload | null> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push((chunk as any).subarray());
    }
    if (chunks.length === 0) return null;

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(combined)) as { kind?: string; groupId?: string };
      if (parsed.kind === 'DIRECT_SESSION_RESET') {
        return { kind: 'DIRECT_SESSION_RESET' };
      }
      if (parsed.kind === 'GROUP_REKEY_REFETCH' && typeof parsed.groupId === 'string' && parsed.groupId.length > 0) {
        return { kind: 'GROUP_REKEY_REFETCH', groupId: parsed.groupId };
      }
    } catch {
      // Ignore invalid payloads and treat as plain nudge.
    }
    return null;
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

  private scheduleImmediateGroupAckRepublish(): void {
    if (this.groupAckImmediateRepublishTimer) return;

    this.groupAckImmediateRepublishTimer = setTimeout(() => {
      this.groupAckImmediateRepublishTimer = null;
      void this.flushImmediateGroupAckRepublishQueue();
    }, 1000);
  }

  private enqueueImmediateGroupAckRepublish(peerId: string): void {
    this.groupAckImmediateTargets.add(peerId);
    this.scheduleImmediateGroupAckRepublish();
  }

  private async flushImmediateGroupAckRepublishQueue(): Promise<void> {
    const targets = Array.from(this.groupAckImmediateTargets);
    this.groupAckImmediateTargets.clear();
    if (targets.length === 0) return;

    const ran = await this.groupAckRepublisher.runCycleForTargets(targets);
    if (!ran) {
      for (const target of targets) {
        this.groupAckImmediateTargets.add(target);
      }
    }
    if (this.groupAckImmediateTargets.size > 0) {
      this.scheduleImmediateGroupAckRepublish();
    }
  }

  private async runGroupAckRepublishCycle(): Promise<void> {
    await this.groupAckRepublisher.runCycle();
  }

  private startGroupInfoRepublisher(): void {
    if (this.groupInfoStartupTimer) {
      clearTimeout(this.groupInfoStartupTimer);
    }
    this.groupInfoStartupTimer = setTimeout(() => {
      this.groupInfoStartupTimer = null;
      void this.runGroupInfoRepublishCycle();
      this.scheduleNextGroupInfoRepublish();
    }, GROUP_INFO_REPUBLISH_STARTUP_DELAY);
  }

  private scheduleNextGroupInfoRepublish(): void {
    if (this.groupInfoRepublishTimer) {
      clearTimeout(this.groupInfoRepublishTimer);
    }
    const jitter = (Math.random() * 2 - 1) * GROUP_INFO_REPUBLISH_JITTER;
    const delay = Math.max(1000, GROUP_INFO_REPUBLISH_INTERVAL + jitter);
    this.groupInfoRepublishTimer = setTimeout(() => {
      void this.runGroupInfoRepublishCycle();
      this.scheduleNextGroupInfoRepublish();
    }, delay);
  }

  private async runGroupInfoRepublishCycle(): Promise<void> {
    await this.groupInfoRepublisher.runCycle();
  }

  private async logPeerDialDiagnostics(targetPeerId: PeerId, context: string): Promise<void> {
    const targetPeerIdStr = targetPeerId.toString();
    const activeConnections = this.node
      .getConnections()
      .filter((conn) => conn.remotePeer.toString() === targetPeerIdStr)
      .map((conn) => conn.remoteAddr.toString());

    let knownAddrs: string[] = [];
    try {
      const peerData = await this.node.peerStore.get(targetPeerId);
      knownAddrs = (peerData.addresses ?? []).map((entry) => entry.multiaddr.toString());
    } catch {
      // Peer may not exist in peer store yet.
    }

    console.log(
      `[DIAL][${context}] target=${targetPeerIdStr} ` +
      `knownAddrs=${knownAddrs.length > 0 ? knownAddrs.join(',') : 'none'} ` +
      `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'}`
    );
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
    let user: User | null;
    if (initialUserProvided) {
      user = initialUser;
    } else {
      const dbUser = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
      user = dbUser && this.database.getChatByPeerId(dbUser.peer_id) ? dbUser : null;
    }
    let targetPeerId: PeerId;
    let keyExchangeOccurred = false;
    let resolvedOfflinePublicKey: string | undefined;

    if (!user) {
      if (isFileTransfer) {
        throw new Error('Cannot send file as first message. Send a text message first.');
      }

      try {
        let isPeerId = false;
        try { peerIdFromString(targetUsernameOrPeerId); isPeerId = true; } catch { /* username */ }
        const userRegistration = isPeerId
          ? await this.usernameRegistry.lookupByPeerId(targetUsernameOrPeerId)
          : await this.usernameRegistry.lookup(targetUsernameOrPeerId);
        targetPeerId = peerIdFromString(userRegistration.peerID);
        resolvedOfflinePublicKey = userRegistration.offlinePublicKey;
      } catch (lookupErr: unknown) {
        const lookupErrorText = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
        if (lookupErrorText === ERRORS.USERNAME_NOT_FOUND || lookupErrorText === 'Peer ID not found in DHT') {
          throw new Error(`User '${targetUsernameOrPeerId}' not found`);
        }
        throw new Error(`Failed to resolve user '${targetUsernameOrPeerId}': ${lookupErrorText}`);
      }

      user = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message, {
        recipientOfflinePublicKey: resolvedOfflinePublicKey,
      });
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
      const dbUser = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
      const initialUser = dbUser && this.database.getChatByPeerId(dbUser.peer_id) ? dbUser : null;
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

      if (keyExchangeOccurred && !hadUserAtStart) {
        this.scheduleCreatorGroupCatchupForPeer(targetPeerId.toString(), 'direct_relink_creator');
      }

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(targetPeerId.toString());
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(targetPeerId.toString());
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      const sendWithTimeout = async (): Promise<boolean> => {
        await this.logPeerDialDiagnostics(targetPeerId, 'send_message_online');
        const stream = await dialProtocolWithRelayFallback({
          node: this.node,
          database: this.database,
          targetPeerId,
          protocol: this.chatProtocol,
          context: 'send_message_online',
        });

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
        return { success: true, messageSentStatus: null, error: null };
      }

      console.error(`Failed to send message to ${targetUsernameOrPeerId}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const errorText = String(err instanceof Error ? err.message : err).toLowerCase();
        console.log("errorText :>> ", errorText);

        const shouldFallbackOffline = /econnrefused|user is offline|all multiaddr dials failed|message timeout|socks|tor transport|enetunreach|no valid addresses|ehostunreach|etimedout|limited connection|no_reservation|no reservation|failed to connect via relay with status/.test(errorText);
        if (shouldFallbackOffline) {
          console.log(`Trying to send offline message to ${targetUsernameOrPeerId}`);

          // Use user from key exchange if available, otherwise query database
          user ||= this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId) ?? null;
          if (!user) throw new Error('User not found in database');

          const bucketSecret = this.database.getOfflineBucketSecretByPeerId(user.peer_id);
          if (!bucketSecret) {
            const error = !!this.database.getChatByPeerId(user.peer_id)
              ? 'Offline fallback unavailable right now' : 'Direct channel not established yet'
            throw new Error(error);
          }
          const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);

          const strippedMessage = await this.storeOfflineMessageDB(user, writeBucketKey, message);
          console.log(`Peer likely offline; stored message for ${targetUsernameOrPeerId} as offline.`);
          return { success: true, messageSentStatus: 'offline', message: strippedMessage, error: null };
        } else if (errorText.includes("username not found")) {
          return { success: false, messageSentStatus: null, error: `User ${targetUsernameOrPeerId} not found` };
        }

        console.log(`Offline message fallback failed`);
        throw err;
      } catch (offlineErr: unknown) {
        generalErrorHandler(offlineErr, `Failed to send message`);
        return {
          success: false, messageSentStatus: null, error: 'Failed to send message: ' + (
            offlineErr instanceof Error ? offlineErr.message : String(offlineErr))
        };
      }
    }
  }

  async sendGroupMessage(
    chatId: number,
    message: string,
    options?: { rekeyRetryHint?: boolean }
  ): Promise<SendMessageResponse> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      return { success: false, messageSentStatus: null, error: 'Group chat not found' };
    }
    if (chat.type !== 'group') {
      return { success: false, messageSentStatus: null, error: 'Chat is not a group chat' };
    }
    if (!chat.group_id) {
      return { success: false, messageSentStatus: null, error: 'Group ID missing for chat' };
    }

    try {
      return await this.groupMessaging.sendGroupMessage(chat.group_id, message, options);
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      return { success: false, messageSentStatus: null, error: errorText };
    }
  }

  async leaveGroup(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    const responder = new GroupResponder({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });

    await responder.leaveGroup(chat.group_id);
    this.groupMessaging.deactivateGroup(chat.group_id);
  }

  async kickGroupMember(chatId: number, targetPeerId: string): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }
    if (!targetPeerId) {
      throw new Error('Target peer ID is required');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = new GroupCreator({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
      onRegisterPrevEpochGrace: (groupId: string, keyVersion: number) => {
        this.groupMessaging.registerGraceContextForEpoch(groupId, keyVersion);
      },
    });

    await creator.kickMember(chat.group_id, targetPeerId);

    const refreshed = this.database.getChatByGroupId(chat.group_id);
    if (refreshed?.group_status === 'active' && (refreshed.key_version ?? 0) > 0) {
      this.groupMessaging.subscribeToGroupTopic(chat.group_id)
    }
  }

  async disbandGroup(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = new GroupCreator({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
      onRegisterPrevEpochGrace: (groupId: string, keyVersion: number) => {
        this.groupMessaging.registerGraceContextForEpoch(groupId, keyVersion);
      },
    });

    await creator.disbandGroup(chat.group_id);
    this.groupMessaging.deactivateGroup(chat.group_id);
  }

  async requestGroupUpdate(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }
    if (chat.group_creator_peer_id === this.node.peerId.toString()) {
      throw new Error('Group creator cannot request group update');
    }

    const status = chat.group_status;
    if (status === 'left' || status === 'removed' || status === 'disbanded') {
      throw new Error(`Cannot request group update while group status is ${status}`);
    }

    const now = Date.now();
    this.pruneGroupStateResyncRequestCooldowns(now);
    const lastRequestAt = this.groupStateResyncRequestCooldowns.get(chat.group_id) ?? 0;
    const elapsed = now - lastRequestAt;
    if (elapsed < GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS - elapsed) / 1000);
      throw new Error(`Please wait ${waitSeconds}s before requesting another group update`);
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const responder = new GroupResponder({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });

    await responder.requestGroupStateResync(chat.group_id);
    this.groupStateResyncRequestCooldowns.set(chat.group_id, now);
  }

  private pruneGroupStateResyncRequestCooldowns(now: number): void {
    const maxAgeMs = GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS * 4;
    for (const [groupId, timestamp] of this.groupStateResyncRequestCooldowns.entries()) {
      if (now - timestamp > maxAgeMs) {
        this.groupStateResyncRequestCooldowns.delete(groupId);
      }
    }
  }

  async retryGroupOfflineBackup(chatId: number, messageId: string): Promise<{ success: boolean; error: string | null }> {
    try {
      await this.groupMessaging.retryOfflineBackup(chatId, messageId);
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkGroupOfflineMessages(chatIds?: number[], options?: GroupOfflineCheckOptions): Promise<{
    checkedChatIds: number[];
    failedChatIds: number[];
    unreadFromChats: Map<number, number>;
    gapWarnings: GroupOfflineGapWarning[];
  }> {
    try {
      return await this.groupOfflineManager.checkGroupOfflineMessages(chatIds, options);
    } catch (error: unknown) {
      generalErrorHandler(error, '[GROUP-OFFLINE] Failed to check group offline messages');
      return { checkedChatIds: [], failedChatIds: [], unreadFromChats: new Map(), gapWarnings: [] };
    }
  }

  private async storeOfflineMessageDB(user: User, writeBucketKey: string, message: string): Promise<StrippedMessage> {
    try {
      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) throw new Error('User identity not available');

      // Get last registered username or generate fallback
      const myPeerId = this.node.peerId.toString();
      const myUser = this.database.getUserByPeerId(myPeerId);
      const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(user.peer_id);
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(user.peer_id);
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      const offlineMessage = OfflineMessageManager.createOfflineMessage(
        this.node.peerId.toString(),
        myUsername,
        message,
        Buffer.from(user.offline_public_key, 'base64').toString(),
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

    return { chatId: chat.id, messageId, content: message, timestamp: timestamp.getTime(), messageType: 'text' };
  }

  // Check offline messages (direct)
  private async performOfflineMessageCheck(chatIds?: number[]): Promise<{ checkedChatIds: number[], unreadFromChats: Map<number, number> }> {
    const runId = ++this.offlineCheckRunSeq;
    console.log(chatIds
      ? `Checking for offline messages in ${chatIds.length} chat${chatIds.length > 1 ? 's' : ''}...`
      : "Checking for offline direct messages (top 10)...");
    console.log(
      `[OFFLINE][CHECK][START] run=${runId} scope=${chatIds ? `chat_ids:${chatIds.join(',')}` : 'default'}`,
    );

    const bucketInfoList: OfflineReadBucketInfoAny[] = chatIds
      ? this.database.getOfflineReadBucketInfoForChats(chatIds)
      : this.database.getOfflineReadBucketInfo(this.getChatsToCheckForOfflineMessages());

    if (bucketInfoList.length === 0) {
      console.log('No chats found for offline message check');
      console.log(`[OFFLINE][CHECK][DONE] run=${runId} checkedChats=0 fetchedMessages=0 processedMessages=0`);
      return { checkedChatIds: [], unreadFromChats: new Map() };
    }

    const readBuckets: Array<{ chatId?: number; key: string; peerPubKey: string; peerId: string; lastReadTimestamp: number }> = [];
    const checkedChats: number[] = [];

    for (const info of bucketInfoList) {
      const readBucketKey = this.keyExchange.constructReadBucketKey(
        info.offline_bucket_secret,
        info.signing_public_key
      );
      if (!readBucketKey.startsWith(this.expectedOfflineBucketPrefix)) {
        // TODO remove after testing
        const chatIdForLog = hasChatId(info) ? String(info.chat_id) : 'n/a';
        console.warn(
          `[MODE-GUARD][REJECT][offline_lookup] run=${runId} chatId=${chatIdForLog} peer=${info.peer_id} ` +
          `reason=bucket_prefix_mismatch expectedPrefix=${this.expectedOfflineBucketPrefix} got=${readBucketKey.slice(0, 64)}...`
        );
        continue;
      }

      const chatId = hasChatId(info) ? info.chat_id : undefined;

      const bucket = {
        key: readBucketKey,
        peerPubKey: info.signing_public_key,
        peerId: info.peer_id,
        lastReadTimestamp: info.offline_last_read_timestamp,
        ...(chatId !== undefined && { chatId })
      };

      readBuckets.push(bucket);

      if (chatId !== undefined) {
        checkedChats.push(chatId);
      }
    }

    const bucketKeys = readBuckets.map(b => b.key);
    console.log(
      `[OFFLINE][CHECK][BUCKETS] run=${runId} count=${readBuckets.length} peers=${readBuckets.map(b => b.peerId.slice(-8)).join(',')}`,
    );
    const store = await OfflineMessageManager.getOfflineMessages(this.node, bucketKeys);

    if (store.messages.length === 0) {
      console.log('No offline direct messages found');
      console.log(
        `[OFFLINE][CHECK][DONE] run=${runId} checkedChats=${checkedChats.length} fetchedMessages=0 processedMessages=0`,
      );
      return { checkedChatIds: checkedChats, unreadFromChats: new Map() };
    }

    console.log(`Found ${store.messages.length} offline direct message(s)`);
    console.log("found", store.messages.forEach(m => m.content))

    // extract unique messages per bucket
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

    // Track max timestamp per peer to update after processing
    const maxTimestampPerPeer: Map<string, number> = new Map();
    let processedCount = 0;
    const deferredGroupInfoSyncGroups = new Set<string>();

    const unreadFromChats: Map<number, number> = new Map();
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error("No user identity available")
    }

    for (const msg of store.messages) {
      if (!msg.bucket_key) continue;
      try {
        const bucketInfo = readBuckets.find(b => b.key === msg.bucket_key);
        if (!bucketInfo) {
          console.log(`Skipping message - unknown bucket key`);
          continue;
        }

        if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_invalid msgTs=${msg.timestamp}`,
          );
          continue;
        }
        if (msg.timestamp > Date.now() + OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_too_far_future msgTs=${msg.timestamp}`,
          );
          continue;
        }

        // Skip messages we've already processed (based on last read timestamp)
        if (msg.timestamp <= bucketInfo.lastReadTimestamp) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_leq_last_read msgTs=${msg.timestamp} lastReadTs=${bucketInfo.lastReadTimestamp}`,
          );
          continue;
        }

        const isSignatureValid = OfflineMessageManager.verifyOfflineMessageSignature(
          msg,
          bucketInfo.peerPubKey,
          msg.bucket_key
        );

        if (!isSignatureValid) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=signature_invalid`,
          );
          continue;
        }

        // Decrypt sender info to get username for display
        const senderInfo = MessageEncryption.decryptSenderInfo(msg, userIdentity.offlinePrivateKey);
        if (!senderInfo) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=sender_info_decrypt_failed`,
          );
          continue;
        }

        // Skip messages sent by ourselves (shouldn't happen)
        if (senderInfo.peer_id === this.node.peerId.toString()) {
          console.log(`[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=own_message`);
          continue;
        }
        if (senderInfo.peer_id !== bucketInfo.peerId) {
          console.log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=sender_peer_mismatch sender=${senderInfo.peer_id.slice(-8)} bucketPeer=${bucketInfo.peerId.slice(-8)}`,
          );
          continue;
        }
        this.reactivateRetiredPendingAcksForPeer(senderInfo.peer_id);

        // Process ACK if included - prune acknowledged messages from our local sent store.
        if (senderInfo.offline_ack_timestamp) {
          // eslint-disable-next-line no-await-in-loop
          await this.processOfflineAck(senderInfo.peer_id, senderInfo.offline_ack_timestamp);
        }

        // Decrypt message content early so we can inspect its type
        let decryptedContent = msg.content;
        if (msg.message_type === 'encrypted' || msg.message_type === 'hybrid') {
          decryptedContent = MessageEncryption.decryptOfflineMessage(msg, userIdentity.offlinePrivateKey);
        }

        // Check if this is a group control message - should we await this or let it process in bg?
        // eslint-disable-next-line no-await-in-loop
        const groupResult = await this.tryRouteGroupControlMessage(
          decryptedContent,
          senderInfo,
          deferredGroupInfoSyncGroups,
        );
        if (groupResult === 'retry') {
          console.log(
            `[OFFLINE][MSG][GROUP] run=${runId} msgId=${msg.id} from=${senderInfo.username} result=retry`,
          );
          continue;
        }
        if (groupResult === 'handled') {
          // Advance timestamp so we don't re-process
          const currentMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
          if (msg.timestamp > currentMax) {
            maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
          }
          console.log(
            `[OFFLINE][MSG][GROUP] run=${runId} msgId=${msg.id} from=${senderInfo.username} result=handled`,
          );
          continue;
        }

        // 'not_group': fall through to regular message handling
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

        console.log(
          `[OFFLINE][MSG][TEXT] run=${runId} msgId=${msg.id} from=${senderInfo.peer_id.slice(-8)} delivered=true`,
        );
      } catch (error: unknown) {
        generalErrorHandler(error, `Failed to process offline message`);
      }
    }

    for (const groupId of deferredGroupInfoSyncGroups) {
      this.scheduleDeferredGroupInfoSync(groupId);
    }

    // Update last read timestamp for each peer
    for (const [peerId, maxTimestamp] of maxTimestampPerPeer.entries()) {
      this.database.updateOfflineLastReadTimestampByPeerId(peerId, maxTimestamp);
      console.log(`[OFFLINE][PROCESS] run=${runId} updatedLastRead peer=${peerId.slice(-8)} ts=${maxTimestamp}`);
    }

    if (processedCount > 0) {
      console.log(`Processed ${processedCount} new offline direct messages`);
    }
    console.log(
      `[OFFLINE][CHECK][DONE] run=${runId} checkedChats=${checkedChats.length} fetchedMessages=${store.messages.length} processedMessages=${processedCount} updatedPeers=${maxTimestampPerPeer.size}`,
    );

    return { checkedChatIds: checkedChats, unreadFromChats: unreadFromChats };
  }

  async checkOfflineMessages(chatIds?: number[]): Promise<{ checkedChatIds: number[], unreadFromChats: Map<number, number> }> {
    try {
      return await this.performOfflineMessageCheck(chatIds);
    } catch (error: unknown) {
      generalErrorHandler(error);
      return { checkedChatIds: [], unreadFromChats: new Map() };
    }
  }

  private reactivateRetiredPendingAcksForPeer(peerId: string): void {
    const reactivatedCount = this.database.reactivateRetiredPendingAcksForTarget(peerId);
    if (reactivatedCount > 0) {
      console.log(
        `[GROUP-ACK][REACTIVATE] peer=${peerId.slice(-8)} count=${reactivatedCount}`,
      );
      this.enqueueImmediateGroupAckRepublish(peerId);
    }
  }

  private scheduleDeferredGroupInfoSync(groupId: string): void {
    if (!groupId) return;

    if (this.groupInfoSyncInFlight.has(groupId)) {
      this.groupInfoSyncPending.add(groupId);
      console.log(
        `[GROUP-INFO][SYNC][DEFER] group=${groupId} reason=in_flight`,
      );
      return;
    }

    const syncPromise = this.runDeferredGroupInfoSync(groupId)
      .catch((error: unknown) => {
        generalErrorHandler(error, `[GROUP-INFO][SYNC] Deferred sync failed for group=${groupId}`);
      })
      .finally(() => {
        this.groupInfoSyncInFlight.delete(groupId);
        if (this.groupInfoSyncPending.delete(groupId)) {
          this.scheduleDeferredGroupInfoSync(groupId);
        }
      });

    this.groupInfoSyncInFlight.set(groupId, syncPromise);
  }

  private async runDeferredGroupInfoSync(groupId: string): Promise<void> {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const responder = new GroupResponder({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });

    await responder.syncGroupInfoForLocalChat(groupId);
  }

  // Process an ACK from a peer - clear acknowledged messages from our bucket.
  private async processOfflineAck(peerId: string, ackTimestamp: number): Promise<void> {
    try {
      if (!Number.isFinite(ackTimestamp) || ackTimestamp <= 0) {
        console.log(`[OFFLINE][ACK_CLEAR][SKIP] peer=${peerId.slice(-8)} reason=invalid_ack_timestamp ackTs=${ackTimestamp}`);
        return;
      }
      const maxAllowedAckTs = Date.now() + OFFLINE_ACK_MAX_FUTURE_SKEW_MS;
      if (ackTimestamp > maxAllowedAckTs) {
        console.log(
          `[OFFLINE][ACK_CLEAR][SKIP] peer=${peerId.slice(-8)} reason=ack_too_far_future ackTs=${ackTimestamp} maxAllowed=${maxAllowedAckTs}`,
        );
        return;
      }

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

      // Clear acknowledged messages from our local sent store.
      // Pruned state is published on the next outbound write to this bucket.
      await OfflineMessageManager.clearAcknowledgedMessages(
        writeBucketKey,
        ackTimestamp,
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
    this.fileHandler.cleanup();
    this.groupMessaging.cleanup();

    if (this.groupAckStartupTimer) {
      clearTimeout(this.groupAckStartupTimer);
      this.groupAckStartupTimer = null;
    }
    if (this.groupAckRepublishTimer) {
      clearTimeout(this.groupAckRepublishTimer);
      this.groupAckRepublishTimer = null;
    }
    if (this.groupInfoStartupTimer) {
      clearTimeout(this.groupInfoStartupTimer);
      this.groupInfoStartupTimer = null;
    }
    if (this.groupInfoRepublishTimer) {
      clearTimeout(this.groupInfoRepublishTimer);
      this.groupInfoRepublishTimer = null;
    }
    for (const timer of this.nudgeFetchTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.groupNudgeFetchTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.nudgeTrailingTimers.values()) {
      clearTimeout(timer);
    }
    this.nudgeTrailingTimers.clear();
    this.nudgeFetchTimers.clear();
    this.groupNudgeFetchTimers.clear();
    this.groupStateCatchupInFlight.clear();
    this.groupStateCatchupPending.clear();
    this.peerActivityCheckCooldowns.clear();
    this.groupInfoSyncInFlight.clear();
    this.groupInfoSyncPending.clear();

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
   * Attempts to parse decrypted content as a group control message
   * Returns 'handled' if processed OK, 'retry' if it was a group message but failed (no timestamp advance),
   * or 'not_group' if this is a regular text message.
   */
  private async tryRouteGroupControlMessage(
    decryptedContent: string,
    senderInfo: OfflineSenderInfo,
    deferredGroupInfoSyncGroups: Set<string>,
  ): Promise<'handled' | 'retry' | 'not_group'> {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      return 'not_group';
    }

    if (!parsed || typeof parsed.type !== 'string') return 'not_group';

    const type = parsed.type;

    // Check if this is a known group message type
    const groupTypes = Object.values(GroupMessageType) as string[];
    if (!groupTypes.includes(type)) return 'not_group';
    // TODO also remove after testing
    const groupMeta = this.describeParsedGroupMessage(parsed as Record<string, unknown>);
    console.log(
      `MARINPARIN [GROUP][TRACE][ROUTE][IN] from=${senderInfo.username} ${groupMeta}`,
    );

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
      onMessageReceived: this.onMessageReceived,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
      onRegisterPrevEpochGrace: (groupId: string, keyVersion: number) => {
        this.groupMessaging.registerGraceContextForEpoch(groupId, keyVersion);
      },
    };

    try {
      const responder = new GroupResponder(deps);
      const creator = new GroupCreator(deps);
      const groupId = (parsed as { groupId: string }).groupId;

      switch (type) {
        // --- Messages handled by GroupResponder (we are the invitee) ---
        case GroupMessageType.GROUP_INVITE: {
          await responder.handleGroupInvite(parsed as any);
          console.log(`[GROUP] Processed GROUP_INVITE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_RESPONSE_ACK: {
          responder.handleInviteResponseAck(parsed as any);
          console.log(`[GROUP] Processed GROUP_INVITE_RESPONSE_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_WELCOME: {
          await responder.handleGroupWelcome(parsed as any);
          deferredGroupInfoSyncGroups.add(groupId);
          this.groupMessaging.subscribeToGroupTopic(groupId)
          console.log(`[GROUP] Processed GROUP_WELCOME from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_STATE_UPDATE: {
          const beforeUpdateChat = this.database.getChatByGroupId(groupId);
          const previousKeyVersion = beforeUpdateChat?.key_version ?? 0;
          const previousGroupStatus = beforeUpdateChat?.group_status ?? null;
          await responder.handleGroupStateUpdate(parsed as any);

          const updatedChat = this.database.getChatByGroupId(groupId);
          const keyVersionAdvanced = (updatedChat?.key_version ?? 0) > previousKeyVersion;
          const becameRemoved = updatedChat?.group_status === 'removed';
          if (updatedChat && (keyVersionAdvanced || becameRemoved || previousGroupStatus === 'rekeying')) {
            const trigger = keyVersionAdvanced
              ? 'key_version_advanced'
              : becameRemoved
                ? 'became_removed'
                : 'was_rekeying';
            this.scheduleGroupStateUpdateCatchup(updatedChat.id, groupId, trigger);
          }
          if (['removed', 'left', 'disbanded'].includes(updatedChat?.group_status || '')) {
            this.groupMessaging.deactivateGroup(groupId);
          } else {
            this.groupMessaging.subscribeToGroupTopic(groupId)
            deferredGroupInfoSyncGroups.add(groupId);
          }
          console.log(`[GROUP] Processed GROUP_STATE_UPDATE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_KICK: {
          const removedSelf = await responder.handleGroupKick(parsed as any);
          if (removedSelf) {
            this.groupMessaging.deactivateGroup(groupId);
          }
          console.log(`[GROUP] Processed GROUP_KICK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_DISBAND: {
          const disbandApplied = await responder.handleGroupDisband(parsed as any);
          if (disbandApplied) {
            this.groupMessaging.deactivateGroup(groupId);
          }
          console.log(`[GROUP] Processed GROUP_DISBAND from ${senderInfo.username}`);
          break;
        }

        // --- Messages handled by GroupCreator (we are the creator) ---
        case GroupMessageType.GROUP_INVITE_RESPONSE: {
          await creator.processInviteResponse(parsed as any);
          const chat = this.database.getChatByGroupId(groupId);
          if (chat?.group_status === 'active' && (chat.key_version ?? 0) > 0) {
            this.groupMessaging.subscribeToGroupTopic(groupId)
          }
          console.log(`[GROUP] Processed GROUP_INVITE_RESPONSE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_LEAVE_REQUEST: {
          await creator.processLeaveRequest(parsed as any, senderInfo.peer_id);
          const chat = this.database.getChatByGroupId(groupId);
          if (chat?.group_status === 'active' && (chat.key_version ?? 0) > 0) {
            this.groupMessaging.subscribeToGroupTopic(groupId)
          }
          console.log(`[GROUP] Processed GROUP_LEAVE_REQUEST from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_STATE_RESYNC_REQUEST: {
          await creator.processStateResyncRequest(parsed as any, senderInfo.peer_id);
          console.log(`[GROUP] Processed GROUP_STATE_RESYNC_REQUEST from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_DELIVERED_ACK: {
          await creator.handleInviteDeliveredAck(parsed as any, senderInfo.peer_id);
          console.log(`[GROUP] Processed GROUP_INVITE_DELIVERED_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_CONTROL_ACK: {
          await creator.handleControlAck(parsed as any, senderInfo.peer_id);
          console.log(`[GROUP] Processed GROUP_CONTROL_ACK from ${senderInfo.username}`);
          break;
        }

        // TODO I dont remember why I put this here
        case GroupMessageType.GROUP_MESSAGE:
          console.log(`[GROUP] Received ${type} from ${senderInfo.username}`);
          break;

        default:
          console.log(`[GROUP] Unknown group message type: ${type}`);
          return 'retry';
      }
      this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (this.isPermanentGroupControlError(errorText)) {
        this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
        console.warn(
          `[GROUP][TRACE][ROUTE][DROP_PERMANENT] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} reason=${errorText}`,
        );
        return 'handled';
      }

      const attempts = this.bumpGroupControlRetryAttempt(senderInfo.peer_id, parsed as Record<string, unknown>, errorText);
      if (attempts >= MessageHandler.GROUP_CONTROL_MAX_RETRIES) {
        this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
        console.warn(
          `[GROUP][TRACE][ROUTE][DROP_MAX_RETRIES] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} attempts=${attempts} reason=${errorText}`,
        );
        return 'handled';
      }

      generalErrorHandler(error, `[GROUP] Error handling ${type} from ${senderInfo.username}; retry ${attempts}/${MessageHandler.GROUP_CONTROL_MAX_RETRIES}`);
      return 'retry'; // Transient failure — retry a bounded number of times
    }
    console.log(
      `[GROUP][TRACE][ROUTE][DONE] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} result=handled`,
    );

    return 'handled';
  }

  private describeParsedGroupMessage(parsed: Record<string, unknown>): string {
    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const groupId = typeof parsed.groupId === 'string' ? parsed.groupId : 'n/a';
    const inviteId = typeof parsed.inviteId === 'string' ? parsed.inviteId : 'n/a';
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : 'n/a';
    const ackedMessageId = typeof parsed.ackedMessageId === 'string' ? parsed.ackedMessageId : 'n/a';
    const ackId = typeof parsed.ackId === 'string' ? parsed.ackId : 'n/a';
    return `type=${type} group=${groupId} inviteId=${inviteId} msgId=${messageId} ackedMsgId=${ackedMessageId} ackId=${ackId}`;
  }

  private buildGroupControlRetryKey(senderPeerId: string, parsed: Record<string, unknown>): string {
    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const groupId = typeof parsed.groupId === 'string' ? parsed.groupId : 'n/a';
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : '';
    const inviteId = typeof parsed.inviteId === 'string' ? parsed.inviteId : '';
    const ackId = typeof parsed.ackId === 'string' ? parsed.ackId : '';
    const ackedMessageId = typeof parsed.ackedMessageId === 'string' ? parsed.ackedMessageId : '';
    const fallbackId = typeof parsed.timestamp === 'number' ? String(parsed.timestamp) : 'n/a';
    const id = messageId || ackId || inviteId || ackedMessageId || fallbackId;
    return `${senderPeerId}|${type}|${groupId}|${id}`;
  }

  private bumpGroupControlRetryAttempt(senderPeerId: string, parsed: Record<string, unknown>, errorText: string): number {
    this.pruneGroupControlRetryState();
    const key = this.buildGroupControlRetryKey(senderPeerId, parsed);
    const prev = this.groupControlRetryState.get(key);
    const attempts = (prev?.attempts ?? 0) + 1;
    this.groupControlRetryState.set(key, {
      attempts,
      lastSeenAt: Date.now(),
      lastError: errorText,
    });
    return attempts;
  }

  private clearGroupControlRetryState(senderPeerId: string, parsed: Record<string, unknown>): void {
    const key = this.buildGroupControlRetryKey(senderPeerId, parsed);
    this.groupControlRetryState.delete(key);
  }

  private pruneGroupControlRetryState(): void {
    if (this.groupControlRetryState.size === 0) return;
    const now = Date.now();
    for (const [key, value] of this.groupControlRetryState.entries()) {
      if (now - value.lastSeenAt > MessageHandler.GROUP_CONTROL_RETRY_TTL_MS) {
        this.groupControlRetryState.delete(key);
      }
    }
    if (this.groupControlRetryState.size <= MessageHandler.GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES) {
      return;
    }
    // Defensive cap in case of abuse.
    const entries = Array.from(this.groupControlRetryState.entries())
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    const overflow = this.groupControlRetryState.size - MessageHandler.GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      const entry = entries[i];
      if (!entry) break;
      this.groupControlRetryState.delete(entry[0]);
    }
  }

  private isPermanentGroupControlError(errorText: string): boolean {
    const normalized = errorText.toLowerCase();
    return (
      normalized.includes('signature verification failed')
      || normalized.includes('missing signature')
      || normalized.includes('invalid signature')
      || normalized.includes('invalid timestamp')
      || normalized.includes('timestamp invalid')
      || normalized.includes('timestamp too far in future')
      || normalized.includes('cannot read properties of undefined')
      || normalized.includes('cannot destructure property')
    );
  }
} 
