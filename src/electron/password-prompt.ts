import { BrowserWindow, ipcMain } from 'electron';
import { PasswordResponse, IPC_CHANNELS, PasswordRequest } from '../core/types.js';

/**
 * Request password from the UI instead of terminal
 */
export function requestPasswordFromUI(
  window: BrowserWindow,
  prompt: string,
  isNewPassword: boolean = false,
  recoveryPhrase?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // const timeout = setTimeout(() => {
    //   cleanup();
    //   reject(new Error('Password request timed out'));
    // }, 300000); // 5 minute timeout

    const handlePasswordResponse = (_event: any, response: PasswordResponse) => {
      cleanup();
      resolve(response.password);
    };

    const cleanup = () => {
      // clearTimeout(timeout);
      ipcMain.removeListener(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);
    };

    // Listen for response
    ipcMain.once(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);

    // Send request to renderer
    const request: PasswordRequest = {
      prompt,
      isNewPassword,
      ...(recoveryPhrase && { recoveryPhrase }),
    };
    window.webContents.send(IPC_CHANNELS.PASSWORD_REQUEST, request);
  });
}
