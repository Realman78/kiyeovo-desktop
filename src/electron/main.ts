import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { isDev } from './util.js';
import { initializeP2PCore, InitStatus, IPC_CHANNELS, KeyExchangeEvent, type P2PCore, type ContactRequestEvent, type ChatCreatedEvent, type KeyExchangeFailedEvent, type MessageReceivedEvent, type FileTransferProgressEvent, type FileTransferCompleteEvent, type FileTransferFailedEvent, type PendingFileReceivedEvent, type GroupChatActivatedEvent, type GroupMembersUpdatedEvent, type TorConfig, type PasswordRequest } from '../core/index.js';
import { DEFAULT_NETWORK_MODE, NETWORK_MODE_ONBOARDED_SETTING_KEY } from '../core/constants.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { requestPasswordFromUI } from './password-prompt.js';
import { setupIPCHandlers } from './ipc-handlers.js';
import { TorManager, getTorBinaryPath, BUNDLED_TOR_SOCKS_PORT } from '../core/lib/tor-manager.js';
import { ChatDatabase } from '../core/lib/db/database.js';
import type { NetworkMode } from '../core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let p2pCore: P2PCore | null = null;
let torManager: TorManager | null = null;
let lastInitStatus: InitStatus | null = null;
let initError: string | null = null;
let isCoreInitialized = false;
let hasStartedInitialization = false;
let requiresNetworkModeSelection = false;
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

function getWindowBrandingForMode(mode: NetworkMode): { title: string; icon: string } {
  const iconsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '..', '..', 'resources', 'icons');

  const fastIconPath = path.join(iconsDir, 'app-icon.png');
  if (mode !== 'anonymous') {
    return {
      title: 'Kiyeovo',
      icon: fastIconPath,
    };
  }

  const anonymousIconPath = path.join(iconsDir, 'app-icon-anonymous.png');
  return {
    title: 'Kiyeovo (anonymous)',
    icon: fs.existsSync(anonymousIconPath) ? anonymousIconPath : fastIconPath,
  };
}

function createMainWindow() {
  const savedBounds = loadWindowBounds();
  const startupNetworkMode = readPersistedNetworkMode();
  const branding = getWindowBrandingForMode(startupNetworkMode);

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
    title: branding.title,
    icon: branding.icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Need to disable sandbox for IPC to work properly
    }
  });

  // Keep dock/taskbar branding aligned with the current network mode.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(branding.icon);
  }
  if (process.platform === 'linux') {
    // Some Linux DEs ignore constructor icon unless applied after creation.
    win.setIcon(branding.icon);
  }

  const enforceWindowTitle = () => {
    if (!win.isDestroyed()) {
      win.setTitle(branding.title);
    }
  };

  // Prevent renderer HTML <title> updates from overriding mode-aware native window title.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    enforceWindowTitle();
  });
  win.webContents.on('did-finish-load', enforceWindowTitle);

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
    console.log(`[DHT-STATUS][ELECTRON][EMIT] connected=${status.connected}`);
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

function sendGroupChatActivated(data: GroupChatActivatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Group chat activated: chatId=${data.chatId}`);
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CHAT_ACTIVATED, data);
  }
}

function sendGroupMembersUpdated(data: GroupMembersUpdatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[Electron] Group members updated: chatId=${data.chatId}, member=${data.memberPeerId}`);
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_MEMBERS_UPDATED, data);
  }
}

function sendOfflineMessagesFetchComplete(chatIds: number[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, { chatIds });
  }
}

function detectRequiresNetworkModeSelection(): boolean {
  try {
    const dbPath = path.join(ensureAppDataDir(), 'chat.db');
    const db = new ChatDatabase(dbPath);
    try {
      // Ensure mode exists (self-heals invalid/missing).
      db.getNetworkMode();
      const onboarded = db.getSetting(NETWORK_MODE_ONBOARDED_SETTING_KEY) === 'true';
      return !onboarded;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[Electron] Failed to check network mode onboarding state:', error);
    // Fail-open to avoid blocking users if settings check fails.
    return false;
  }
}

function readPersistedNetworkMode(): NetworkMode {
  try {
    const dbPath = path.join(ensureAppDataDir(), 'chat.db');
    const db = new ChatDatabase(dbPath);
    try {
      return db.getNetworkMode();
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[Electron] Failed to read persisted network mode, using default:', error);
    return DEFAULT_NETWORK_MODE;
  }
}

function startP2PInitialization(): void {
  if (hasStartedInitialization || isCoreInitialized) {
    return;
  }
  hasStartedInitialization = true;
  requiresNetworkModeSelection = false;
  void initializeP2PAfterWindow();
}

async function initializeP2PAfterWindow() {
  try {
    if (!mainWindow) {
      throw new Error('Main window not created');
    }

    console.log('[Electron] Starting P2P initialization...');

    const dataDir = ensureAppDataDir();
    console.log(`[Electron] Data directory: ${dataDir}`);
    const startupNetworkMode = readPersistedNetworkMode();
    console.log(`[STACK][ELECTRON] startup_mode=${startupNetworkMode}`);
    console.log(`[STACK][ELECTRON] tor_bootstrap=${startupNetworkMode === 'anonymous' ? 'enabled' : 'disabled'}`);

    const libp2pPort = 9001; // TODO: Make this configurable
    let torConfig: TorConfig | undefined;

    if (startupNetworkMode === 'anonymous') {
      // Start bundled Tor for anonymous mode only.
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
        if (!onionAddress) {
          throw new Error('Tor started without onion address');
        }
        console.log(`[Electron] Tor started with onion address: ${onionAddress}`);

        torConfig = {
          enabled: true,
          socksPort: BUNDLED_TOR_SOCKS_PORT,
          onionAddress,
        };
      } catch (torError) {
        console.error('[Electron] Failed to start Tor:', torError);
        sendInitStatus('Tor failed to start. Anonymous mode cannot continue.', 'tor');
        if (torManager) {
          try {
            await torManager.stop();
          } catch (stopError) {
            console.error('[Electron] Failed to stop Tor after startup error:', stopError);
          } finally {
            torManager = null;
          }
        }
        throw new Error('Anonymous mode requires Tor startup. Initialization aborted.');
      }
    } else {
      sendInitStatus('Fast mode selected: skipping Tor daemon startup.', 'tor');
    }

    sendInitStatus('Getting data directory...', 'database');

    // Initialize P2P core with custom password prompt
    const p2pCoreConfig = {
      dataDir,
      port: libp2pPort,
      ...(torConfig ? { torConfig } : {}),
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
      },
      onGroupChatActivated: (data: GroupChatActivatedEvent) => {
        sendGroupChatActivated(data);
      },
      onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => {
        sendGroupMembersUpdated(data);
      },
      onOfflineMessagesFetchComplete: (chatIds: number[]) => {
        sendOfflineMessagesFetchComplete(chatIds);
      },
    };
    p2pCore = await initializeP2PCore(p2pCoreConfig);

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
    hasStartedInitialization = false;

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
        initStarted: hasStartedInitialization,
        requiresNetworkModeSelection,
        status: lastInitStatus,
        error: initError,
        pendingPasswordRequest,
      };
    });
    ipcMain.handle(IPC_CHANNELS.INIT_START, async () => {
      try {
        if (isCoreInitialized) {
          return { success: true, error: null };
        }
        if (!mainWindow || mainWindow.isDestroyed()) {
          return { success: false, error: 'Main window not ready' };
        }
        startP2PInitialization();
        return { success: true, error: null };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to start initialization' };
      }
    });

    // Create window first
    mainWindow = createMainWindow();
    console.log('[Electron] Main window created');

    // Wait for the window to be ready
    mainWindow.webContents.once('did-finish-load', () => {
      requiresNetworkModeSelection = detectRequiresNetworkModeSelection();
      if (requiresNetworkModeSelection) {
        console.log('[Electron] Window loaded, waiting for network mode selection before initialization...');
        sendInitStatus('Select Fast or Anonymous mode to continue', 'database');
        return;
      }
      console.log('[Electron] Window loaded, starting P2P initialization...');
      startP2PInitialization();
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
