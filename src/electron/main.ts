import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDev } from './util.js';
import { initializeP2PCore, InitStatus, IPC_CHANNELS, KeyExchangeEvent, type P2PCore, type ContactRequestEvent, type ChatCreatedEvent, type KeyExchangeFailedEvent, type MessageReceivedEvent } from '../core/index.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { requestPasswordFromUI } from './password-prompt.js';
import { setupIPCHandlers } from './ipc-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let p2pCore: P2PCore | null = null;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Need to disable sandbox for IPC to work properly
    }
  });

  // Load UI
  if (isDev()) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools(); // Auto-open DevTools in development
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist-ui', 'index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function sendInitStatus(message: string, stage: InitStatus['stage']) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.INIT_STATUS, { message, stage });
  }
}

function sendDHTConnectionStatus(status: { connected: boolean }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Sending DHT connection status: ${status.connected}`);
    mainWindow.webContents.send(IPC_CHANNELS.DHT_CONNECTION_STATUS, status);
  }
}

function sendKeyExchangeSent(data: KeyExchangeEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Key exchange sent to ${data.username}`);
    mainWindow.webContents.send(IPC_CHANNELS.KEY_EXCHANGE_SENT, data);
  }
}

function sendContactRequestReceived(data: ContactRequestEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Contact request received from ${data.username}`);
    mainWindow.webContents.send(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, data);
  }
}

function sendBootstrapNodes(nodes: string[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Sending bootstrap nodes: ${nodes}`);
    mainWindow.webContents.send(IPC_CHANNELS.BOOTSTRAP_NODES, nodes);
  }
}

function sendChatCreated(data: ChatCreatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Chat created for ${data.username} (chatId: ${data.chatId})`);
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_CREATED, data);
  }
}

function sendKeyExchangeFailed(data: KeyExchangeFailedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Key exchange failed with ${data.username}: ${data.error}`);
    mainWindow.webContents.send(IPC_CHANNELS.KEY_EXCHANGE_FAILED, data);
  }
}

function sendMessageReceived(data: MessageReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Message received in chat ${data.chatId} from ${data.senderUsername}`);
    mainWindow.webContents.send(IPC_CHANNELS.MESSAGE_RECEIVED, data);
  }
}

async function initializeP2PAfterWindow() {
  try {
    if (!mainWindow) {
      throw new Error('Main window not created');
    }

    console.log('[Electron] Starting P2P initialization...');
    sendInitStatus('Getting data directory...', 'database');

    const dataDir = ensureAppDataDir();
    console.log(`[Electron] Data directory: ${dataDir}`);

    sendInitStatus('Initializing P2P core...', 'node');

    // Initialize P2P core with custom password prompt
    p2pCore = await initializeP2PCore({
      dataDir,
      port: 9001, // TODO: Make this configurable
      passwordPrompt: async (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => {
        console.log('[Electron] Requesting password from UI...');
        const response = await requestPasswordFromUI(mainWindow!, prompt, isNew, recoveryPhrase, prefilledPassword, errorMessage, cooldownSeconds, showRecoveryOption, keychainAvailable);
        return response;
      },
      onStatus: (message: string, stage: InitStatus['stage']) => {
        console.log(`[P2P Core] ${message}`);
        sendInitStatus(message, stage);
      },
      onDHTConnectionStatus: (status: { connected: boolean }) => {
        console.log(`[Electron] DHT connection status: ${status.connected}`);
        sendDHTConnectionStatus(status);
      },
      onKeyExchangeSent: (data: KeyExchangeEvent) => {
        sendKeyExchangeSent(data);
      },
      onContactRequestReceived: (data: ContactRequestEvent) => {
        sendContactRequestReceived(data);
      },
      onBootstrapNodes: (nodes: string[]) => {
        sendBootstrapNodes(nodes);
      },
      onChatCreated: (data: ChatCreatedEvent) => {
        sendChatCreated(data);
      },
      onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => {
        sendKeyExchangeFailed(data);
      },
      onMessageReceived: (data: MessageReceivedEvent) => {
        sendMessageReceived(data);
      }
    });

    console.log('[Electron] P2P core initialized successfully');
    sendInitStatus('P2P node ready!', 'complete');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_COMPLETE);
    }

  } catch (error) {
    console.error('[Electron] Failed to initialize P2P core:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_ERROR, errorMessage);
    }
  }
}

async function initializeApp() {
  try {
    console.log('[Electron] Starting Kiyeovo Desktop...');

    // Setup IPC handlers
    setupIPCHandlers(ipcMain, () => p2pCore);
    console.log('[Electron] IPC handlers registered');

    // Create window first
    mainWindow = createMainWindow();
    console.log('[Electron] Main window created');

    // Wait for the window to be ready
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[Electron] Window loaded, starting P2P initialization...');
      // Start P2P initialization after window is ready
      void initializeP2PAfterWindow();
    });

  } catch (error) {
    console.error('[Electron] Failed to initialize application:', error);
    app.quit();
  }
}

app.whenReady().then(async () => {
  await initializeApp();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Handle app activation (macOS)
app.on('activate', () => {
  if (mainWindow === null && p2pCore !== null) {
    void createMainWindow();
  }
});

// Graceful shutdown
app.on('before-quit', async (event) => {
  if (p2pCore) {
    event.preventDefault();
    console.log('[Electron] Shutting down P2P core...');
    try {
      await p2pCore.cleanup();
      console.log('[Electron] P2P core shutdown complete');
    } catch (error) {
      console.error('[Electron] Error during P2P shutdown:', error);
    } finally {
      p2pCore = null;
      app.exit(0);
    }
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('[Electron] Unhandled Rejection at:', promise, 'reason:', reason);
});