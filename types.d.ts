import type { ContactRequestEvent, ChatCreatedEvent, KeyExchangeFailedEvent, InitStatus, PasswordRequest, MessageReceivedEvent, KeyExchangeEvent, SendMessageResponse } from './src/core/types';
import type { Chat, Message } from './src/core/lib/db/database';

declare global {
    interface Window {
        kiyeovoAPI: {
            // Password authentication
            onPasswordRequest: (callback: (request: PasswordRequest) => void) => () => void;
            submitPassword: (password: string, rememberMe: boolean) => void;

            // Initialization status
            onInitStatus: (callback: (status: InitStatus) => void) => () => void;
            onInitComplete: (callback: () => void) => () => void;
            onInitError: (callback: (error: string) => void) => () => void;

            // DHT connection status
            onDHTConnectionStatus: (callback: (status: { connected: boolean }) => void) => () => void;

            // Register
            register: (username: string, rememberMe: boolean) => Promise<{ success: boolean; error?: string }>;
            getUserState: () => Promise<{ username: string | null; isRegistered: boolean }>;
            getAutoRegister: () => Promise<{ autoRegister: boolean }>;
            setAutoRegister: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
            onRestoreUsername: (callback: (username: string) => void) => () => void;
            unregister: (username: string) => Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }>;

            // Send message
            sendMessage: (identifier: string, message: string) => Promise<SendMessageResponse>;

            // Key exchange events
            onKeyExchangeSent: (callback: (data: KeyExchangeEvent) => void) => () => void;
            onKeyExchangeFailed: (callback: (data: KeyExchangeFailedEvent) => void) => () => void;

            // Contact request events
            onContactRequestReceived: (callback: (data: ContactRequestEvent) => void) => () => void;
            acceptContactRequest: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
            rejectContactRequest: (peerId: string, block: boolean) => Promise<{ success: boolean; error: string | null }>;

            // Bootstrap nodes
            getBootstrapNodes: () => Promise<{ success: boolean; nodes: Array<{ address: string; connected: boolean }>; error: string | null }>;
            retryBootstrap: () => Promise<{ success: boolean; error: string | null }>;
            addBootstrapNode: (address: string) => Promise<{ success: boolean; error: string | null }>;
            removeBootstrapNode: (address: string) => Promise<{ success: boolean; error: string | null }>;

            // Contact attempts
            getContactAttempts: () => Promise<{ success: boolean; contactAttempts: Array<ContactAttempt>; error: string | null }>;

            // Chat events
            onChatCreated: (callback: (data: ChatCreatedEvent) => void) => () => void;
            getChats: () => Promise<{ success: boolean; chats: Array<Chat>; error: string | null }>;
            getChatById: (chatId: number) => Promise<{
                success: boolean;
                chat: (Chat & {
                    username?: string;
                    other_peer_id?: string;
                    last_message_content?: string;
                    last_message_timestamp?: Date;
                    last_message_sender?: string;
                    updated_at?: Date;
                }) | null;
                error: string | null
            }>;
            
            // Message events
            getMessages: (chatId: number) => Promise<{ success: boolean; messages: Array<Message & { sender_username?: string }>; error: string | null }>;
            onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => () => void;

            // Offline message events
            checkOfflineMessages: (chatIds?: number[]) => Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }>;
            checkOfflineMessagesForChat: (chatId: number) => Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }>;

            // Pending key exchange events
            cancelPendingKeyExchange: (peerId: string) => Promise<{ success: boolean; error: string | null }>;

            // Trusted user import/export
            importTrustedUser: (
                filePath: string,
                password: string,
                customName?: string
            ) => Promise<{
                success: boolean;
                error?: string;
                fingerprint?: string;
                chatId?: number;
                username?: string;
                peerId?: string;
            }>;

            exportProfile: (
                password: string,
                sharedSecret: string
            ) => Promise<{
                success: boolean;
                error?: string;
                filePath?: string;
                fingerprint?: string;
            }>;

            // File dialogs
            showOpenDialog: (options: {
                title?: string;
                filters?: Array<{ name: string; extensions: string[] }>;
            }) => Promise<{ filePath: string | null; canceled: boolean }>;

            showSaveDialog: (options: {
                title?: string;
                defaultPath?: string;
                filters?: Array<{ name: string; extensions: string[] }>;
            }) => Promise<{ filePath: string | null; canceled: boolean }>;

            // Notifications
            showNotification: (options: {
                title: string;
                body: string;
                chatId?: number;
            }) => Promise<{ success: boolean; error?: string }>;
            isWindowFocused: () => Promise<{ focused: boolean }>;
            focusWindow: () => Promise<{ success: boolean; error?: string }>;
            onNotificationClicked: (callback: (chatId: number) => void) => () => void;

            // Chat settings
            toggleChatMute: (chatId: number) => Promise<{ success: boolean; muted: boolean; error: string | null }>;
            deleteAllMessages: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            deleteChatAndUser: (chatId: number, peerId: string) => Promise<{ success: boolean; error: string | null }>;
            updateUsername: (peerId: string, newUsername: string) => Promise<{ success: boolean; error: string | null }>;

            // User blocking
            blockUser: (peerId: string, username: string | null, reason: string | null) => Promise<{ success: boolean; error: string | null }>;
            unblockUser: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
            isUserBlocked: (peerId: string) => Promise<{ success: boolean; blocked: boolean; error: string | null }>;
            getUserInfo: (peerId: string, chatId: number) => Promise<{
                success: boolean;
                userInfo?: {
                    username: string;
                    peerId: string;
                    userSince: Date;
                    chatCreated?: Date;
                    trustedOutOfBand: boolean;
                    messageCount: number;
                    muted: boolean;
                    blocked: boolean;
                    blockedAt?: Date;
                    blockReason?: string | null;
                };
                error: string | null
            }>;

            // App settings
            getNotificationsEnabled: () => Promise<{ success: boolean; enabled: boolean; error: string | null }>;
            setNotificationsEnabled: (enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
            onNotificationsEnabledChanged: (callback: (enabled: boolean) => void) => () => void;
        };
    }
}

export {};