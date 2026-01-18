import { contextBridge, ipcRenderer } from 'electron';
import { InitStatus, IPC_CHANNELS, PasswordRequest } from '../core';

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
});