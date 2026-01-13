import os from 'os';
import path from 'path';
import fs from 'fs';

import type { PeerInfo } from '@libp2p/interface';
import type { Component, Multiaddr } from '@multiformats/multiaddr';

/**
 * Remove all addresses except for onion v3 addresses
 */
// TODO test this new filtering because protoCodes() is deprecated
export const filterOnionAddressesMapper = (peer: PeerInfo): PeerInfo => {
    peer.multiaddrs = peer.multiaddrs.filter((ma: Multiaddr) =>
        ma.getComponents().some((c: Component) => c.code === 445)); // 445 is /onion3
    return peer;
};

export const ensurePort = (args: string[]): number => {
    try {
        if (args.length > 0 && args[0]) {
            const portArg = args[0];
            const parsedPort = parseInt(portArg, 10);
            if (isNaN(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
                console.error(`Invalid port: ${portArg}. Port must be between 1024 and 65535.`);
                console.log('Usage: npm start <port>');
                console.log('Example: npm start 9001');
                process.exit(1);
            }
            return parsedPort;
        }
        return 9000;
    } catch (error) {
        console.error(`Error ensuring port: ${error}`);
        process.exit(1);
    }
};

export const ensureAppDataDir = (): string => {
    const platform = process.platform;
    const home = os.homedir();
    let appDataDir = '';

    switch (platform) {
        case 'win32':
            appDataDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'kiyeovo');
            break;
        case 'darwin':
            appDataDir = path.join(home, 'Library', 'Application Support', 'kiyeovo');
            break;
        case 'linux':
            appDataDir = path.join(home, '.config', 'kiyeovo');
            break;
        default:
            appDataDir = path.join('.kiyeovo');
            break;
    }
    if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
    }
    return appDataDir;
};
