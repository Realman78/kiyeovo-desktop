export interface PasswordRequest {
    prompt: string;
    isNewPassword?: boolean;
    recoveryPhrase?: string;
    prefilledPassword?: string;
    errorMessage?: string;
    cooldownSeconds?: number; // Remaining cooldown time in seconds
    showRecoveryOption?: boolean; // Show recovery phrase option after failed attempt
    keychainAvailable?: boolean; // Whether OS keychain is available
  }

export type MessageSentStatus = 'online' | 'offline' | null;