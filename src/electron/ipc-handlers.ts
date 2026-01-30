import type { IpcMain } from 'electron';
import { IPC_CHANNELS, PENDING_KEY_EXCHANGE_EXPIRATION, type P2PCore } from '../core/index.js';
import { validateMessageLength, validateUsername } from '../core/utils/validators.js';

/**
 * Setup all IPC handlers for communication between renderer and main process
 */
export function setupIPCHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  // Registration handlers
  setupRegistrationHandlers(ipcMain, getP2PCore);

  // Messaging handlers
  setupMessagingHandlers(ipcMain, getP2PCore);

  // Contact request handlers
  setupContactRequestHandlers(ipcMain, getP2PCore);

  // Bootstrap node handlers
  setupBootstrapHandlers(ipcMain, getP2PCore);

  // Contact attempt handlers
  setupContactAttemptHandlers(ipcMain, getP2PCore);

  // Chat handlers
  setupChatHandlers(ipcMain, getP2PCore);

  // Message handlers
  setupMessageHandlers(ipcMain, getP2PCore);

  // Pending key exchange handlers
  setupPendingKeyExchangeHandlers(ipcMain, getP2PCore);
}

/**
 * Username registration handlers
 */
function setupRegistrationHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.REGISTER_REQUEST, async (_event, username: string, rememberMe: boolean) => {
    try {
      console.log(`[IPC] Registering username: ${username} with rememberMe: ${rememberMe}`);
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Registering username: ${username}`);
      const success = await p2pCore.usernameRegistry.register(username, false, rememberMe);

      if (success) {
        console.log(`[IPC] Successfully registered username: ${username}`);
        return { success: true };
      } else {
        return { success: false, error: 'Failed to register username. Network may be unreachable.' };
      }
    } catch (error) {
      console.error('[IPC] Registration failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  });

  // Get current user state (username, registration status)
  ipcMain.handle(IPC_CHANNELS.GET_USER_STATE, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { username: null, isRegistered: false };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      return { 
        username: username || null, 
        isRegistered: !!username 
      };
    } catch (error) {
      console.error('[IPC] Failed to get user state:', error);
      return { username: null, isRegistered: false };
    }
  });

  // Unregister
  ipcMain.handle(IPC_CHANNELS.UNREGISTER_REQUEST, async (_event, username: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { usernameUnregistered: false, peerIdUnregistered: false };
      }

      const result = await p2pCore.usernameRegistry.unregister(username);
      return result;
    } catch (error) {
      console.error('[IPC] Failed to unregister:', error);
      return { usernameUnregistered: false, peerIdUnregistered: false };
    }
  });
  // Get auto-register setting
  ipcMain.handle(IPC_CHANNELS.GET_AUTO_REGISTER, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { autoRegister: false };
      }

      const setting = p2pCore.database.getSetting('auto_register');
      return { autoRegister: setting === 'true' };
    } catch (error) {
      console.error('[IPC] Failed to get auto-register setting:', error);
      return { autoRegister: false };
    }
  });

  // Set auto-register setting
  ipcMain.handle(IPC_CHANNELS.SET_AUTO_REGISTER, async (_event, enabled: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      p2pCore.database.setSetting('auto_register', enabled ? 'true' : 'never');
      console.log(`[IPC] Auto-register setting updated to: ${enabled}`);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set auto-register:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set auto-register' };
    }
  });
}

/**
 * Message sending handlers
 */
function setupMessagingHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE_REQUEST, async (_event, identifier: string, message: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, messageSentStatus: null, error: 'P2P core not initialized' };
      }

      if (!validateUsername(identifier)) {
        return { success: false, messageSentStatus: null, error: 'Invalid username' };
      }

      if (!validateMessageLength(message)) {
        return { success: false, messageSentStatus: null, error: 'Message too long' };
      }

      console.log(`[IPC] Sending message to ${identifier}: ${message}`);

      const response = await p2pCore.messageHandler.sendMessage(identifier, message);

      if (response.success) {
        return { success: true, messageSentStatus: response.messageSentStatus, error: null };
      }
      return { success: false, messageSentStatus: null, error: response.error ?? 'Failed to send message' };
    } catch (error) {
      console.error('[IPC] Failed to send message:', error);
      return { success: false, messageSentStatus: null, error: error instanceof Error ? error.message : "Failed to send message" };
    }
  });
}

/**
 * Contact request handlers
 */
function setupContactRequestHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  // Accept contact request
  ipcMain.handle(IPC_CHANNELS.ACCEPT_CONTACT_REQUEST, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Accepting contact request from peer: ${peerId}`);
      p2pCore.messageHandler.getKeyExchange().acceptPendingContact(peerId);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to accept contact request:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to accept contact request' };
    }
  });

  // Reject contact request
  ipcMain.handle(IPC_CHANNELS.REJECT_CONTACT_REQUEST, async (_event, peerId: string, block: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Rejecting contact request from peer: ${peerId}`);
      const pending = p2pCore.messageHandler.getKeyExchange().getPendingAcceptanceByPeerId(peerId);

      if (!pending) {
        console.log(`No pending contact request from ${peerId}`);
        return { success: false, error: 'No pending contact request found' };
      }

      p2pCore.messageHandler.getKeyExchange().rejectPendingContact(peerId);
      p2pCore.messageHandler.getKeyExchange().deletePendingAcceptanceByPeerId(peerId);

      if (block) {
        p2pCore.database.blockPeer(peerId, pending.username, 'Rejected contact request');
        console.log(`Rejected and blocked ${pending.username}`);
      } else {
        console.log(`Rejected contact request from ${pending.username}`);
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reject contact request:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reject contact request' };
    }
  });
}

/**
 * Bootstrap node management handlers
 */
function setupBootstrapHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  // Get bootstrap nodes from database
  ipcMain.handle(IPC_CHANNELS.GET_BOOTSTRAP_NODES, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, nodes: [], error: 'P2P core not initialized' };
      }

      console.log('[IPC] Fetching bootstrap nodes from database...');
      const nodes = p2pCore.database.getBootstrapNodes();
      console.log(`[IPC] Found ${nodes.length} bootstrap nodes`);

      return { success: true, nodes, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get bootstrap nodes:', error);
      return { success: false, nodes: [], error: error instanceof Error ? error.message : 'Failed to get bootstrap nodes' };
    }
  });

  // Retry bootstrap connection
  ipcMain.handle(IPC_CHANNELS.RETRY_BOOTSTRAP, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log('[IPC] Retrying bootstrap connection...');
      await p2pCore.retryBootstrap();
      console.log('[IPC] Bootstrap retry complete');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to retry bootstrap:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to retry bootstrap connection' };
    }
  });

  // Add bootstrap node
  ipcMain.handle(IPC_CHANNELS.ADD_BOOTSTRAP_NODE, async (_event, address: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Adding bootstrap node: ${address}`);
      p2pCore.database.addBootstrapNode(address);
      console.log('[IPC] Bootstrap node added');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to add bootstrap node:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add bootstrap node' };
    }
  });

  // Remove bootstrap node
  ipcMain.handle(IPC_CHANNELS.REMOVE_BOOTSTRAP_NODE, async (_event, address: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Removing bootstrap node: ${address}`);
      p2pCore.database.removeBootstrapNode(address);
      console.log('[IPC] Bootstrap node removed');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to remove bootstrap node:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove bootstrap node' };
    }
  });
}

// Contact attempt handlers
function setupContactAttemptHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_CONTACT_ATTEMPTS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, contactAttempts: [], error: 'P2P core not initialized' };
      }

      console.log('[IPC] Fetching contact attempts from database...');
      const pendingAcceptances = p2pCore.messageHandler.getKeyExchange().getPendingAcceptances();

      const contactAttempts = pendingAcceptances.map(attempt => ({
        peerId: attempt.peerId,
        username: attempt.username,
        message: "Contact request",
        messageBody: attempt.messageBody,
        receivedAt: attempt.timestamp,
        expiresAt: attempt.timestamp + PENDING_KEY_EXCHANGE_EXPIRATION
      }));

      console.log(`[IPC] Found ${contactAttempts.length} contact attempts`);

      return { success: true, contactAttempts, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get contact attempts:', error);
      return { success: false, contactAttempts: [], error: error instanceof Error ? error.message : 'Failed to get contact attempts' };
    }
  });
}

/**
 * Chat handlers
 */
function setupChatHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_CHATS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, chats: [], error: 'P2P core not initialized' };
      }

      console.log('[IPC] Fetching chats from database...');
      const myPeerId = p2pCore.userIdentity.id;
      const chats = p2pCore.database.getAllChatsWithUsernameAndLastMsg(myPeerId);
      console.log(`[IPC] Found ${chats.length} chats`);

      return { success: true, chats, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get chats:', error);
      return { success: false, chats: [], error: error instanceof Error ? error.message : 'Failed to get chats' };
    }
  });
}

/**
 * Message handlers
 */
function setupMessageHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_MESSAGES, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, messages: [], error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Fetching messages for chat: ${chatId}`);
      const messages = p2pCore.database.getMessagesByChatId(chatId);
      console.log(`[IPC] Found ${messages.length} messages`);

      return { success: true, messages, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get messages:', error);
      return { success: false, messages: [], error: error instanceof Error ? error.message : 'Failed to get messages' };
    }
  });
}

/**
 * Pending key exchange handlers
 */
function setupPendingKeyExchangeHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.CANCEL_PENDING_KEY_EXCHANGE, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Cancelling pending key exchange for peer: ${peerId}`);
      const cancelled = p2pCore.messageHandler.getKeyExchange().cancelPendingKeyExchange(peerId);
      
      if (!cancelled) {
        return { success: false, error: 'No pending key exchange found' };
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to cancel pending key exchange:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to cancel pending key exchange' };
    }
  });
}