import { contextBridge, ipcRenderer } from 'electron';
import { InitStatus, IPC_CHANNELS, KeyExchangeEvent, MessageSentStatus, PasswordRequest, ContactRequestEvent, ChatCreatedEvent, KeyExchangeFailedEvent, MessageReceivedEvent } from '../core';
import { ContactAttempt, Message } from '../core/lib/db/database';

contextBridge.exposeInMainWorld('kiyeovoAPI', {
    // Password authentication
    onPasswordRequest: (callback: (request: PasswordRequest) => void) => {
        const listener = (_event: any, request: PasswordRequest) => callback(request);
        ipcRenderer.on(IPC_CHANNELS.PASSWORD_REQUEST, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PASSWORD_REQUEST, listener);
    },
    submitPassword: (password: string, rememberMe: boolean) => {
        ipcRenderer.send(IPC_CHANNELS.PASSWORD_RESPONSE, { password, rememberMe });
    },

    // Initialization status
    onInitStatus: (callback: (status: InitStatus) => void) => {
        const listener = (_event: any, status: InitStatus) => callback(status);
        ipcRenderer.on(IPC_CHANNELS.INIT_STATUS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_STATUS, listener);
    },
    onInitComplete: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on(IPC_CHANNELS.INIT_COMPLETE, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_COMPLETE, listener);
    },
    onInitError: (callback: (error: string) => void) => {
        const listener = (_event: any, error: string) => callback(error);
        ipcRenderer.on(IPC_CHANNELS.INIT_ERROR, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_ERROR, listener);
    },

    // DHT connection status
    onDHTConnectionStatus: (callback: (status: { connected: boolean }) => void) => {
        const listener = (_event: any, status: { connected: boolean }) => callback(status);
        ipcRenderer.on(IPC_CHANNELS.DHT_CONNECTION_STATUS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DHT_CONNECTION_STATUS, listener);
    },

    // Register
    register: async (username: string, rememberMe: boolean): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REGISTER_REQUEST, username, rememberMe);
    },

    // Get current user state
    getUserState: async (): Promise<{ username: string | null; isRegistered: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_USER_STATE);
    },

    // Auto-register setting
    getAutoRegister: async (): Promise<{ autoRegister: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_AUTO_REGISTER);
    },
    setAutoRegister: async (enabled: boolean): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_REGISTER, enabled);
    },

    onRestoreUsername: (callback: (username: string) => void) => {
        const listener = (_event: any, username: string) => callback(username);
        ipcRenderer.on(IPC_CHANNELS.RESTORE_USERNAME, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RESTORE_USERNAME, listener);
    },

    // Unregister
    unregister: async (username: string): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.UNREGISTER_REQUEST, username);
    },

    // Send message
    sendMessage: async (identifier: string, message: string): Promise<{ success: boolean; messageSentStatus: MessageSentStatus; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE_REQUEST, identifier, message);
    },

    // Key exchange event
    onKeyExchangeSent: (callback: (data: KeyExchangeEvent) => void) => {
        const listener = (_event: any, data: KeyExchangeEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.KEY_EXCHANGE_SENT, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.KEY_EXCHANGE_SENT, listener);
    },

    // Contact request events
    onContactRequestReceived: (callback: (data: ContactRequestEvent) => void) => {
        const listener = (_event: any, data: ContactRequestEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, listener);
    },
    acceptContactRequest: async (peerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ACCEPT_CONTACT_REQUEST, peerId);
    },
    rejectContactRequest: async (peerId: string, shouldBlock: boolean): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REJECT_CONTACT_REQUEST, peerId, shouldBlock);
    },

    // Bootstrap nodes
    getBootstrapNodes: async (): Promise<{ success: boolean; nodes: Array<{ address: string; connected: boolean }>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_BOOTSTRAP_NODES);
    },
    retryBootstrap: async (): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RETRY_BOOTSTRAP);
    },
    addBootstrapNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ADD_BOOTSTRAP_NODE, address);
    },
    removeBootstrapNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REMOVE_BOOTSTRAP_NODE, address);
    },

    // Contact attempts
    getContactAttempts: async (): Promise<{ success: boolean; contactAttempts: Array<ContactAttempt>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CONTACT_ATTEMPTS);
    },

    // Chat created event
    onChatCreated: (callback: (data: ChatCreatedEvent) => void) => {
        const listener = (_event: any, data: ChatCreatedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CHAT_CREATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_CREATED, listener);
    },

    // Key exchange failed event
    onKeyExchangeFailed: (callback: (data: KeyExchangeFailedEvent) => void) => {
        const listener = (_event: any, data: KeyExchangeFailedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.KEY_EXCHANGE_FAILED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.KEY_EXCHANGE_FAILED, listener);
    },

    // Message received event
    onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => {
        const listener = (_event: any, data: MessageReceivedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.MESSAGE_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MESSAGE_RECEIVED, listener);
    },

    // Chats
    getChats: async (): Promise<{ success: boolean; chats: Array<any>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CHATS);
    },

    // Messages
    getMessages: async (chatId: number): Promise<{ success: boolean; messages: Array<Message>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_MESSAGES, chatId);
    },

    // Pending key exchange events
    cancelPendingKeyExchange: async (peerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PENDING_KEY_EXCHANGE, peerId);
    },
});