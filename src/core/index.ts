import * as path from 'path';
import { createChatNode, connectToBootstrap } from './lib/node-setup.js';
import { UsernameRegistry } from './lib/username-registry.js';
import { MessageHandler } from './lib/message-handler.js';
import { EncryptedUserIdentity } from './lib/encrypted-user-identity.js';
import { ChatDatabase } from './lib/db/database.js';
import { DATABASE_CLEANUP_INTERVAL } from './constants.js';
import type { ChatNode } from './types.js';

export interface P2PCore {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  usernameRegistry: UsernameRegistry;
  messageHandler: MessageHandler;
  cleanup: () => Promise<void>;
}

export interface P2PCoreConfig {
  dataDir: string;
  port: number;
  passwordPrompt: (prompt: string, isNew: boolean) => Promise<string>;
  onStatus?: (message: string, stage: 'database' | 'identity' | 'node' | 'registry' | 'messaging' | 'complete') => void;
}

/**
 * Initialize the P2P core (libp2p node, database, identity, messaging)
 * This is the main entry point for the Kiyeovo P2P functionality
 */
export async function initializeP2PCore(config: P2PCoreConfig): Promise<P2PCore> {
  const { onStatus } = config;
  const sendStatus = (message: string, stage: any) => {
    console.log(`[P2P Core] ${message}`);
    onStatus?.(message, stage);
  };

  sendStatus(`Starting Kiyeovo P2P node on port ${config.port}...`, 'database');

  // Initialize database
  const dbPath = path.join(config.dataDir, `chat-${config.port}.db`);
  const database = new ChatDatabase(dbPath);
  sendStatus(`Database initialized at: ${dbPath}`, 'database');

  // Load or create encrypted user identity
  sendStatus('Loading user identity...', 'identity');
  const userIdentity = await EncryptedUserIdentity.loadOrCreateEncrypted(
    database,
    config.passwordPrompt
  );
  sendStatus('User identity loaded', 'identity');

  // Create libp2p node
  sendStatus('Creating libp2p node...', 'node');
  const node = await createChatNode(config.port, userIdentity, database);
  sendStatus(`Peer started. Peer ID: ${node.peerId.toString()}`, 'node');

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
  await connectToBootstrap(node);

  // Initialize username registry
  sendStatus('Initializing username registry...', 'registry');
  const usernameRegistry = new UsernameRegistry(node, database);
  await usernameRegistry.initialize(userIdentity);

  // Initialize message handler
  sendStatus('Initializing message handler...', 'messaging');
  const messageHandler = new MessageHandler(node, usernameRegistry, database);

  // Check offline messages once at startup
  sendStatus('Checking for offline messages...', 'messaging');
  await messageHandler.checkOfflineMessages();

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
    cleanup: async () => {
      console.log('[P2P Core] Shutting down...');
      try {
        messageHandler.cleanup();
        clearInterval(cleanupInterval);
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
