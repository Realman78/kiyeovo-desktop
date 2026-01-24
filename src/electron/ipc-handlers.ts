import type { IpcMain } from 'electron';
import { IPC_CHANNELS, type P2PCore } from '../core/index.js';
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

  // Bootstrap node handlers
  setupBootstrapHandlers(ipcMain, getP2PCore);
}

/**
 * Username registration handlers
 */
function setupRegistrationHandlers(
  ipcMain: IpcMain,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.REGISTER_REQUEST, async (_event, username: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      console.log(`[IPC] Registering username: ${username}`);
      const success = await p2pCore.usernameRegistry.register(username);

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
