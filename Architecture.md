Kiyeovo Desktop - Architecture Proposal

  Executive Summary

  The migration strategy focuses on preserving the robust P2P core while wrapping it in an Electron-based desktop UI. The CLI app's modular design makes this migration straightforward with minimal refactoring.

  ---
  1. High-Level Architecture

  ┌─────────────────────────────────────────────────────────┐
  │                    ELECTRON APP                          │
  ├─────────────────────────────────────────────────────────┤
  │                                                          │
  │  ┌────────────────────┐      ┌────────────────────┐   │
  │  │   MAIN PROCESS     │◄────►│  RENDERER PROCESS   │   │
  │  │  (Node.js Runtime) │ IPC  │   (React UI)        │   │
  │  └────────────────────┘      └────────────────────┘   │
  │           │                                             │
  │           ▼                                             │
  │  ┌─────────────────────────────────────────────┐      │
  │  │         P2P CORE (libp2p)                    │      │
  │  │  • MessageHandler    • GroupHandler          │      │
  │  │  • KeyExchange       • FileHandler           │      │
  │  │  • SessionManager    • OfflineMessageMgr     │      │
  │  │  • UsernameRegistry  • ProfileManager        │      │
  │  │  • EncryptedIdentity • NotificationHandler   │      │
  │  └─────────────────────────────────────────────┘      │
  │           │                    │                        │
  │           ▼                    ▼                        │
  │  ┌──────────────┐     ┌─────────────────┐            │
  │  │ SQLite DB    │     │  libp2p Network  │            │
  │  │ (.kiyeovo/)  │     │  (DHT, Gossip)   │            │
  │  └──────────────┘     └─────────────────┘            │
  └─────────────────────────────────────────────────────────┘

  ---
  2. Proposed Directory Structure

  kiyeovo-desktop/
  ├── src/
  │   ├── electron/
  │   │   ├── main.ts                    # Electron main process entry
  │   │   ├── preload.cts                # Context bridge (security)
  │   │   ├── util.ts                    # Helpers
  │   │   └── ipc/                       # NEW: IPC handlers
  │   │       ├── index.ts               # IPC router
  │   │       ├── identity-handler.ts    # Identity operations
  │   │       ├── message-handler.ts     # Messaging IPC
  │   │       ├── group-handler.ts       # Group chat IPC
  │   │       ├── file-handler.ts        # File transfer IPC
  │   │       └── settings-handler.ts    # App settings IPC
  │   │
  │   ├── core/                          # NEW: P2P core (from CLI)
  │   │   ├── node-setup.ts
  │   │   ├── message-handler.ts
  │   │   ├── key-exchange.ts
  │   │   ├── session-manager.ts
  │   │   ├── message-encryption.ts
  │   │   ├── offline-message-manager.ts
  │   │   ├── username-registry.ts
  │   │   ├── encrypted-user-identity.ts
  │   │   ├── profile-manager.ts
  │   │   ├── file-handler.ts
  │   │   ├── peer-discovery.ts
  │   │   ├── stream-handler.ts
  │   │   ├── connection-gater.ts
  │   │   ├── group-handler.ts
  │   │   ├── notifications/
  │   │   │   └── notifications-handler.ts
  │   │   ├── db/
  │   │   │   └── database.ts
  │   │   ├── backup-manager.ts
  │   │   ├── errors.ts
  │   │   ├── constants.ts
  │   │   └── types.ts
  │   │
  │   ├── ui/                            # React frontend
  │   │   ├── main.tsx                   # React entry point
  │   │   ├── App.tsx                    # Root component
  │   │   ├── components/                # NEW: UI components
  │   │   │   ├── Layout/
  │   │   │   │   ├── Sidebar.tsx        # Contacts & conversations
  │   │   │   │   ├── Header.tsx         # App header w/ status
  │   │   │   │   └── StatusBar.tsx      # Connection status
  │   │   │   ├── Chat/
  │   │   │   │   ├── ChatWindow.tsx     # Active conversation
  │   │   │   │   ├── MessageList.tsx    # Message history
  │   │   │   │   ├── MessageInput.tsx   # Compose message
  │   │   │   │   ├── Message.tsx        # Individual message
  │   │   │   │   └── TypingIndicator.tsx
  │   │   │   ├── Contacts/
  │   │   │   │   ├── ContactList.tsx    # User list
  │   │   │   │   ├── ContactItem.tsx    # Individual contact
  │   │   │   │   ├── AddContact.tsx     # Search & add users
  │   │   │   │   └── ContactRequest.tsx # Auth requests
  │   │   │   ├── Groups/
  │   │   │   │   ├── GroupList.tsx      # Group conversations
  │   │   │   │   ├── CreateGroup.tsx    # New group dialog
  │   │   │   │   ├── GroupSettings.tsx  # Manage members
  │   │   │   │   └── GroupInvitation.tsx
  │   │   │   ├── FileTransfer/
  │   │   │   │   ├── FilePreview.tsx    # File attachment UI
  │   │   │   │   ├── FileProgress.tsx   # Transfer progress
  │   │   │   │   └── FileList.tsx       # Sent/received files
  │   │   │   ├── Identity/
  │   │   │   │   ├── RegisterUsername.tsx
  │   │   │   │   ├── ProfileExport.tsx  # TOFU trust
  │   │   │   │   ├── ProfileImport.tsx
  │   │   │   │   └── RecoveryPhrase.tsx
  │   │   │   ├── Settings/
  │   │   │   │   ├── SettingsPanel.tsx
  │   │   │   │   ├── SecuritySettings.tsx
  │   │   │   │   ├── NetworkSettings.tsx # Tor, bootstrap
  │   │   │   │   └── BackupSettings.tsx
  │   │   │   └── Notifications/
  │   │   │       ├── NotificationBell.tsx
  │   │   │       └── NotificationItem.tsx
  │   │   ├── hooks/                     # NEW: Custom React hooks
  │   │   │   ├── useMessages.ts         # Message state
  │   │   │   ├── useContacts.ts         # Contact list
  │   │   │   ├── useGroups.ts           # Group state
  │   │   │   ├── useIdentity.ts         # User identity
  │   │   │   ├── useFileTransfer.ts     # File operations
  │   │   │   └── useNetworkStatus.ts    # P2P connectivity
  │   │   ├── store/                     # NEW: State management
  │   │   │   ├── index.ts               # Store setup
  │   │   │   ├── slices/
  │   │   │   │   ├── messagesSlice.ts
  │   │   │   │   ├── contactsSlice.ts
  │   │   │   │   ├── groupsSlice.ts
  │   │   │   │   ├── identitySlice.ts
  │   │   │   │   └── uiSlice.ts
  │   │   │   └── middleware/
  │   │   │       └── ipcMiddleware.ts   # IPC ↔ Redux bridge
  │   │   ├── services/                  # NEW: API layer
  │   │   │   ├── ipc.ts                 # IPC wrapper
  │   │   │   └── api.ts                 # Typed API client
  │   │   ├── utils/
  │   │   │   ├── formatters.ts          # Date, size, etc.
  │   │   │   ├── validators.ts          # Input validation
  │   │   │   └── crypto-utils.ts        # UI crypto helpers
  │   │   ├── styles/                    # NEW: Styling
  │   │   │   ├── theme.ts               # Design tokens
  │   │   │   └── global.css             # Global styles
  │   │   └── assets/                    # Icons, images
  │   │
  │   └── shared/                        # NEW: Shared types
  │       ├── types.ts                   # Common interfaces
  │       └── ipc-channels.ts            # IPC channel names
  │
  ├── types.d.ts                         # Global type declarations
  ├── package.json
  ├── tsconfig.json
  ├── tsconfig.app.json                  # UI tsconfig
  ├── tsconfig.node.json                 # Electron tsconfig
  ├── vite.config.ts
  └── electron-builder.json

  ---
  3. Main Process Architecture (Node.js)

  3.1 Core Responsibilities

  The main process will:
  1. Initialize P2P node (libp2p with DHT, Gossipsub, etc.)
  2. Manage encrypted identity (load/create on startup)
  3. Handle database operations (SQLite)
  4. Run background tasks (offline messages, key rotation, cleanup)
  5. Expose IPC APIs to renderer process
  6. Manage native OS integration (notifications, tray, file dialogs)

  3.2 Main Process Entry Point (main.ts)

  import { app, BrowserWindow, ipcMain } from 'electron';
  import { initializeP2PCore } from './core';
  import { registerIpcHandlers } from './ipc';

  let mainWindow: BrowserWindow;
  let p2pCore: P2PCore;

  app.whenReady().then(async () => {
    // 1. Initialize database & identity
    p2pCore = await initializeP2PCore({
      dataDir: app.getPath('userData'),
      port: 9000 // or from settings
    });

    // 2. Register IPC handlers (expose APIs to renderer)
    registerIpcHandlers(ipcMain, p2pCore);

    // 3. Create window
    mainWindow = createMainWindow();

    // 4. Start background services
    startBackgroundServices(p2pCore);
  });

  function createMainWindow() {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // Load UI
    if (isDev()) {
      win.loadURL('http://localhost:3000');
    } else {
      win.loadFile('dist-ui/index.html');
    }

    return win;
  }

  3.3 P2P Core Initialization

  // core/index.ts
  export async function initializeP2PCore(config) {
    const database = await initializeDatabase(config.dataDir);
    const identity = await EncryptedUserIdentity.loadOrCreate(database);
    const node = await createChatNode(config.port, identity);

    await connectToBootstrap(node);

    const messageHandler = new MessageHandler(node, identity, database);
    const groupHandler = new GroupHandler(node, identity, database);
    const fileHandler = new FileHandler(node, identity, database);

    return {
      node,
      identity,
      database,
      messageHandler,
      groupHandler,
      fileHandler,
      usernameRegistry: new UsernameRegistry(node, identity, database)
    };
  }

  ---
  4. IPC Communication Layer

  4.1 IPC Channel Architecture

  // shared/ipc-channels.ts
  export const IPC_CHANNELS = {
    // Identity
    IDENTITY_GET_CURRENT: 'identity:getCurrent',
    IDENTITY_REGISTER_USERNAME: 'identity:registerUsername',
    IDENTITY_EXPORT_PROFILE: 'identity:exportProfile',
    IDENTITY_IMPORT_PROFILE: 'identity:importProfile',

    // Messaging
    MESSAGE_SEND: 'message:send',
    MESSAGE_GET_HISTORY: 'message:getHistory',
    MESSAGE_ON_RECEIVED: 'message:onReceived', // Main → Renderer

    // Groups
    GROUP_CREATE: 'group:create',
    GROUP_SEND_MESSAGE: 'group:sendMessage',
    GROUP_GET_INVITATIONS: 'group:getInvitations',
    GROUP_ACCEPT_INVITATION: 'group:acceptInvitation',

    // Files
    FILE_SEND: 'file:send',
    FILE_ON_OFFER: 'file:onOffer', // Main → Renderer
    FILE_ACCEPT_OFFER: 'file:acceptOffer',

    // Contacts
    CONTACT_SEARCH: 'contact:search',
    CONTACT_GET_LIST: 'contact:getList',
    CONTACT_BLOCK: 'contact:block',

    // Network
    NETWORK_GET_STATUS: 'network:getStatus',
    NETWORK_GET_PEERS: 'network:getPeers',
    NETWORK_ON_STATUS_CHANGE: 'network:onStatusChange',
  };

  4.2 IPC Handler Example

  // electron/ipc/message-handler.ts
  export function registerMessageHandlers(
    ipcMain: IpcMain,
    core: P2PCore
  ) {
    // Send message (Renderer → Main)
    ipcMain.handle(IPC_CHANNELS.MESSAGE_SEND, async (event, payload) => {
      const { username, content, type } = payload;

      try {
        await core.messageHandler.sendMessage(username, content);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Get history (Renderer → Main)
    ipcMain.handle(IPC_CHANNELS.MESSAGE_GET_HISTORY, async (event, username) => {
      return core.messageHandler.getHistory(username);
    });

    // Forward incoming messages to renderer (Main → Renderer)
    core.messageHandler.on('messageReceived', (message) => {
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send(IPC_CHANNELS.MESSAGE_ON_RECEIVED, message);
      });
    });
  }

  4.3 Preload Script (Security Bridge)

  // electron/preload.cts
  import { contextBridge, ipcRenderer } from 'electron';
  import { IPC_CHANNELS } from '../shared/ipc-channels';

  contextBridge.exposeInMainWorld('kiyeovoAPI', {
    // Identity
    identity: {
      getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.IDENTITY_GET_CURRENT),
      registerUsername: (username: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.IDENTITY_REGISTER_USERNAME, username),
    },

    // Messaging
    messages: {
      send: (username: string, content: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_SEND, { username, content }),
      getHistory: (username: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_GET_HISTORY, username),
      onReceived: (callback: (msg: any) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MESSAGE_ON_RECEIVED, (_, msg) => callback(msg));
      },
    },

    // Groups, files, contacts, etc. (similar pattern)
  });

  ---
  5. Renderer Process (React UI)

  5.1 State Management Strategy

  Option A: Redux Toolkit (Recommended for complex state)
  - Slices for messages, contacts, groups, identity, UI
  - Middleware to sync with IPC layer
  - DevTools for debugging
  - Time-travel debugging

  Option B: Zustand (Lightweight alternative)
  - Simpler API, less boilerplate
  - Still centralized state
  - Good for medium complexity

  Option C: React Context + Hooks (Minimal)
  - No external dependencies
  - May become complex with growth

  Recommendation: Redux Toolkit given the app's complexity and need for real-time updates from IPC.

  5.2 Component Architecture

  // ui/App.tsx
  function App() {
    const identity = useIdentity();
    const networkStatus = useNetworkStatus();

    if (!identity) {
      return <IdentitySetup />;
    }

    return (
      <Layout>
        <Sidebar>
          <ContactList />
          <GroupList />
        </Sidebar>

        <MainContent>
          <ChatWindow />
        </MainContent>

        <StatusBar status={networkStatus} />
      </Layout>
    );
  }

  5.3 Custom Hooks for IPC Integration

  // ui/hooks/useMessages.ts
  export function useMessages(chatId: string) {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      // Load history
      window.kiyeovoAPI.messages.getHistory(chatId).then(setMessages);
      setLoading(false);

      // Subscribe to new messages
      const unsubscribe = window.kiyeovoAPI.messages.onReceived((msg) => {
        if (msg.chatId === chatId) {
          setMessages(prev => [...prev, msg]);
        }
      });

      return unsubscribe;
    }, [chatId]);

    const sendMessage = async (content: string) => {
      await window.kiyeovoAPI.messages.send(chatId, content);
    };

    return { messages, loading, sendMessage };
  }

  ---
  6. Key Features & UI Screens

  6.1 Primary Views

  | View                  | Description                                      | Priority |
  |-----------------------|--------------------------------------------------|----------|
  | Identity Setup        | First-run: create/restore identity, set password | P0       |
  | Username Registration | Register username in DHT                         | P0       |
  | Chat List             | Sidebar with contacts & groups                   | P0       |
  | Chat Window           | Message history + input                          | P0       |
  | Contact Search        | Search & add users by username                   | P0       |
  | Group Creation        | Create group, invite members                     | P1       |
  | File Transfer         | Drag-drop files, progress UI                     | P1       |
  | Contact Authorization | Accept/reject contact requests                   | P1       |
  | Settings              | Network, security, backup settings               | P2       |
  | Profile Export/Import | TOFU trust establishment                         | P2       |
  | Backup/Restore        | Database backup UI                               | P2       |

  6.2 Real-Time Features

  1. Message notifications (OS-level via Electron)
  2. Typing indicators (via PubSub)
  3. Online/offline status (DHT presence + periodic check)
  4. File transfer progress (IPC progress events)
  5. Group invitation notifications (DHT polling → UI banner)
  6. Key rotation indicators (subtle UI feedback)

  ---
  7. Data Flow Examples

  7.1 Sending a Message

  1. User types message in ChatWindow component
  2. onClick → dispatch(sendMessage(username, content))
  3. Redux middleware → IPC: MESSAGE_SEND
  4. Main process → MessageHandler.sendMessage()
  5. MessageHandler → Key exchange (if needed)
  6. MessageHandler → Encrypt message
  7. MessageHandler → Send via libp2p stream
  8. MessageHandler → Save to database
  9. Main → IPC: MESSAGE_ON_RECEIVED (echo back)
  10. Renderer → Redux updates messages state
  11. ChatWindow re-renders with new message

  7.2 Receiving a Message

  1. libp2p stream → MessageHandler (main process)
  2. MessageHandler → Decrypt message
  3. MessageHandler → Save to database
  4. MessageHandler → Emit 'messageReceived' event
  5. IPC handler → Send MESSAGE_ON_RECEIVED to renderer
  6. Renderer → Redux updates state
  7. OS notification if window not focused
  8. ChatWindow updates if conversation is active

  7.3 File Transfer

  1. User drags file → FilePreview component
  2. onClick "Send" → dispatch(sendFile(username, filePath))
  3. IPC: FILE_SEND
  4. FileHandler (main) → Open stream to recipient
  5. FileHandler → Send FileOffer with BLAKE3 hash
  6. Recipient → FILE_ON_OFFER IPC to renderer
  7. Recipient UI → Accept/Reject dialog
  8. If accept → IPC: FILE_ACCEPT_OFFER
  9. FileHandler → Stream encrypted chunks
  10. Progress updates → IPC → UI progress bar
  11. Complete → Verify hash → Save to downloads/
  12. Notification → both sender & receiver

  ---
  8. Security Considerations

  8.1 Process Isolation

  - Main process: Full Node.js access, handles crypto & database
  - Renderer process: Sandboxed, no direct Node access
  - Preload script: Only exposes whitelisted APIs via contextBridge

  8.2 Sensitive Data Handling

  | Data Type            | Storage Location                     | Protection                                   |
  |----------------------|--------------------------------------|----------------------------------------------|
  | Private keys         | Main process memory + encrypted DB   | AES-256-GCM + Scrypt                         |
  | Passwords            | OS keychain (via keytar)             | OS-level encryption                          |
  | Messages (decrypted) | SQLite DB                            | File system encryption (user responsibility) |
  | Session keys         | Main process memory (SessionManager) | Cleared after 5min idle                      |
  | Recovery phrase      | Encrypted DB + user backup           | AES-256-GCM                                  |

  8.3 IPC Validation

  // All IPC handlers should validate inputs
  ipcMain.handle('message:send', async (event, payload) => {
    // Validate schema
    if (!payload.username || typeof payload.content !== 'string') {
      throw new Error('Invalid payload');
    }

    // Sanitize input
    const sanitized = sanitizeMessage(payload.content);

    // Rate limiting (prevent UI from spamming)
    if (isRateLimited(event.sender.id)) {
      throw new Error('Rate limited');
    }

    // Process...
  });

  ---
  9. Migration Strategy

  Phase 1: Foundation (Week 1-2)

  1. Set up Electron + React boilerplate (✅ Already done)
  2. Copy core/ modules from CLI (with minimal changes)
  3. Create IPC channel definitions
  4. Build basic IPC handlers for identity & messaging
  5. Create placeholder UI components

  Phase 2: Core Features (Week 3-4)

  1. Identity setup flow (first-run experience)
  2. Username registration UI
  3. Basic chat window (send/receive messages)
  4. Contact list & search
  5. Message history display

  Phase 3: Advanced Features (Week 5-6)

  1. Group chat UI
  2. File transfer with progress
  3. Contact authorization workflow
  4. Settings panel
  5. Notifications (OS-level)

  Phase 4: Polish (Week 7-8)

  1. Profile export/import (TOFU)
  2. Backup/restore UI
  3. Tor configuration UI
  4. Error handling & feedback
  5. Performance optimization
  6. Testing & bug fixes

  ---
  10. Technology Stack Recommendation

  | Layer             | Technology                         | Reasoning                              |
  |-------------------|------------------------------------|----------------------------------------|
  | Desktop Framework | Electron v31+                      | Mature, cross-platform, Node.js access |
  | UI Framework      | React 19                           | Already chosen, good ecosystem         |
  | State Management  | Redux Toolkit                      | Handles complex async state well       |
  | Styling           | Tailwind CSS or MUI                | Fast development, consistent design    |
  | Build Tool        | Vite                               | Fast HMR, already configured           |
  | P2P Core          | Keep existing (libp2p)             | No changes needed                      |
  | Database          | SQLite (better-sqlite3)            | Keep existing                          |
  | IPC               | Electron IPC (ipcRenderer/ipcMain) | Built-in, secure                       |

  ---
  11. File Storage & Directories

  User Data Directory (app.getPath('userData')):
    ~/.config/kiyeovo-desktop/          # Linux
    ~/Library/Application Support/kiyeovo-desktop/  # macOS
    %APPDATA%\kiyeovo-desktop\          # Windows

  Structure:
    ├── chat.db                         # SQLite database
    ├── chat.db-wal                     # Write-ahead log
    ├── chat.db-shm                     # Shared memory
    ├── config.json                     # App settings (electron-store)
    ├── logs/                           # Application logs
    │   ├── main.log
    │   └── renderer.log
    ├── downloads/                      # Received files
    └── backups/                        # Database backups

  ---
  12. Performance Optimizations

  1. Virtual scrolling for long message lists (react-window)
  2. Lazy loading for chat history (load on scroll)
  3. Debounced search for contact lookup
  4. Background IPC for non-urgent operations (offline checks)
  5. IndexedDB caching for message drafts (renderer-side)
  6. Worker threads for heavy crypto operations (if needed)
  7. Code splitting for settings/advanced features

  ---
  13. Testing Strategy

  - Unit tests: Core modules (Jest)
  - Integration tests: IPC layer (Spectron/Playwright)
  - E2E tests: Full workflows (Playwright)
  - Manual testing: Tor integration, NAT traversal

  ---
  14. Open Questions for You

  1. UI Design: Do you have a specific design language/mockups in mind? (Material, macOS-style, custom?)
  2. Tor UI: Should Tor settings be exposed in UI or remain env-based?
  3. Bootstrap nodes: Should users configure their own or use hardcoded defaults?
  4. Multi-account: Support multiple identities in one app?
  5. Tray integration: Should the app minimize to system tray?
  6. Auto-updates: Use electron-updater for automatic updates?

  ---
  15. Next Steps

  Once you approve this architecture, I can help with:

  1. Setting up the IPC layer (handlers, preload, typed channels)
  2. Migrating core modules from CLI to core/ directory
  3. Creating Redux store with slices
  4. Building UI components (start with chat window)
  5. Implementing first E2E flow (register username → send message)