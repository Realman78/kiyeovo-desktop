export interface PasswordRequest {
    prompt: string;
    isNewPassword?: boolean;
    recoveryPhrase?: string;
  }