
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
    };
}
