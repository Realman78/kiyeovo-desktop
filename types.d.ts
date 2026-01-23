
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
        register: (username: string) => Promise<{ success: boolean; error?: string }>;

        // Send message
        sendMessage: (identifier: string, message: string) => Promise<{ success: boolean; messageSentStatus: 'online' | 'offline' | null; error: string | null }>;

        // Key exchange event
        onKeyExchangeSent: (callback: (data: { username: string; peerId: string }) => void) => () => void;
    };
}
