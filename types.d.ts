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

            // Message events
            getMessages: (chatId: number) => Promise<{ success: boolean; messages: Array<Message & { sender_username?: string }>; error: string | null }>;
            onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => () => void;

            // Pending key exchange events
            cancelPendingKeyExchange: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
        };
    }
}

export {};