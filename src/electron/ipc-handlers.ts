import type { IpcMain, BrowserWindow } from 'electron';
import { app, dialog, Notification, shell } from 'electron';
import { IPC_CHANNELS, OFFLINE_CHECK_CACHE_TTL, PENDING_KEY_EXCHANGE_EXPIRATION, type P2PCore, type AppConfig } from '../core/index.js';
import { DOWNLOADS_DIR, getTorConfig, CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES, KEY_EXCHANGE_RATE_LIMIT_DEFAULT, OFFLINE_MESSAGE_LIMIT, MAX_FILE_SIZE, FILE_OFFER_RATE_LIMIT, MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL, SILENT_REJECTION_THRESHOLD_GLOBAL, SILENT_REJECTION_THRESHOLD_PER_PEER } from '../core/constants.js';
import { validateMessageLength, validateUsername } from '../core/utils/validators.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { OfflineMessageManager } from '../core/lib/offline-message-manager.js';
import { ProfileManager } from '../core/lib/profile-manager.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { homedir } from 'os';
import { basename, join } from 'path';
import { copyFile, stat } from 'fs/promises';

function requestAppRestart(): void {
  (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = true;
  app.quit();
}

/**
 * Setup all IPC handlers for communication between renderer and main process
 */
export function setupIPCHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null,
  getMainWindow: () => BrowserWindow | null
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

  // Trusted user import/export handlers
  setupTrustedUserHandlers(ipcMain, getP2PCore);

  // File dialog handlers
  setupFileDialogHandlers(ipcMain);

  // Chat handlers
  setupChatHandlers(ipcMain, getP2PCore);

  // Message handlers
  setupMessageHandlers(ipcMain, getP2PCore);

  // Pending key exchange handlers
  setupPendingKeyExchangeHandlers(ipcMain, getP2PCore);

  // Offline message handlers
  setupOfflineMessageHandlers(ipcMain, getP2PCore);

  // Notification handlers
  setupNotificationHandlers(ipcMain, getMainWindow);

  // Chat settings handlers
  setupChatSettingsHandlers(ipcMain, getP2PCore, getMainWindow);

  // File transfer handlers
  setupFileTransferHandlers(ipcMain, getP2PCore);

  // App handlers
  setupAppHandlers(ipcMain, getP2PCore);
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
        return { peerId: null, username: null, isRegistered: false };
      }

      const peerId = p2pCore.node.peerId.toString();
      const username = p2pCore.usernameRegistry.getCurrentUsername();
      return { 
        peerId,
        username: username || null, 
        isRegistered: !!username 
      };
    } catch (error) {
      console.error('[IPC] Failed to get user state:', error);
      return { peerId: null, username: null, isRegistered: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_LAST_USERNAME, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { username: null };
      }
      const peerId = p2pCore.node.peerId.toString();
      const username = p2pCore.database.getLastUsername(peerId);
      return { username: username ?? null };
    } catch (error) {
      console.error('[IPC] Failed to get last username:', error);
      return { username: null };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ATTEMPT_AUTO_REGISTER, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, username: null, error: 'P2P core not initialized' };
      }
      const username = await p2pCore.usernameRegistry.attemptAutoRegister();
      if (username) {
        return { success: true, username };
      }
      return { success: false, username: null };
    } catch (error) {
      console.error('[IPC] Failed to attempt auto-register:', error);
      return { success: false, username: null, error: error instanceof Error ? error.message : 'Failed to auto-register' };
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

      console.log(`[IPC] Sending message to ${identifier}: ${message}`);

      // Check if identifier is a valid peer ID or username
      let isPeerId = false;
      try {
        peerIdFromString(identifier);
        isPeerId = true;
        console.log(`[IPC] Identifier is a peer ID`);
      } catch {
        // Not a peer ID, check if it's a valid username
        if (!validateUsername(identifier)) {
          return { success: false, messageSentStatus: null, error: 'Invalid username or peer ID' };
        }
        console.log(`[IPC] Identifier is a username`);
      }

      if (!validateMessageLength(message)) {
        return { success: false, messageSentStatus: null, error: 'Message too long' };
      }

      console.log(`[IPC] Sending message to ${identifier}: ${message}`);

      const response = await p2pCore.messageHandler.sendMessage(identifier, message);
      console.log(`[IPC] Message sent response: ${JSON.stringify(response)}`);

      if (response.success) {
        return { success: true, messageSentStatus: response.messageSentStatus, error: null, message: response.message };
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
 * Trusted user import handlers
 */
function setupTrustedUserHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.IMPORT_TRUSTED_USER, async (_event, filePath: string, password: string, customName?: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Importing trusted user from: ${filePath}`);
      const myPeerId = p2pCore.userIdentity.id;

      const result = await ProfileManager.importTrustedUser(
        filePath,
        password,
        myPeerId,
        p2pCore.database,
        customName
      );

      if (result.success) {
        console.log(`[IPC] Successfully imported trusted user: ${result.username}`);
      } else {
        console.error(`[IPC] Failed to import trusted user: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error('[IPC] Failed to import trusted user:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import trusted user'
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_PROFILE, async (_event, password: string, sharedSecret: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      if (!username) {
        return { success: false, error: 'No username registered' };
      }

      const myPeerId = p2pCore.userIdentity.id;

      // Save to home directory as ${username}.kiyeovo
      const filename = join(homedir(), `${username}.kiyeovo`);

      console.log(`[IPC] Exporting profile to: ${filename}`);

      const result = await ProfileManager.exportProfileDesktop(
        p2pCore.userIdentity,
        username,
        myPeerId,
        filename,
        password,
        sharedSecret
      );

      if (result.success) {
        console.log(`[IPC] Successfully exported profile to: ${filename}`);
      } else {
        console.error(`[IPC] Failed to export profile: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error('[IPC] Failed to export profile:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export profile'
      };
    }
  });
}

/**
 * File dialog handlers
 */
function setupFileDialogHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.SHOW_OPEN_DIALOG, async (_event, options: {
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory'>;
  }) => {
    try {
      const result = await dialog.showOpenDialog({
        title: options.title || 'Open File',
        properties: options.properties || ['openFile'],
        filters: options.filters || []
      });

      return {
        filePath: result.filePaths[0] || null,
        canceled: result.canceled
      };
    } catch (error) {
      console.error('[IPC] Failed to show open dialog:', error);
      return { filePath: null, canceled: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_SAVE_DIALOG, async (_event, options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => {
    try {
      const dialogOptions: any = {
        title: options.title || 'Save File',
        filters: options.filters || []
      };

      if (options.defaultPath) {
        dialogOptions.defaultPath = options.defaultPath;
      }

      const result = await dialog.showSaveDialog(dialogOptions);

      return {
        filePath: result.filePath || null,
        canceled: result.canceled
      };
    } catch (error) {
      console.error('[IPC] Failed to show save dialog:', error);
      return { filePath: null, canceled: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_FILE_METADATA, async (_event, filePath: string) => {
    try {
      const stats = await stat(filePath);
      return {
        success: true,
        name: basename(filePath),
        size: stats.size,
        error: null
      };
    } catch (error) {
      console.error('[IPC] Failed to get file metadata:', error);
      return {
        success: false,
        name: null,
        size: null,
        error: error instanceof Error ? error.message : 'Failed to get file metadata'
      };
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

  ipcMain.handle(IPC_CHANNELS.GET_CHAT, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, chat: null, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Fetching chat by ID: ${chatId}`);
      const myPeerId = p2pCore.userIdentity.id;
      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, myPeerId);

      if (!chat) {
        return { success: false, chat: null, error: 'Chat not found' };
      }

      console.log(`[IPC] Found chat: ${chat.name}`);
      return { success: true, chat, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get chat:', error);
      return { success: false, chat: null, error: error instanceof Error ? error.message : 'Failed to get chat' };
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
      const cancelled = await p2pCore.messageHandler.getKeyExchange().cancelPendingKeyExchange(peerId);

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

/**
 * Generate cache key from chat IDs (sorted for consistency)
 */
function getOfflineCheckCacheKey(chatIds?: number[]): string {
  if (!chatIds || chatIds.length === 0) {
    return '__TOP_10__'; // Sentinel value for "check top 10"
  }
  return chatIds.slice().sort((a, b) => a - b).join(',');
}

/**
 * Clear expired entries from cache
 */
function cleanupOfflineCheckCache(): void {
  const now = Date.now();
  for (const [key, entry] of OfflineMessageManager.offlineCheckCache.entries()) {
    if (now - entry.timestamp > OFFLINE_CHECK_CACHE_TTL) {
      OfflineMessageManager.offlineCheckCache.delete(key);
    }
  }
}

/**
 * Offline message handlers
 */
function setupOfflineMessageHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  // Check offline messages for specific chats (or top 10 if no IDs provided)
  ipcMain.handle(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES, async (_event, chatIds?: number[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], error: 'P2P core not initialized' };
      }

      const cacheKey = getOfflineCheckCacheKey(chatIds);

      // Check if there's already an in-flight request for this key
      const inFlightPromise = OfflineMessageManager.inFlightOfflineChecks.get(cacheKey);
      if (inFlightPromise) {
        console.log('[IPC] Request already in-flight, sharing promise');
        return await inFlightPromise;
      }

      // Check cache
      const cached = OfflineMessageManager.offlineCheckCache.get(cacheKey);
      const now = Date.now();

      if (cached && (now - cached.timestamp < OFFLINE_CHECK_CACHE_TTL)) {
        console.log(`[IPC] Returning cached offline check result (${Math.round((now - cached.timestamp) / 1000)}s old)`);
        return cached.result;
      }

      // Create and store the promise for this check
      const checkPromise = (async () => {
        try {
          const logMsg = chatIds
            ? `Checking offline messages for ${chatIds.length} specific chats...`
            : 'Checking offline messages for top 10 recent chats...';
          console.log(`[IPC] ${logMsg}`);

          const {checkedChatIds, unreadFromChats} = await p2pCore.messageHandler.checkOfflineMessages(chatIds);
          console.log(`[IPC] Offline message check complete - checked ${checkedChatIds.length} chats`);
          console.log(unreadFromChats)

          const result = { success: true, checkedChatIds, unreadFromChats, error: null };

          // Cache the result
          OfflineMessageManager.offlineCheckCache.set(cacheKey, {
            timestamp: Date.now(),
            result
          });

          // Cleanup expired cache entries
          cleanupOfflineCheckCache();

          return result;
        } finally {
          // Always clean up the in-flight promise when done
          OfflineMessageManager.inFlightOfflineChecks.delete(cacheKey);
        }
      })();

      // Store the promise before awaiting
      OfflineMessageManager.inFlightOfflineChecks.set(cacheKey, checkPromise);

      return await checkPromise;
    } catch (error) {
      console.error('[IPC] Failed to check offline messages:', error);
      return { success: false, checkedChatIds: [], unreadFromChats: new Map(), error: error instanceof Error ? error.message : 'Failed to check offline messages' };
    }
  });

  // Check offline messages for a specific chat
  ipcMain.handle(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES_FOR_CHAT, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], error: 'P2P core not initialized' };
      }

      const cacheKey = getOfflineCheckCacheKey([chatId]);

      // Check if there's already an in-flight request for this key
      const inFlightPromise = OfflineMessageManager.inFlightOfflineChecks.get(cacheKey);
      if (inFlightPromise) {
        console.log(`[IPC] Request already in-flight for chat ${chatId}, sharing promise`);
        return await inFlightPromise;
      }

      // Check cache
      const cached = OfflineMessageManager.offlineCheckCache.get(cacheKey);
      const now = Date.now();

      if (cached && (now - cached.timestamp < OFFLINE_CHECK_CACHE_TTL)) {
        console.log(`[IPC] Returning cached offline check result for chat ${chatId} (${Math.round((now - cached.timestamp) / 1000)}s old)`);
        return cached.result;
      }

      // Create and store the promise for this check
      const checkPromise = (async () => {
        try {
          console.log(`[IPC] Checking offline messages for chat: ${chatId}`);
          const {checkedChatIds, unreadFromChats} = await p2pCore.messageHandler.checkOfflineMessages([chatId]);
          console.log(`[IPC] Offline message check complete for chat: ${chatId}`);

          const result = { success: true, checkedChatIds, unreadFromChats, error: null };

          // Cache the result
          OfflineMessageManager.offlineCheckCache.set(cacheKey, {
            timestamp: Date.now(),
            result
          });

          // Cleanup expired cache entries
          cleanupOfflineCheckCache();

          return result;
        } finally {
          // Always clean up the in-flight promise when done
          OfflineMessageManager.inFlightOfflineChecks.delete(cacheKey);
        }
      })();

      // Store the promise before awaiting
      OfflineMessageManager.inFlightOfflineChecks.set(cacheKey, checkPromise);

      return await checkPromise;
    } catch (error) {
      console.error(`[IPC] Failed to check offline messages for chat ${chatId}:`, error);
      return { success: false, checkedChatIds: [], unreadFromChats: new Map(), error: error instanceof Error ? error.message : 'Failed to check offline messages' };
    }
  });
}
/**
 * Notification handlers
 */
function setupNotificationHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  // Show desktop notification
  ipcMain.handle(IPC_CHANNELS.SHOW_NOTIFICATION, async (_event, options: {
    title: string;
    body: string;
    chatId?: number;
  }) => {
    try {
      const notification = new Notification({
        title: options.title,
        body: options.body,
      });

      // Handle notification click - focus window and navigate to chat
      notification.on('click', () => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          mainWindow.focus();

          // Send chat ID to renderer so it can navigate
          if (options.chatId) {
            mainWindow.webContents.send('notification:clicked', options.chatId);
          }
        }
      });

      notification.show();
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to show notification:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to show notification' };
    }
  });

  // Check if window is focused
  ipcMain.handle(IPC_CHANNELS.IS_WINDOW_FOCUSED, async () => {
    const mainWindow = getMainWindow();
    return { focused: mainWindow?.isFocused() ?? false };
  });

  // Focus window
  ipcMain.handle(IPC_CHANNELS.FOCUS_WINDOW, async () => {
    try {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to focus window:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to focus window' };
    }
  });
}

/**
 * Chat settings handlers
 */
function setupChatSettingsHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC_CHANNELS.TOGGLE_CHAT_MUTE, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, muted: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Toggling mute for chat: ${chatId}`);
      const muted = p2pCore.database.toggleChatMute(chatId);
      console.log(`[IPC] Chat ${chatId} muted status: ${muted}`);

      return { success: true, muted, error: null };
    } catch (error) {
      console.error('[IPC] Failed to toggle chat mute:', error);
      return { success: false, muted: false, error: error instanceof Error ? error.message : 'Failed to toggle mute' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BLOCK_USER, async (_event, peerId: string, username: string | null, reason: string | null) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Blocking user: ${peerId}`);
      p2pCore.database.blockPeer(peerId, username, reason);
      console.log(`[IPC] User ${peerId} blocked`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to block user:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to block user' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UNBLOCK_USER, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Unblocking user: ${peerId}`);
      p2pCore.database.unblockPeer(peerId);
      console.log(`[IPC] User ${peerId} unblocked`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to unblock user:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to unblock user' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.IS_USER_BLOCKED, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, blocked: false, error: 'P2P core not initialized' };
      }

      const blocked = p2pCore.database.isBlocked(peerId);
      return { success: true, blocked, error: null };
    } catch (error) {
      console.error('[IPC] Failed to check if user is blocked:', error);
      return { success: false, blocked: false, error: error instanceof Error ? error.message : 'Failed to check blocked status' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_USER_INFO, async (_event, peerId: string, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const user = p2pCore.database.getUserByPeerId(peerId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, p2pCore.userIdentity.id);
      const messageCount = p2pCore.database.getMessageCount(chatId);
      const blockedPeers = p2pCore.database.getBlockedPeers();
      const blockedInfo = blockedPeers.find(bp => bp.peer_id === peerId);

      return {
        success: true,
        userInfo: {
          username: user.username,
          peerId: user.peer_id,
          userSince: user.created_at,
          chatCreated: chat?.created_at,
          trustedOutOfBand: chat?.trusted_out_of_band || false,
          messageCount,
          muted: chat?.muted || false,
          blocked: !!blockedInfo,
          blockedAt: blockedInfo?.blocked_at,
          blockReason: blockedInfo?.reason,
        },
        error: null
      };
    } catch (error) {
      console.error('[IPC] Failed to get user info:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get user info' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_ALL_MESSAGES, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Deleting all messages for chat ${chatId}`);
      p2pCore.database.deleteAllMessagesForChat(chatId);
      console.log(`[IPC] All messages deleted for chat ${chatId}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete all messages:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete messages' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_CHAT_AND_USER, async (_event, chatId: number, userPeerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Deleting chat ${chatId} and user ${userPeerId}`);
      p2pCore.database.deleteChatAndUser(chatId, userPeerId);
      try {
        p2pCore.messageHandler.getKeyExchange().deletePendingAcceptanceByPeerId(userPeerId);
        p2pCore.messageHandler.getSessionManager().clearSession(userPeerId);
        p2pCore.messageHandler.getSessionManager().removePendingKeyExchange(userPeerId);
      } catch (err) {
        console.error('[IPC] Failed to delete in memory data:', err);
      }
      console.log(`[IPC] Chat ${chatId} and user ${userPeerId} deleted`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete chat and user:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete chat and user' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_USERNAME, async (_event, peerId: string, newUsername: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Updating username for ${peerId} to ${newUsername}`);
      p2pCore.database.updateUsername(peerId, newUsername);
      console.log(`[IPC] Username updated for ${peerId} to ${newUsername}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete all messages:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete messages' };
    }
  });

  // App-level settings
  ipcMain.handle(IPC_CHANNELS.GET_NOTIFICATIONS_ENABLED, async (_event) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, enabled: true, error: 'P2P core not initialized' };
      }

      const value = p2pCore.database.getSetting('notifications_enabled');
      // Default to true if not set
      const enabled = value === null ? true : value === 'true';
      console.log(`[IPC] Get notifications enabled: ${enabled}`);

      return { success: true, enabled, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get notifications enabled:', error);
      return { success: false, enabled: true, error: error instanceof Error ? error.message : 'Failed to get setting' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_NOTIFICATIONS_ENABLED, async (_event, enabled: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Setting notifications enabled: ${enabled}`);
      p2pCore.database.setSetting('notifications_enabled', enabled.toString());
      console.log(`[IPC] Notifications enabled set to: ${enabled}`);

      // Notify all renderer processes about the change
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATIONS_ENABLED_CHANGED, enabled);
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set notifications enabled:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set setting' };
    }
  });

  // Downloads directory settings
  ipcMain.handle(IPC_CHANNELS.GET_DOWNLOADS_DIR, async (_event) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, path: null, error: 'P2P core not initialized' };
      }

      const path = p2pCore.database.getSetting('downloads_directory');
      const downloadsPath = path || DOWNLOADS_DIR;

      console.log(`[IPC] Get downloads directory: ${downloadsPath}`);
      return { success: true, path: downloadsPath, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get downloads directory:', error);
      return { success: false, path: null, error: error instanceof Error ? error.message : 'Failed to get setting' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_DOWNLOADS_DIR, async (_event, path: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Setting downloads directory: ${path}`);
      p2pCore.database.setSetting('downloads_directory', path);
      console.log(`[IPC] Downloads directory set to: ${path}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set downloads directory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set setting' };
    }
  });

  // Tor settings
  ipcMain.handle(IPC_CHANNELS.GET_TOR_SETTINGS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, settings: null, error: 'P2P core not initialized' };
      }

      const db = p2pCore.database;
      const get = (key: string) => db.getSetting(key);
      const base = getTorConfig();

      const enabled = get('tor_enabled');
      const socksHost = get('tor_socks_host');
      const socksPort = get('tor_socks_port');
      const connectionTimeout = get('tor_connection_timeout');
      const circuitTimeout = get('tor_circuit_timeout');
      const maxRetries = get('tor_max_retries');
      const healthCheckInterval = get('tor_health_check_interval');
      const dnsResolution = get('tor_dns_resolution');

      const settings = {
        enabled: enabled ?? String(base.enabled),
        socksHost: socksHost ?? base.socksHost,
        socksPort: socksPort ?? String(base.socksPort),
        connectionTimeout: connectionTimeout ?? String(base.connectionTimeout),
        circuitTimeout: circuitTimeout ?? String(base.circuitTimeout),
        maxRetries: maxRetries ?? String(base.maxRetries),
        healthCheckInterval: healthCheckInterval ?? String(base.healthCheckInterval),
        dnsResolution: dnsResolution ?? base.dnsResolution
      };

      return { success: true, settings, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get Tor settings:', error);
      return { success: false, settings: null, error: error instanceof Error ? error.message : 'Failed to get Tor settings' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_TOR_SETTINGS, async (_event, settings: {
    enabled: boolean;
    socksHost: string;
    socksPort: number;
    connectionTimeout: number;
    circuitTimeout: number;
    maxRetries: number;
    healthCheckInterval: number;
    dnsResolution: 'tor' | 'system';
  }) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const db = p2pCore.database;
      db.setSetting('tor_enabled', String(settings.enabled));
      db.setSetting('tor_socks_host', settings.socksHost);
      db.setSetting('tor_socks_port', String(settings.socksPort));
      db.setSetting('tor_connection_timeout', String(settings.connectionTimeout));
      db.setSetting('tor_circuit_timeout', String(settings.circuitTimeout));
      db.setSetting('tor_max_retries', String(settings.maxRetries));
      db.setSetting('tor_health_check_interval', String(settings.healthCheckInterval));
      db.setSetting('tor_dns_resolution', settings.dnsResolution);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set Tor settings:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set Tor settings' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_APP_CONFIG, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, config: null, error: 'P2P core not initialized' };
      }

      const db = p2pCore.database;
      const get = (key: string, defaultValue: string) => db.getSetting(key) ?? defaultValue;

      const config = {
        chatsToCheckForOfflineMessages: parseInt(get('chats_to_check_for_offline_messages', String(CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES)), 10),
        keyExchangeRateLimit: parseInt(get('key_exchange_rate_limit', String(KEY_EXCHANGE_RATE_LIMIT_DEFAULT)), 10),
        offlineMessageLimit: parseInt(get('offline_message_limit', String(OFFLINE_MESSAGE_LIMIT)), 10),
        maxFileSize: parseInt(get('max_file_size', String(MAX_FILE_SIZE)), 10),
        fileOfferRateLimit: parseInt(get('file_offer_rate_limit', String(FILE_OFFER_RATE_LIMIT)), 10),
        maxPendingFilesPerPeer: parseInt(get('max_pending_files_per_peer', String(MAX_PENDING_FILES_PER_PEER)), 10),
        maxPendingFilesTotal: parseInt(get('max_pending_files_total', String(MAX_PENDING_FILES_TOTAL)), 10),
        silentRejectionThresholdGlobal: parseInt(get('silent_rejection_threshold_global', String(SILENT_REJECTION_THRESHOLD_GLOBAL)), 10),
        silentRejectionThresholdPerPeer: parseInt(get('silent_rejection_threshold_per_peer', String(SILENT_REJECTION_THRESHOLD_PER_PEER)), 10),
      };

      return { success: true, config, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get app config:', error);
      return { success: false, config: null, error: error instanceof Error ? error.message : 'Failed to get app config' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_APP_CONFIG, async (_event, config: AppConfig) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      // Validate and clamp values to sane ranges
      const validated = {
        chatsToCheckForOfflineMessages: Math.max(1, Math.min(50, config.chatsToCheckForOfflineMessages)),
        keyExchangeRateLimit: Math.max(1, Math.min(100, config.keyExchangeRateLimit)),
        offlineMessageLimit: Math.max(10, Math.min(500, config.offlineMessageLimit)),
        maxFileSize: Math.max(1 * 1024 * 1024, Math.min(512 * 1024 * 1024, config.maxFileSize)),
        fileOfferRateLimit: Math.max(1, Math.min(20, config.fileOfferRateLimit)),
        maxPendingFilesPerPeer: Math.max(1, Math.min(20, config.maxPendingFilesPerPeer)),
        maxPendingFilesTotal: Math.max(1, Math.min(50, config.maxPendingFilesTotal)),
        silentRejectionThresholdGlobal: Math.max(1, Math.min(100, config.silentRejectionThresholdGlobal)),
        silentRejectionThresholdPerPeer: Math.max(1, Math.min(50, config.silentRejectionThresholdPerPeer)),
      };

      const db = p2pCore.database;
      db.setSetting('chats_to_check_for_offline_messages', String(validated.chatsToCheckForOfflineMessages));
      db.setSetting('key_exchange_rate_limit', String(validated.keyExchangeRateLimit));
      db.setSetting('offline_message_limit', String(validated.offlineMessageLimit));
      db.setSetting('max_file_size', String(validated.maxFileSize));
      db.setSetting('file_offer_rate_limit', String(validated.fileOfferRateLimit));
      db.setSetting('max_pending_files_per_peer', String(validated.maxPendingFilesPerPeer));
      db.setSetting('max_pending_files_total', String(validated.maxPendingFilesTotal));
      db.setSetting('silent_rejection_threshold_global', String(validated.silentRejectionThresholdGlobal));
      db.setSetting('silent_rejection_threshold_per_peer', String(validated.silentRejectionThresholdPerPeer));

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set app config:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set app config' };
    }
  });
}

function setupAppHandlers(ipcMain: IpcMain, getP2PCore: () => P2PCore | null): void {
  ipcMain.handle(IPC_CHANNELS.RESTART_APP, async () => {
    try {
      requestAppRestart();
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restart app:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to restart app' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_ACCOUNT_AND_DATA, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log('[IPC] Deleting all account data...');

      await p2pCore.database.wipeDatabase();

      console.log('[IPC] Database wiped. Restarting app...');

      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete account:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete account' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BACKUP_DATABASE, async (_event, backupPath: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Backing up database to: ${backupPath}`);
      await p2pCore.database.backup(backupPath);
      console.log('[IPC] Database backup completed');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to backup database:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to backup database' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RESTORE_DATABASE, async (_event, backupPath: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Restoring database from: ${backupPath}`);

      // Close current database connection
      p2pCore.database.close();

      // Restore the database
      await p2pCore.database.restore(backupPath);

      console.log('[IPC] Database restored. Restarting app...');

      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restore database:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to restore database' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RESTORE_DATABASE_FROM_FILE, async (_event, backupPath: string) => {
    try {
      const dataDir = ensureAppDataDir();
      const dbPath = join(dataDir, 'chat.db');

      console.log(`[IPC] Restoring database (no core) from: ${backupPath} -> ${dbPath}`);

      // Clean up any existing database and WAL files first
      const fs = await import('fs/promises');
      try {
        await fs.unlink(dbPath);
        console.log('[IPC] Removed existing chat.db');
      } catch (e) {
        // File doesn't exist, that's ok
      }
      try {
        await fs.unlink(`${dbPath}-wal`);
        console.log('[IPC] Removed existing chat.db-wal');
      } catch (e) {
        // File doesn't exist, that's ok
      }
      try {
        await fs.unlink(`${dbPath}-shm`);
        console.log('[IPC] Removed existing chat.db-shm');
      } catch (e) {
        // File doesn't exist, that's ok
      }

      // Copy the backup file
      await copyFile(backupPath, dbPath);
      console.log('[IPC] Database file copied successfully');

      // Verify the file exists
      await stat(dbPath);
      console.log('[IPC] Database file verified');

      console.log('[IPC] Database restored. Restarting app...');
      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restore database from file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to restore database from file' };
    }
  });
}

/**
 * File transfer handlers
 */
function setupFileTransferHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  // Send file
  ipcMain.handle(IPC_CHANNELS.SEND_FILE_REQUEST, async (_event, peerId: string, filePath: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Sending file ${filePath} to ${peerId}`);

      // Get username from peerId
      const user = p2pCore.database.getUserByPeerId(peerId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Send the file (this will emit progress events internally)
      await p2pCore.messageHandler.getFileHandler().sendFile(user.username, filePath);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to send file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send file' };
    }
  });

  // Accept file
  ipcMain.handle(IPC_CHANNELS.ACCEPT_FILE, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Accepting file: ${fileId}`);
      p2pCore.messageHandler.getFileHandler().acceptPendingFile(fileId);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to accept file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to accept file' };
    }
  });

  // Reject file
  ipcMain.handle(IPC_CHANNELS.REJECT_FILE, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Rejecting file: ${fileId}`);
      p2pCore.messageHandler.getFileHandler().rejectPendingFile(fileId);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reject file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reject file' };
    }
  });

  // Get pending files
  ipcMain.handle(IPC_CHANNELS.GET_PENDING_FILES, async (_event) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, files: [], error: 'P2P core not initialized' };
      }

      const files = p2pCore.messageHandler.getFileHandler().getPendingFiles();
      console.log(`[IPC] Get pending files: ${files.length} files`);

      return { success: true, files, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get pending files:', error);
      return { success: false, files: [], error: error instanceof Error ? error.message : 'Failed to get pending files' };
    }
  });

  // Open file location
  ipcMain.handle(IPC_CHANNELS.OPEN_FILE_LOCATION, async (_event, filePath: string) => {
    try {
      console.log(`[IPC] Opening file location: ${filePath}`);
      shell.showItemInFolder(filePath);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to open file location:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open file location' };
    }
  });
}
