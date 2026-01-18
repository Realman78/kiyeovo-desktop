import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDev } from './util.js';
import { initializeP2PCore, InitStatus, IPC_CHANNELS, type P2PCore } from '../core/index.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { requestPasswordFromUI } from './password-prompt.js';

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

// IPC Handlers
ipcMain.handle(IPC_CHANNELS.REGISTER_REQUEST, async (_event, username: string) => {
  try {
    if (!p2pCore) {
      return { success: false, error: 'P2P core not initialized' };
    }

    console.log(`[Electron] Registering username: ${username}`);
    const success = await p2pCore.usernameRegistry.register(username);

    if (success) {
      console.log(`[Electron] Successfully registered username: ${username}`);
      return { success: true };
    } else {
      return { success: false, error: 'Failed to register username. Network may be unreachable.' };
    }
  } catch (error) {
    console.error('[Electron] Registration failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
});

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