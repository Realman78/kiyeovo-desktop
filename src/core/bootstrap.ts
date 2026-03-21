import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
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
  DEFAULT_NETWORK_MODE,
  K_BUCKET_SIZE,
  NETWORK_MODES,
  PREFIX_LENGTH,
  BOOTSTRAP_PEER_ID_FILE,
  getTorConfig,
  getNetworkModeConfig,
  getNetworkModeRuntime,
  isNetworkMode,
} from './constants.js';
import { filterOnionAddressesMapper } from './utils/miscellaneous.js';
import { offlineMessageSelector, offlineMessageValidateUpdate, offlineMessageValidator } from './lib/offline-message-validator.js';
import { groupOfflineMessageValidator, groupInfoLatestValidator, groupInfoVersionedValidator, groupOfflineMessageSelector, groupInfoLatestSelector, groupInfoVersionedSelector, groupOfflineValidateUpdate, groupInfoLatestValidateUpdate, groupInfoVersionedValidateUpdate } from './lib/group/group-dht-validator.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from './lib/username-dht-validator.js';

dotenv.config();

function readBootstrapNetworkMode(): 'fast' | 'anonymous' {
  const raw = process.env.BOOTSTRAP_NETWORK_MODE?.trim().toLowerCase();
  if (isNetworkMode(raw)) {
    return raw;
  }

  if (raw) {
    console.warn(`[STACK][BOOTSTRAP] invalid BOOTSTRAP_NETWORK_MODE="${raw}", defaulting to ${DEFAULT_NETWORK_MODE}`);
  }

  return DEFAULT_NETWORK_MODE;
}

async function createBootstrapNode(): Promise<ChatNode> {
  const { privateKey } = await PeerIdManager.loadOrCreate(BOOTSTRAP_PEER_ID_FILE);
  const networkMode = readBootstrapNetworkMode();
  const modeConfig = getNetworkModeConfig(networkMode);
  const modeRuntime = getNetworkModeRuntime(networkMode);
  const torConfig = getTorConfig();
  const isAnonymousMode = networkMode === NETWORK_MODES.ANONYMOUS;

  const announceAddrs: string[] = [];
  if (process.env.BOOTSTRAP_ANNOUNCE_ADDRS) {
    const rawAddrs = process.env.BOOTSTRAP_ANNOUNCE_ADDRS.split(',').map(addr => addr.trim()).filter(Boolean);

    for (const addr of rawAddrs) {
      try {
        const ma = multiaddr(addr);
        const protocols = ma.getComponents().map(c => c.code);
        const isOnion = protocols.includes(445);

        if (isOnion) {
          // Validate onion address format
          const onionTuple = ma.getComponents().find(c => c.code === 445);
          if (onionTuple?.value) {
            const [onionHost] = onionTuple.value.split(':');
            if (onionHost && !/^[a-z2-7]{56}$/i.test(onionHost)) {
              console.warn(`[BOOTSTRAP] Invalid onion v3 address ignored: ${addr} (must be 56 characters base32)`);
              continue;
            }
          }
        }

        if (isAnonymousMode && !isOnion) {
          console.warn(`[STACK][BOOTSTRAP] ignoring non-onion announce address in anonymous mode: ${addr}`);
          continue;
        }

        if (!isAnonymousMode && isOnion) {
          console.warn(`[STACK][BOOTSTRAP] ignoring onion announce address in fast mode: ${addr}`);
          continue;
        }

        announceAddrs.push(addr);
      } catch {
        console.warn(`[BOOTSTRAP] Invalid announce address ignored: ${addr}`);
      }
    }
  }

  if (isAnonymousMode && announceAddrs.length === 0) {
    console.warn('[STACK][BOOTSTRAP] anonymous mode configured without onion announce addresses');
  }

  console.log(`[STACK][BOOTSTRAP] mode=${networkMode}`);
  console.log(`[STACK][BOOTSTRAP] transport=tcp`);
  console.log(`[STACK][BOOTSTRAP] dhtProtocol=${modeConfig.dhtProtocol}`);
  console.log(`[STACK][BOOTSTRAP] announceCount=${announceAddrs.length}`);
  console.log(`[STACK][BOOTSTRAP] tor_defaults_proxy=${torConfig.socksHost}:${torConfig.socksPort}`);

  const transports = [tcp()];

  if (isAnonymousMode) {
    console.log('Bootstrap: anonymous mode enabled (onion-only announce filtering active)');
    console.log(`Bootstrap: Tor proxy defaults ${torConfig.socksHost}:${torConfig.socksPort}`);
  } else {
    console.log('Bootstrap: fast mode enabled (non-onion announce filtering active)');
  }

  const bootstrap = await createLibp2p({
    privateKey: privateKey,
    addresses: {
      listen: [BOOTSTRAP_LISTEN_ADDRESS],
      announce: announceAddrs
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
      pingInterval: isAnonymousMode ? 120000 : 30000,
      pingTimeout: {
        minTimeout: isAnonymousMode ? 30000 : 5000,
        maxTimeout: isAnonymousMode ? 120000 : 30000,
      },
      // Keep connections alive on transient ping misses; periodic health checker handles reconnect policy.
      abortConnectionOnPingFailure: false,
    },
    services: {
      pubsub: gossipsub({
        doPX: true,
        fallbackToFloodsub: false,
        allowPublishToZeroTopicPeers: false,
      }),
      dht: kadDHT({
        protocol: modeConfig.dhtProtocol,
        peerInfoMapper: isAnonymousMode ? filterOnionAddressesMapper : passthroughMapper,
        clientMode: false,
        kBucketSize: K_BUCKET_SIZE,
        prefixLength: PREFIX_LENGTH,
        validators: {
          [modeRuntime.dhtNamespaceNames.offline]: offlineMessageValidator,
          [modeRuntime.dhtNamespaceNames.username]: usernameRegistrationValidator,
          [modeRuntime.dhtNamespaceNames.groupOffline]: groupOfflineMessageValidator,
          [modeRuntime.dhtNamespaceNames.groupInfoLatest]: groupInfoLatestValidator,
          [modeRuntime.dhtNamespaceNames.groupInfoVersion]: groupInfoVersionedValidator,
        },
        selectors: {
          [modeRuntime.dhtNamespaceNames.offline]: offlineMessageSelector,
          [modeRuntime.dhtNamespaceNames.username]: usernameRegistrationSelector,
          [modeRuntime.dhtNamespaceNames.groupOffline]: groupOfflineMessageSelector,
          [modeRuntime.dhtNamespaceNames.groupInfoLatest]: groupInfoLatestSelector,
          [modeRuntime.dhtNamespaceNames.groupInfoVersion]: groupInfoVersionedSelector,
        },
        validateUpdate: async (key, existing, incoming) => {
          const keyStr = new TextDecoder().decode(key);
          if (keyStr.startsWith(modeRuntime.dhtKeyPrefixes.offline)) {
            return offlineMessageValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith(modeRuntime.dhtKeyPrefixes.username)) {
            return usernameRegistrationValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith(modeRuntime.dhtKeyPrefixes.groupOffline)) {
            return groupOfflineValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith(modeRuntime.dhtKeyPrefixes.groupInfoLatest)) {
            return groupInfoLatestValidateUpdate(key, existing, incoming);
          }
          if (keyStr.startsWith(modeRuntime.dhtKeyPrefixes.groupInfoVersion)) {
            return groupInfoVersionedValidateUpdate(key, existing, incoming);
          }
          console.warn(
            `[MODE-GUARD][REJECT][dht_validate_update][bootstrap] mode=${networkMode} reason=unknown_namespace key=${keyStr}`
          );
          throw new Error('cross_mode_dht_key_rejected');
        }
      }),
      identify: identify({
        runOnConnectionOpen: true
      }),
      ping: ping({
        timeout: isAnonymousMode ? 60000 : 10000,
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
