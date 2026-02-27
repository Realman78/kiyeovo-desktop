import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import dotenv from 'dotenv';

import type { PeerId } from '@libp2p/interface';
import type { ChatNode } from './types.js';

import { PeerIdManager } from './lib/peer-id-manager.js';
import {
  BOOTSTRAP_LISTEN_ADDRESS,
  DHT_PROTOCOL,
  K_BUCKET_SIZE,
  PREFIX_LENGTH,
  BOOTSTRAP_PEER_ID_FILE,
  getTorConfig
} from './constants.js';
import { filterOnionAddressesMapper } from './utils/miscellaneous.js';
import { offlineMessageSelector, offlineMessageValidateUpdate, offlineMessageValidator } from './lib/offline-message-validator.js';
import { groupOfflineMessageValidator, groupInfoLatestValidator, groupInfoVersionedValidator, groupOfflineMessageSelector, groupInfoLatestSelector, groupOfflineValidateUpdate, groupInfoLatestValidateUpdate, groupInfoVersionedValidateUpdate } from './lib/group/group-dht-validator.js';

dotenv.config();

async function createBootstrapNode(): Promise<ChatNode> {
  const { privateKey } = await PeerIdManager.loadOrCreate(BOOTSTRAP_PEER_ID_FILE);

  const announceAddrs: string[] = [];
  if (process.env.BOOTSTRAP_ANNOUNCE_ADDRS) {
    const rawAddrs = process.env.BOOTSTRAP_ANNOUNCE_ADDRS.split(',').map(addr => addr.trim()).filter(Boolean);
    const validAddrs: string[] = [];
    let hasOnion = false;
    let hasNonOnion = false;

    for (const addr of rawAddrs) {
      try {
        const ma = multiaddr(addr);
        const protocols = ma.getComponents().map(c => c.code);
        const isOnion = protocols.includes(445);

        if (isOnion) {
          hasOnion = true;
          // Validate onion address format
          const onionTuple = ma.getComponents().find(c => c.code === 445);
          if (onionTuple?.value) {
            const [onionHost] = onionTuple.value.split(':');
            if (onionHost && !/^[a-z2-7]{56}$/i.test(onionHost)) {
              console.warn(`[BOOTSTRAP] Invalid onion v3 address ignored: ${addr} (must be 56 characters base32)`);
              continue;
            }
          }
        } else {
          hasNonOnion = true;
        }

        validAddrs.push(addr);
      } catch {
        console.warn(`[BOOTSTRAP] Invalid announce address ignored: ${addr}`);
      }
    }

    // Warn if mixing onion and non-onion addresses
    if (hasOnion && hasNonOnion) {
      console.warn('[BOOTSTRAP] WARNING: Mixing onion and non-onion announce addresses!');
      console.warn('[BOOTSTRAP]   Onion peers may not be able to reach non-onion addresses');
      console.warn('[BOOTSTRAP]   Consider using only onion addresses for Tor compatibility');
    }

    announceAddrs.push(...validAddrs);
  }

  const torConfig = getTorConfig();
  const transports = [tcp()];

  if (torConfig.enabled) {
    console.log(`Bootstrap: TCP listening enabled, Tor proxy configured at ${torConfig.socksHost}:${torConfig.socksPort}`);
  } else {
    console.log('Bootstrap: Using direct TCP transport only');
  }

  const bootstrap = await createLibp2p({
    privateKey: privateKey,
    addresses: {
      listen: [BOOTSTRAP_LISTEN_ADDRESS],
      announce: torConfig.enabled ? announceAddrs : []
    },
    transports: transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 500,
      maxPeerAddrsToDial: 10,
    },
    connectionMonitor: {
      enabled: true,
      pingInterval: torConfig.enabled ? 120000 : 30000,
      pingTimeout: {
        minTimeout: torConfig.enabled ? 30000 : 5000,
        maxTimeout: torConfig.enabled ? 120000 : 30000,
      },
      abortConnectionOnPingFailure: !torConfig.enabled,
    },
    services: {
      pubsub: gossipsub({
        doPX: true
      }),
      dht: kadDHT({
        protocol: DHT_PROTOCOL,
        peerInfoMapper: torConfig.enabled ? filterOnionAddressesMapper : removePublicAddressesMapper,
        clientMode: false,
        kBucketSize: K_BUCKET_SIZE,
        prefixLength: PREFIX_LENGTH,
        validators: {
          'kiyeovo-offline': offlineMessageValidator,
          'kiyeovo-group-offline': groupOfflineMessageValidator,
          'kiyeovo-group-info-latest': groupInfoLatestValidator,
          'kiyeovo-group-info-v': groupInfoVersionedValidator,
        },
        selectors: {
          'kiyeovo-offline': offlineMessageSelector,
          'kiyeovo-group-offline': groupOfflineMessageSelector,
          'kiyeovo-group-info-latest': groupInfoLatestSelector,
        },
        validateUpdate: async (key, existing, incoming) => {
          const keyStr = new TextDecoder().decode(key);
          if (keyStr.startsWith('/kiyeovo-offline/')) {
            return offlineMessageValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith('/kiyeovo-group-offline/')) {
            return groupOfflineValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith('/kiyeovo-group-info-latest/')) {
            return groupInfoLatestValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith('/kiyeovo-group-info-v/')) {
            return groupInfoVersionedValidateUpdate(key, existing, incoming);
          }
        }
      }),
      identify: identify({
        runOnConnectionOpen: true
      }),
      ping: ping({
        timeout: torConfig.enabled ? 60000 : 10000,
      })
    }
  });

  await bootstrap.start();
  return bootstrap as ChatNode;
}

async function main(): Promise<void> {
  try {
    const bootstrap = await createBootstrapNode();
    console.log(`Bootstrap Peer ID: ${bootstrap.peerId.toString()}`);

    bootstrap.getMultiaddrs().forEach(addr => {
      console.log(`Listening on: ${addr.toString()}`);
    });

    bootstrap.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
      const peerId: PeerId = evt.detail;
      console.log(`Peer connected: ${peerId.toString()}`);
    });

    bootstrap.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
      const peerId: PeerId = evt.detail;
      console.log(`Peer disconnected: ${peerId.toString()}`);
    });

    console.log('Bootstrap node ready for connections...');

    // Graceful shutdown
    process.on('SIGINT', () => {
      void (async () => {
        console.log('\nShutting down bootstrap node...');
        await bootstrap.stop();
        process.exit(0);
      })();
    });

    process.on('SIGTERM', () => {
      void (async () => {
        console.log('\nShutting down bootstrap node...');
        await bootstrap.stop();
        process.exit(0);
      })();
    });


  } catch (err: unknown) {
    console.error('Failed to start bootstrap node:', err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(console.error); 