import * as path from 'path';
import { createChatNode, connectToBootstrap } from './lib/node-setup.js';
import { UsernameRegistry } from './lib/username-registry.js';
import { MessageHandler } from './lib/message-handler.js';
import { EncryptedUserIdentity } from './lib/encrypted-user-identity.js';
import { ChatDatabase } from './lib/db/database.js';
import { DATABASE_CLEANUP_INTERVAL } from './constants.js';
import type { ChatNode, ContactRequestEvent, KeyExchangeEvent, PasswordResponse, ChatCreatedEvent, KeyExchangeFailedEvent, MessageReceivedEvent, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, PendingFileReceivedEvent, GroupChatActivatedEvent } from './types.js';

export interface P2PCore {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  usernameRegistry: UsernameRegistry;
  messageHandler: MessageHandler;
  retryBootstrap: () => Promise<void>;
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
  onDHTConnectionStatus: (status: { connected: boolean }) => void;
  onKeyExchangeSent: (data: KeyExchangeEvent) => void;
  onContactRequestReceived: (data: ContactRequestEvent) => void;
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
  onOfflineMessagesFetchComplete: (chatIds: number[]) => void;
}

/**
 * Initialize the P2P core (libp2p node, database, identity, messaging)
 * This is the main entry point for the Kiyeovo P2P functionality
 */
export async function initializeP2PCore(config: P2PCoreConfig): Promise<P2PCore> {
  const { onStatus, onDHTConnectionStatus, onKeyExchangeSent, onContactRequestReceived, onChatCreated, onKeyExchangeFailed, onMessageReceived, onRestoreUsername, onFileTransferProgress, onFileTransferComplete, onFileTransferFailed, onPendingFileReceived, onGroupChatActivated, onOfflineMessagesFetchComplete } = config;
  const sendStatus = (message: string, stage: any) => {
    console.log(`[P2P Core] ${message}`);
    onStatus(message, stage);
  };

  const sendDHTConnectionStatus = (status: { connected: boolean }) => {
    console.log(`[P2P Core] DHT connection status: ${status.connected}`);
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

  // Store Tor configuration in database for node-setup to read
  if (config.torConfig) {
    console.log('[P2P Core] Storing Tor configuration in database...');
    database.setSetting('tor_enabled', config.torConfig.enabled ? 'true' : 'false');
    database.setSetting('tor_socks_port', config.torConfig.socksPort.toString());
    if (config.torConfig.onionAddress) {
      // Store onion host; node-setup constructs full announce multiaddr later.
      database.setSetting('tor_onion_address', config.torConfig.onionAddress);
      console.log(`[P2P Core] Tor onion address stored: ${config.torConfig.onionAddress}`);
    }
  }

  // Load or create encrypted user identity
  sendStatus('Loading user identity...', 'identity');
  const userIdentity = await EncryptedUserIdentity.loadOrCreateEncrypted(
    database,
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
  await connectToBootstrap(node, database);

  // Start periodic DHT connection status checker (every 30 seconds)
  let dhtStatusCheckInFlight: Promise<void> | null = null;
  let reconnectInProgress = false;

  const probeAnyAliveConnection = async (): Promise<boolean> => {
    const connections = node.getConnections();
    if (connections.length === 0) return false;

    const toProbe = connections.slice(0, 3);
    try {
      // Promise.any: resolves as soon as one ping succeeds, rejects only if ALL fail
      await Promise.any(
        toProbe.map(conn =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (node.services as any).ping.ping(conn.remotePeer, {
            signal: AbortSignal.timeout(15000),
          }),
        ),
      );
      return true;
    } catch {
      return false;
    }
  };

  const checkDHTStatus = async () => {
    if (dhtStatusCheckInFlight) return dhtStatusCheckInFlight;

    dhtStatusCheckInFlight = (async () => {
      try {
        const connections = node.getConnections();
        console.log(`[P2P Core] Peers: ${connections.map(p => p.remotePeer.toString())}`);

        if (connections.length === 0) {
          sendDHTConnectionStatus({ connected: false });
          return;
        }

        // Verify at least one peer is actually reachable before reporting "connected".
        const anyAlive = await probeAnyAliveConnection();
        if (!anyAlive) {
          sendDHTConnectionStatus({ connected: false });

          if (reconnectInProgress) {
            console.log('[P2P Core] Reconnect already in progress, skipping duplicate reconnect attempt');
            return;
          }

          reconnectInProgress = true;
          try {
            console.log('[P2P Core] All sampled connections appear stale; closing and reconnecting...');
            const staleConnections = node.getConnections();
            if (staleConnections.length > 0) {
              await Promise.allSettled(staleConnections.map(conn => conn.close()));
            }

            await connectToBootstrap(node, database);

            // Verify immediately after reconnect attempt so UI state is up to date.
            const aliveAfterReconnect = await probeAnyAliveConnection();
            const liveCount = aliveAfterReconnect ? node.getConnections().length : 0;
            sendDHTConnectionStatus({ connected: liveCount > 0 });
            if (liveCount > 0) {
              console.log(`[P2P Core] Network status: ${liveCount} peer(s) connected after reconnect`);
            }
            return;
          } finally {
            reconnectInProgress = false;
          }
        }

        const liveCount = node.getConnections().length;
        sendDHTConnectionStatus({ connected: liveCount > 0 });
        if (liveCount > 0) {
          console.log(`[P2P Core] Network status: ${liveCount} peer(s) connected`);
        }
      } catch (error) {
        console.error('[P2P Core] Failed to check peer count:', error);
        sendDHTConnectionStatus({ connected: false });
      } finally {
        dhtStatusCheckInFlight = null;
      }
    })();

    return dhtStatusCheckInFlight;
  };

  // Send initial status immediately
  await checkDHTStatus();

  setTimeout(() => {
    void checkDHTStatus();
  }, 5000);

  // Then check periodically
  const dhtStatusInterval = setInterval(() => {
    void checkDHTStatus();
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

  const sendOfflineMessagesFetchComplete = (chatIds: number[]) => {
    onOfflineMessagesFetchComplete(chatIds);
  };

  const messageHandler = new MessageHandler(
    node,
    usernameRegistry,
    database,
    sendKeyExchangeSent,
    sendContactRequestReceived,
    sendChatCreated,
    sendKeyExchangeFailed,
    sendMessageReceived,
    sendFileTransferProgress,
    sendFileTransferComplete,
    sendFileTransferFailed,
    sendPendingFileReceived,
    sendGroupChatActivated,
    sendOfflineMessagesFetchComplete,
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
    retryBootstrap: async () => {
      if (reconnectInProgress) {
        console.log('[P2P Core] Reconnect already in progress, ignoring manual retry');
        return;
      }
      console.log('[P2P Core] Retrying bootstrap connection...');
      // Close all existing connections first — stale ones (after sleep) stay in the pool
      // and connectToBootstrap would skip already-connected peers, returning instantly.
      const existing = node.getConnections();
      if (existing.length > 0) {
        console.log(`[P2P Core] Closing ${existing.length} potentially stale connection(s) before reconnect...`);
        await Promise.allSettled(existing.map(c => c.close()));
      }
      await connectToBootstrap(node, database);
      // Verify the new connection is actually alive
      await checkDHTStatus();
    },
    cleanup: async () => {
      console.log('[P2P Core] Shutting down...');
      try {
        messageHandler.cleanup();
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
