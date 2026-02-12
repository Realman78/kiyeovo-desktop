import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { isDev } from './util.js';
import { initializeP2PCore, InitStatus, IPC_CHANNELS, KeyExchangeEvent, type P2PCore, type ContactRequestEvent, type ChatCreatedEvent, type KeyExchangeFailedEvent, type MessageReceivedEvent, type FileTransferProgressEvent, type FileTransferCompleteEvent, type FileTransferFailedEvent, type PendingFileReceivedEvent, type TorConfig, type PasswordRequest } from '../core/index.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { requestPasswordFromUI } from './password-prompt.js';
import { setupIPCHandlers } from './ipc-handlers.js';
import { TorManager, getTorBinaryPath, BUNDLED_TOR_SOCKS_PORT } from '../core/lib/tor-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let p2pCore: P2PCore | null = null;
let torManager: TorManager | null = null;
let lastInitStatus: InitStatus | null = null;
let initError: string | null = null;
let isCoreInitialized = false;
let pendingPasswordRequest: PasswordRequest | null = null;

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Electron] Another instance is already running. Exiting.');
  app.quit();
} else {
  // Focus existing window when second instance is attempted
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

// Window bounds persistence
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function getWindowBoundsPath(): string {
  const dataDir = ensureAppDataDir();
  return path.join(dataDir, 'window-bounds.json');
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const boundsPath = getWindowBoundsPath();
    if (fs.existsSync(boundsPath)) {
      const data = fs.readFileSync(boundsPath, 'utf-8');
      return JSON.parse(data) as WindowBounds;
    }
  } catch (error) {
    console.error('[Electron] Failed to load window bounds:', error);
  }
  return null;
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const data: WindowBounds = {
      ...bounds,
      isMaximized: win.isMaximized()
    };
    fs.writeFileSync(getWindowBoundsPath(), JSON.stringify(data));
  } catch (error) {
    console.error('[Electron] Failed to save window bounds:', error);
  }
}

function setupMinimalMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  const savedBounds = loadWindowBounds();
  const windowIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'app-icon.png')
    : path.join(__dirname, '..', '..', 'resources', 'icons', 'app-icon.png');

  const win = new BrowserWindow({
    // Use saved bounds if available, otherwise Electron will use defaults (centered)
    ...(savedBounds && {
      width: savedBounds.width,
      height: savedBounds.height,
      x: savedBounds.x,
      y: savedBounds.y,
    }),
    minWidth: 880,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: windowIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Need to disable sandbox for IPC to work properly
    }
  });

  // Restore maximized state or maximize on first run
  if (savedBounds?.isMaximized || !savedBounds) {
    win.maximize();
  }

  // Save bounds when window is resized, moved, or closed
  win.on('resize', () => saveWindowBounds(win));
  win.on('move', () => saveWindowBounds(win));
  win.on('close', () => saveWindowBounds(win));

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
  lastInitStatus = { message, stage };
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

function sendRestoreUsername(username: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Restore username: ${username}`);
    mainWindow.webContents.send(IPC_CHANNELS.RESTORE_USERNAME, username);
  }
}

function sendFileTransferProgress(data: FileTransferProgressEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] File transfer progress: ${data.current}/${data.total} for ${data.filename}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_PROGRESS, data);
  }
}

function sendFileTransferComplete(data: FileTransferCompleteEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] File transfer complete: ${data.filePath}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_COMPLETE, data);
  }
}

function sendFileTransferFailed(data: FileTransferFailedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] File transfer failed: ${data.error}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_FAILED, data);
  }
}

function sendPendingFileReceived(data: PendingFileReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Pending file received: ${data.filename} from ${data.senderUsername}`);
    mainWindow.webContents.send(IPC_CHANNELS.PENDING_FILE_RECEIVED, data);
  }
}

async function initializeP2PAfterWindow() {
  try {
    if (!mainWindow) {
      throw new Error('Main window not created');
    }

    console.log('[Electron] Starting P2P initialization...');

    const dataDir = ensureAppDataDir();
    console.log(`[Electron] Data directory: ${dataDir}`);

    const libp2pPort = 9001; // TODO: Make this configurable
    let torConfig: TorConfig | undefined;

    // Start bundled Tor
    sendInitStatus('Starting Tor daemon...', 'tor');
    try {
      const torBinaryPath = getTorBinaryPath(
        process.resourcesPath,
        app.getAppPath(),
        app.isPackaged
      );

      torManager = new TorManager({
        dataDir,
        libp2pPort,
        torBinaryPath,
        onStatus: (message, stage) => {
          console.log(`[TorManager] ${message}`);
          sendInitStatus(message, 'tor');
        },
      });

      const onionAddress = await torManager.start();
      console.log(`[Electron] Tor started with onion address: ${onionAddress}`);

      torConfig = {
        enabled: true,
        socksPort: BUNDLED_TOR_SOCKS_PORT,
        onionAddress,
      };
    } catch (torError) {
      console.error('[Electron] Failed to start Tor:', torError);
      sendInitStatus('Warning: Tor failed to start. Running in local mode.', 'tor');
      if (torManager) {
        try {
          await torManager.stop();
        } catch (stopError) {
          console.error('[Electron] Failed to stop Tor after startup error:', stopError);
        } finally {
          torManager = null;
        }
      }

      // Continue without Tor (local mode)
      torConfig = {
        enabled: false,
        socksPort: BUNDLED_TOR_SOCKS_PORT,
        onionAddress: null,
      };
    }

    sendInitStatus('Getting data directory...', 'database');

    // Initialize P2P core with custom password prompt
    p2pCore = await initializeP2PCore({
      dataDir,
      port: libp2pPort,
      torConfig,
      passwordPrompt: async (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => {
        console.log('[Electron] Requesting password from UI...');
        const response = await requestPasswordFromUI(
          mainWindow!,
          prompt,
          isNew,
          recoveryPhrase,
          prefilledPassword,
          errorMessage,
          cooldownSeconds,
          showRecoveryOption,
          keychainAvailable,
          (request) => {
            pendingPasswordRequest = request;
          }
        );
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
      },
      onRestoreUsername: (username: string) => {
        sendRestoreUsername(username);
      },
      onFileTransferProgress: (data: FileTransferProgressEvent) => {
        sendFileTransferProgress(data);
      },
      onFileTransferComplete: (data: FileTransferCompleteEvent) => {
        sendFileTransferComplete(data);
      },
      onFileTransferFailed: (data: FileTransferFailedEvent) => {
        sendFileTransferFailed(data);
      },
      onPendingFileReceived: (data: PendingFileReceivedEvent) => {
        sendPendingFileReceived(data);
      }
    });

    console.log('[Electron] P2P core initialized successfully');
    sendInitStatus('P2P node ready!', 'complete');
    isCoreInitialized = true;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_COMPLETE);
    }

  } catch (error) {
    console.error('[Electron] Failed to initialize P2P core:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    initError = errorMessage;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_ERROR, errorMessage);
    }
  }
}

async function initializeApp() {
  try {
    console.log('[Electron] Starting Kiyeovo...');

    // Setup minimal menu (keeps keyboard shortcuts working)
    setupMinimalMenu();

    // Setup IPC handlers
    setupIPCHandlers(ipcMain, () => p2pCore, () => mainWindow);
    console.log('[Electron] IPC handlers registered');
    ipcMain.handle(IPC_CHANNELS.INIT_STATE, () => {
      return {
        initialized: isCoreInitialized,
        status: lastInitStatus,
        error: initError,
        pendingPasswordRequest,
      };
    });

    // Create window first
    mainWindow = createMainWindow();
    console.log('[Electron] Main window created');

    // Wait for the window to be ready
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[Electron] Window loaded, starting P2P initialization...');
      // Start P2P initialization after window is ready
      void initializeP2PAfterWindow();
    });
    mainWindow.webContents.on('did-finish-load', () => {
      if (pendingPasswordRequest && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.PASSWORD_REQUEST, pendingPasswordRequest);
      }
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
  if (p2pCore || torManager) {
    event.preventDefault();

    // Shutdown P2P core first
    if (p2pCore) {
      console.log('[Electron] Shutting down P2P core...');
      try {
        await p2pCore.cleanup();
        console.log('[Electron] P2P core shutdown complete');
      } catch (error) {
        console.error('[Electron] Error during P2P shutdown:', error);
      } finally {
        p2pCore = null;
      }
    }

    // Then shutdown Tor
    if (torManager) {
      console.log('[Electron] Shutting down Tor daemon...');
      try {
        await torManager.stop();
        console.log('[Electron] Tor daemon shutdown complete');
      } catch (error) {
        console.error('[Electron] Error during Tor shutdown:', error);
      } finally {
        torManager = null;
      }
    }

    const restartRequested = Boolean((app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested);
    if (restartRequested) {
      (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = false;
      app.relaunch();
    }

    app.exit(0);
    return;
  }

  const restartRequested = Boolean((app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested);
  if (restartRequested) {
    (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = false;
    app.relaunch();
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('[Electron] Unhandled Rejection at:', promise, 'reason:', reason);
});
