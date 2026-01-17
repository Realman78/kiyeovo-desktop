import { BrowserWindow, ipcMain } from 'electron';
import { PasswordResponse, IPC_CHANNELS, PasswordRequest } from '../core/types.js';

/**
 * Request password from the UI instead of terminal
 */
export function requestPasswordFromUI(
  window: BrowserWindow,
  prompt: string,
  isNewPassword: boolean = false,
  recoveryPhrase?: string,
  prefilledPassword?: string,
  errorMessage?: string,
  cooldownSeconds?: number,
  showRecoveryOption?: boolean,
  keychainAvailable?: boolean
): Promise<PasswordResponse> {
  return new Promise((resolve, reject) => {
    const handlePasswordResponse = (_event: any, response: PasswordResponse) => {
      cleanup();
      resolve(response);
    };

    const cleanup = () => {
      ipcMain.removeListener(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);
    };

    // Listen for response
    ipcMain.once(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);

    // Send request to renderer
    const request: PasswordRequest = {
      prompt,
      isNewPassword,
      ...(recoveryPhrase && { recoveryPhrase }),
      ...(prefilledPassword && { prefilledPassword }),
      ...(errorMessage && { errorMessage }),
      ...(cooldownSeconds !== undefined && { cooldownSeconds }),
      ...(showRecoveryOption !== undefined && { showRecoveryOption }),
      ...(keychainAvailable !== undefined && { keychainAvailable }),
    };
    window.webContents.send(IPC_CHANNELS.PASSWORD_REQUEST, request);
  });
}
