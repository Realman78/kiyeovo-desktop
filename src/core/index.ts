import * as path from 'path';
import dotenv from 'dotenv';
import {
  createChatNode,
  connectToBootstrap,
  dialConfiguredFastRelays,
  getBootstrapPeerIdsForCurrentMode,
  getBootstrapRetryTimeoutMs,
} from './lib/node-setup.js';
import { UsernameRegistry } from './lib/username-registry.js';
import { MessageHandler } from './lib/message-handler.js';
import { EncryptedUserIdentity } from './lib/encrypted-user-identity.js';
import { ChatDatabase } from './lib/db/database.js';
import { createNetworkHealthMonitor } from './lib/network-health.js';
import { createReconnectController } from './lib/reconnect-controller.js';
import { DATABASE_CLEANUP_INTERVAL, getNetworkModeConfig, MAX_BOOTSTRAP_NODES_FAST, MAX_BOOTSTRAP_NODES_TOR } from './constants.js';
import type {
  ChatNode,
  ContactRequestEvent,
  ContactRequestCancelledEvent,
  KeyExchangeEvent,
  PasswordResponse,
  ChatCreatedEvent,
  KeyExchangeFailedEvent,
  MessageReceivedEvent,
  FileTransferProgressEvent,
  FileTransferCompleteEvent,
  FileTransferFailedEvent,
  PendingFileReceivedEvent,
  GroupChatActivatedEvent,
  GroupMembersUpdatedEvent,
  NetworkMode,
  CallIncomingEvent,
  CallSignalReceivedEvent,
  CallStateChangedEvent,
  CallErrorEvent,
  BootstrapConnectResult,
} from './types.js';
import type { DhtStatusCheckSource } from './lib/network-health.js';

dotenv.config();

export interface P2PCore {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  usernameRegistry: UsernameRegistry;
  messageHandler: MessageHandler;
  networkMode: NetworkMode;
  getCurrentDhtStatus: () => boolean | null;
  retryBootstrap: () => Promise<BootstrapConnectResult>;
  retryRelays: () => Promise<{ attempted: number; connected: number }>;
  cleanup: () => Promise<void>;
}

export interface TorConfig {
  enabled: boolean;
  socksPort: number;
  onionAddress: string | null; // null means Tor is disabled or not yet started
}

export interface P2PCoreConfig {
  dataDir: string;
  port: number;
  torConfig?: TorConfig; // Optional Tor configuration from TorManager
  passwordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>;
  onStatus: (message: string, stage: 'tor' | 'database' | 'identity' | 'node' | 'registry' | 'messaging' | 'complete' | 'peerId') => void;
  onDHTConnectionStatus: (status: { connected: boolean | null }) => void;
  onKeyExchangeSent: (data: KeyExchangeEvent) => void;
  onContactRequestReceived: (data: ContactRequestEvent) => void;
  onContactRequestCancelled: (data: ContactRequestCancelledEvent) => void;
  onChatCreated: (data: ChatCreatedEvent) => void;
  onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void;
  onMessageReceived: (data: MessageReceivedEvent) => void;
  onBootstrapNodes: (nodes: string[]) => void;
  onRestoreUsername: (username: string) => void;
  onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  onPendingFileReceived: (data: PendingFileReceivedEvent) => void;
  onGroupChatActivated: (data: GroupChatActivatedEvent) => void;
  onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void;
  onOfflineMessagesFetchComplete: (chatIds: number[]) => void;
  onCallIncoming: (data: CallIncomingEvent) => void;
  onCallSignalReceived: (data: CallSignalReceivedEvent) => void;
  onCallStateChanged: (data: CallStateChangedEvent) => void;
  onCallError: (data: CallErrorEvent) => void;
}

/**
 * Initialize the P2P core (libp2p node, database, identity, messaging)
 * This is the main entry point for the Kiyeovo P2P functionality
 */
export async function initializeP2PCore(config: P2PCoreConfig): Promise<P2PCore> {
  const {
    onStatus,
    onDHTConnectionStatus,
    onKeyExchangeSent,
    onContactRequestReceived,
    onContactRequestCancelled,
    onChatCreated,
    onKeyExchangeFailed,
    onMessageReceived,
    onRestoreUsername,
    onFileTransferProgress,
    onFileTransferComplete,
    onFileTransferFailed,
    onPendingFileReceived,
    onGroupChatActivated,
    onGroupMembersUpdated,
    onOfflineMessagesFetchComplete,
    onCallIncoming,
    onCallSignalReceived,
    onCallStateChanged,
    onCallError,
  } = config;

  const sendStatus = (message: string, stage: any) => {
    console.log(`[P2P Core] ${message}`);
    onStatus(message, stage);
  };

  const sendDHTConnectionStatus = (status: { connected: boolean | null }) => {
    console.log(`[P2P Core] DHT connection status: ${String(status.connected)}`);
    onDHTConnectionStatus(status);
  };

  const sendKeyExchangeSent = (data: KeyExchangeEvent) => {
    console.log(`[P2P Core] Key exchange sent: ${data.username}`);
    onKeyExchangeSent(data);
  };

  const sendChatCreated = (data: ChatCreatedEvent) => {
    console.log(`[P2P Core] Chat created with ${data.username}: chatId=${data.chatId}`);
    onChatCreated(data);
  };

  const sendContactRequestCancelled = (data: ContactRequestCancelledEvent) => {
    console.log(`[P2P Core] Contact request cancelled: ${data.username}`);
    onContactRequestCancelled(data);
  };

  const sendKeyExchangeFailed = (data: KeyExchangeFailedEvent) => {
    console.log(`[P2P Core] Key exchange failed with ${data.username}: ${data.error}`);
    onKeyExchangeFailed(data);
  };

  const sendMessageReceived = (data: MessageReceivedEvent) => {
    console.log(`[P2P Core] Message received in chat ${data.chatId} from ${data.senderUsername}`);
    onMessageReceived(data);
  };

  const sendRestoreUsername = (username: string) => {
    console.log(`[P2P Core] Restore username: ${username}`);
    onRestoreUsername(username);
  };

  sendStatus(`Starting Kiyeovo P2P node on port ${config.port}...`, 'database');

  // Initialize database
  const dbPath = path.join(config.dataDir, 'chat.db');
  const database = new ChatDatabase(dbPath);
  sendStatus(`Database initialized at: ${dbPath}`, 'database');

  // U1: load persisted network mode before node initialization.
  const networkMode = database.getSessionNetworkMode();
  sendStatus(`Loaded network mode: ${networkMode}`, 'database');

  // Store Tor configuration in database for node-setup to read
  if (config.torConfig) {
    console.log('[P2P Core] Storing Tor configuration in database...');
    database.setSetting('tor_socks_port', config.torConfig.socksPort.toString());
    if (config.torConfig.onionAddress) {
      // Store onion host; node-setup constructs full announce multiaddr later.
      database.setSetting('tor_onion_address', config.torConfig.onionAddress);
      console.log(`[P2P Core] Tor onion address stored: ${config.torConfig.onionAddress}`);
    }
  }

  // Load or create encrypted user identity
  sendStatus('Loading user identity...', 'identity');
  const userIdentity = await EncryptedUserIdentity.loadOrCreateEncryptedForMode(
    database,
    networkMode,
    config.passwordPrompt,
    sendStatus
  );
  sendStatus('User identity loaded', 'identity');

  // Create libp2p node
  sendStatus('Creating libp2p node...', 'node');
  const node = await createChatNode(config.port, userIdentity, database);
  sendStatus(`Peer started. Peer ID: ${node.peerId.toString()}`, 'node');
  sendStatus(node.peerId.toString(), 'peerId');

  node.getMultiaddrs().forEach(addr => {
    console.log(`[P2P Core] Listening on: ${addr.toString()}`);
  });

  // Setup peer discovery logging
  node.addEventListener('peer:discovery', (evt) => {
    const peer = evt.detail;
    if (peer.id.toString() === node.peerId.toString()) {
      return;
    }
    console.log(`[P2P Core] Peer discovered: ${peer.id.toString()}`);
  });

  // Connect to bootstrap nodes
  sendStatus('Connecting to bootstrap nodes...', 'node');
  const startupBootstrapResult = await connectToBootstrap(node, database);
  console.log(`[P2P Core] Startup bootstrap status=${startupBootstrapResult.status} connected=${startupBootstrapResult.connectedCount}/${startupBootstrapResult.targetConnectionCount} attempts=${startupBootstrapResult.attempts.length}`,);

  // Start periodic DHT connection status checker (every 30 seconds)
  let dhtStatusCheckInFlight: Promise<void> | null = null;
  let dhtStatusActiveCheckId: number | null = null;
  let dhtStatusActiveStartedAt = 0;
  let dhtStatusCheckSeq = 0;
  let currentDhtConnected: boolean | null = null;
  const DHT_PING_PROBE_TIMEOUT_MS = 6_000;
  const DHT_PING_PROBE_HARD_TIMEOUT_MS = 7_000;
  const activeDhtProtocol = getNetworkModeConfig(networkMode).dhtProtocol;
  const emitDhtStatus = (connected: boolean | null, reason: string) => {
    const peers = node.getConnections().map((p) => p.remotePeer.toString());
    console.log(
      `[DHT-STATUS][CORE][EMIT] connected=${String(connected)} reason=${reason} peerCount=${peers.length} peers=${peers.join(',') || 'none'}`,
    );
    currentDhtConnected = connected;
    sendDHTConnectionStatus({ connected });
  };

  const getConnectedBootstrapConnections = (
    connectionsToCheck: ReturnType<typeof node.getConnections>,
  ): ReturnType<typeof node.getConnections> => {
    const bootstrapPeerIds = getBootstrapPeerIdsForCurrentMode(database, node.peerId.toString());
    return connectionsToCheck.filter((conn) => bootstrapPeerIds.has(conn.remotePeer.toString()));
  };

  const networkHealth = createNetworkHealthMonitor({
    activeDhtProtocol,
    getConnectedBootstrapConnections,
    node,
    pingProbeHardTimeoutMs: DHT_PING_PROBE_HARD_TIMEOUT_MS,
    pingProbeTimeoutMs: DHT_PING_PROBE_TIMEOUT_MS,
  });

  const reconnectController = createReconnectController();

  const checkDHTStatus = async (source: DhtStatusCheckSource = 'timer_30s') => {
    if (dhtStatusCheckInFlight) {
      const ageMs = dhtStatusActiveStartedAt > 0 ? Date.now() - dhtStatusActiveStartedAt : -1;
      const staleInFlight = dhtStatusActiveCheckId === null || ageMs < 0 || ageMs > 90_000;
      if (staleInFlight) {
        console.warn(
          `[DHT-STATUS][CORE][CHECK][RESET] reason=stale_in_flight source=${source} activeId=${String(dhtStatusActiveCheckId)} ageMs=${ageMs}`,
        );
        dhtStatusCheckInFlight = null;
        dhtStatusActiveCheckId = null;
        dhtStatusActiveStartedAt = 0;
      } else {
        console.log(
          `[DHT-STATUS][CORE][CHECK][SKIP] reason=in_flight source=${source} activeId=${String(dhtStatusActiveCheckId)} ageMs=${ageMs}`,
        );
        return dhtStatusCheckInFlight;
      }
    }

    const checkId = ++dhtStatusCheckSeq;
    dhtStatusActiveCheckId = checkId;
    dhtStatusActiveStartedAt = Date.now();
    console.log(`[DHT-STATUS][CORE][CHECK][ACQUIRE] id=${checkId} source=${source}`);

    dhtStatusCheckInFlight = (async () => {
      try {
        const suppressNegativeStatusDuringBootstrapRetry = reconnectController.shouldSuppressNegativeStatusDuringBootstrapRetry(source);
        const allConnections = node.getConnections();

        console.log(`[DHT-STATUS][CORE][CHECK][START] id=${checkId} source=${source} peerCount=${allConnections.length}`);
        console.log(`[P2P Core] Peers: ${allConnections.map(p => p.remotePeer.toString())}`);

        const healthEvaluation = await networkHealth.evaluateStatus(allConnections, source, {
          suppressNegativeStatusDuringBootstrapRetry,
        });

        emitDhtStatus(healthEvaluation.status, healthEvaluation.reason);

        if (healthEvaluation.status === true) {
          console.log(
            '[P2P Core] Network status: connected via ' +
            (healthEvaluation.probeSource === 'dht' ? 'DHT-capable peers' : 'bootstrap fallback probe'),
          );
          return;
        }

        if (!reconnectController.recordHealthStatus(healthEvaluation.status)) {
          return;
        }

        if (!reconnectController.tryBeginReconnect()) {
          return;
        }

        try {
          console.log('[P2P Core] All sampled connections appear stale; closing and reconnecting...');
          const staleConnections = node.getConnections();
          if (staleConnections.length > 0) {
            await Promise.allSettled(staleConnections.map(conn => conn.close()));
          }

          const reconnectBootstrapResult = await connectToBootstrap(node, database);
          console.log(
            `[P2P Core] Reconnect bootstrap status=${reconnectBootstrapResult.status} connected=${reconnectBootstrapResult.connectedCount}/${reconnectBootstrapResult.targetConnectionCount} attempts=${reconnectBootstrapResult.attempts.length}`,
          );

          // Verify immediately after reconnect attempt so UI state is up to date.
          const dhtAfterReconnect = await networkHealth.getDhtCapableConnections();
          const aliveAfterReconnect = await networkHealth.probeAnyAliveConnection(dhtAfterReconnect, {
            probeSource: 'dht',
          });
          const liveCount = aliveAfterReconnect ? dhtAfterReconnect.length : 0;
          emitDhtStatus(liveCount > 0, 'post_reconnect_dht_probe');
          if (liveCount > 0) {
            reconnectController.resetProbeFailures();
            console.log(`[P2P Core] Network status: ${liveCount} DHT peer(s) connected after reconnect`);
          }
          return;
        } finally {
          reconnectController.finishReconnect();
        }
      } catch (error) {
        console.error('[P2P Core] Failed to check peer count:', error);
        emitDhtStatus(false, 'check_exception');
      } finally {
        const durationMs = dhtStatusActiveStartedAt > 0 ? Date.now() - dhtStatusActiveStartedAt : -1;
        console.log(
          `[DHT-STATUS][CORE][CHECK][DONE] id=${checkId} source=${source} durationMs=${durationMs}`,
        );
        dhtStatusCheckInFlight = null;
        dhtStatusActiveCheckId = null;
        dhtStatusActiveStartedAt = 0;
      }
    })();

    return dhtStatusCheckInFlight;
  };

  // Send initial status immediately
  await checkDHTStatus('startup');

  setTimeout(() => {
    console.log('[DHT-STATUS][CORE][TIMER] one_shot_5s fired');
    void checkDHTStatus('timer_5s');
  }, 5000);

  // Then check periodically
  const dhtStatusInterval = setInterval(() => {
    console.log('[DHT-STATUS][CORE][TIMER] periodic_30s fired');
    void checkDHTStatus('timer_30s');
  }, 30000); // 30 seconds

  // Initialize username registry
  sendStatus('Initializing username registry...', 'registry');
  const usernameRegistry = new UsernameRegistry(node, database);
  await usernameRegistry.initialize(userIdentity, sendRestoreUsername);

  // Initialize message handler
  sendStatus('Initializing message handler...', 'messaging');

  const sendContactRequestReceived = (data: ContactRequestEvent) => {
    console.log(`[P2P Core] Contact request received from ${data.username}`);
    onContactRequestReceived(data);
  };

  const sendFileTransferProgress = (data: FileTransferProgressEvent) => {
    console.log(`[P2P Core] File transfer progress: ${data.current}/${data.total} chunks`);
    onFileTransferProgress(data);
  };

  const sendFileTransferComplete = (data: FileTransferCompleteEvent) => {
    console.log(`[P2P Core] File transfer complete: ${data.filePath}`);
    onFileTransferComplete(data);
  };

  const sendFileTransferFailed = (data: FileTransferFailedEvent) => {
    console.log(`[P2P Core] File transfer failed: ${data.error}`);
    onFileTransferFailed(data);
  };

  const sendPendingFileReceived = (data: PendingFileReceivedEvent) => {
    console.log(`[P2P Core] Pending file received: ${data.filename} from ${data.senderUsername}`);
    onPendingFileReceived(data);
  };

  const sendGroupChatActivated = (data: GroupChatActivatedEvent) => {
    console.log(`[P2P Core] Group chat activated: chatId=${data.chatId}`);
    onGroupChatActivated(data);
  };

  const sendGroupMembersUpdated = (data: GroupMembersUpdatedEvent) => {
    console.log(`[P2P Core] Group members updated: chatId=${data.chatId}, member=${data.memberPeerId}`);
    onGroupMembersUpdated(data);
  };

  const sendOfflineMessagesFetchComplete = (chatIds: number[]) => {
    onOfflineMessagesFetchComplete(chatIds);
  };

  const sendCallIncoming = (data: CallIncomingEvent) => {
    onCallIncoming(data);
  };

  const sendCallSignalReceived = (data: CallSignalReceivedEvent) => {
    onCallSignalReceived(data);
  };

  const sendCallStateChanged = (data: CallStateChangedEvent) => {
    onCallStateChanged(data);
  };

  const sendCallError = (data: CallErrorEvent) => {
    onCallError(data);
  };

  const messageHandler = new MessageHandler(
    node,
    usernameRegistry,
    database,
    sendKeyExchangeSent,
    sendContactRequestReceived,
    sendContactRequestCancelled,
    sendChatCreated,
    sendKeyExchangeFailed,
    sendMessageReceived,
    sendFileTransferProgress,
    sendFileTransferComplete,
    sendFileTransferFailed,
    sendPendingFileReceived,
    sendGroupChatActivated,
    sendGroupMembersUpdated,
    sendOfflineMessagesFetchComplete,
    sendCallIncoming,
    sendCallSignalReceived,
    sendCallStateChanged,
    sendCallError,
  );

  // Offline messages will be checked from UI after chats load

  // Start periodic database cleanup
  const cleanupInterval = setInterval(() => {
    database.runCleanupTasks();
  }, DATABASE_CLEANUP_INTERVAL);

  // Run cleanup once on startup
  database.runCleanupTasks();

  sendStatus('P2P Core initialized successfully', 'complete');

  // Return core instance with cleanup function
  return {
    node,
    database,
    userIdentity,
    usernameRegistry,
    messageHandler,
    networkMode,
    getCurrentDhtStatus: () => {
      return currentDhtConnected;
    },
    retryBootstrap: async () => {
      if (reconnectController.isReconnectInProgress()) {
        console.log('[P2P Core] Reconnect already in progress, ignoring manual retry');
        return {
          status: 'aborted',
          connectedAddresses: [],
          connectedPeerIds: [],
          connectedCount: 0,
          targetConnectionCount: database.getSessionNetworkMode() === 'anonymous' ? MAX_BOOTSTRAP_NODES_TOR : MAX_BOOTSTRAP_NODES_FAST,
          targetReached: false,
          attempts: [],
        } satisfies BootstrapConnectResult;
      }
      const currentNetworkMode = database.getSessionNetworkMode();
      const retryBootstrapTimeoutMs = getBootstrapRetryTimeoutMs(currentNetworkMode);
      console.log('[P2P Core] Retrying bootstrap connection...');
      reconnectController.beginBootstrapRetry();
      emitDhtStatus(null, 'bootstrap_retry_in_progress');

      const retryAbortController = new AbortController();
      const timeoutId = setTimeout(() => retryAbortController.abort(), retryBootstrapTimeoutMs);
      let bootstrapRetryResult: BootstrapConnectResult;
      try {
        bootstrapRetryResult = await connectToBootstrap(node, database, { signal: retryAbortController.signal });
      } catch (error) {
        throw error;
      } finally {
        reconnectController.endBootstrapRetry();
        clearTimeout(timeoutId);
      }

      if (bootstrapRetryResult.connectedCount > 0) {
        emitDhtStatus(null, 'bootstrap_retry_warmup');
        // Give fresh bootstrap connections time to complete identify/DHT warm-up before probing them.
        reconnectController.schedulePostRetryVerify(currentNetworkMode, () => {
          void checkDHTStatus('post_retry_verify');
        });
      } else {
        emitDhtStatus(false, 'bootstrap_retry_failed');
      }

      return bootstrapRetryResult;
    },
    retryRelays: async () => {
      const result = await dialConfiguredFastRelays(node, database);
      return { attempted: result.attempted, connected: result.connected };
    },
    cleanup: async () => {
      console.log('[P2P Core] Shutting down...');
      try {
        await messageHandler.cleanup();
        reconnectController.clearPostRetryVerifyTimeout();
        clearInterval(cleanupInterval);
        clearInterval(dhtStatusInterval);
        database.close();
        await node.stop();
        console.log('[P2P Core] Shutdown complete');
      } catch (error) {
        console.error('[P2P Core] Error during shutdown:', error);
        throw error;
      }
    }
  };
}

export * from './types.js';
export * from './constants.js';
