import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { multiaddr } from '@multiformats/multiaddr';
import { tcp, type TCPComponents } from '@libp2p/tcp';
import type { Transport } from '@libp2p/interface';

import type { ChatNode, NetworkMode } from '../types.js';

import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { offlineMessageValidator, offlineMessageSelector, offlineMessageValidateUpdate } from './offline-message-validator.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from './username-dht-validator.js';
import {
  groupOfflineMessageValidator, groupOfflineMessageSelector, groupOfflineValidateUpdate,
  groupInfoLatestValidator, groupInfoLatestSelector, groupInfoLatestValidateUpdate,
  groupInfoVersionedValidator, groupInfoVersionedSelector, groupInfoVersionedValidateUpdate,
} from './group/group-dht-validator.js';
import {
  K_BUCKET_SIZE,
  NETWORK_MODES,
  PREFIX_LENGTH,
  getNetworkModeConfig,
  getNetworkModeRuntime,
  getTorConfig,
} from '../constants.js';
import { filterOnionAddressesMapper } from '../utils/miscellaneous.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { createConnectionGater } from './connection-gater.js';
import { ChatDatabase } from './db/database.js';
import { torTransport, validateTorConnection, type TorTransportComponents } from './tor-transport.js';
import { resolveBootstrapAddressesForCurrentMode, extractTorBootstrapTargets } from './node-bootstrap.js';
import { getConfiguredFastRelayAddrs } from './node-relays.js';

type RelayRuntime = {
  relayTransportFactory: ReturnType<typeof circuitRelayTransport> | null;
  dcutrFactory: ((components: unknown) => unknown) | null;
};

export function createTransportArray(params: {
  networkMode: NetworkMode;
  torConfig: ReturnType<typeof getTorConfig>;
  relayTransportFactory: ReturnType<typeof circuitRelayTransport> | null;
}): Array<(components: TCPComponents & TorTransportComponents) => Transport> {
  const { networkMode, torConfig, relayTransportFactory } = params;

  if (networkMode === NETWORK_MODES.ANONYMOUS) {
    // When Tor is enabled, we need both TCP (for listening) and Tor (for dialing)
    return [
      tcp(),
      torTransport({
        socksProxy: {
          host: torConfig.socksHost,
          port: torConfig.socksPort,
        },
        connectionTimeout: torConfig.connectionTimeout,
        maxRetries: torConfig.maxRetries,
      }),
    ];
  }

  const transports: Array<(components: TCPComponents & TorTransportComponents) => Transport> = [tcp()];
  if (relayTransportFactory !== null) {
    transports.push(relayTransportFactory as (components: TCPComponents & TorTransportComponents) => Transport);
  }

  console.log(`[STACK][FAST] Tor disabled. relayTransport=${relayTransportFactory !== null ? 'enabled' : 'disabled'}`);
  return transports;
}

function getFastModeListenAddrs(port: number): string[] {
  return [`/ip4/0.0.0.0/tcp/${port}`, '/p2p-circuit'];
}

function getTorConfigFromSettings(database: ChatDatabase): ReturnType<typeof getTorConfig> {
  const base = getTorConfig();
  const get = (key: string) => database.getSetting(key);

  const socksHost = get('tor_socks_host');
  const socksPort = get('tor_socks_port');
  const connectionTimeout = get('tor_connection_timeout');
  const circuitTimeout = get('tor_circuit_timeout');
  const maxRetries = get('tor_max_retries');
  const healthCheckInterval = get('tor_health_check_interval');
  const dnsResolution = get('tor_dns_resolution');

  return {
    socksHost: socksHost ?? base.socksHost,
    socksPort: socksPort ? parseInt(socksPort, 10) : base.socksPort,
    connectionTimeout: connectionTimeout ? parseInt(connectionTimeout, 10) : base.connectionTimeout,
    circuitTimeout: circuitTimeout ? parseInt(circuitTimeout, 10) : base.circuitTimeout,
    maxRetries: maxRetries ? parseInt(maxRetries, 10) : base.maxRetries,
    healthCheckInterval: healthCheckInterval ? parseInt(healthCheckInterval, 10) : base.healthCheckInterval,
    dnsResolution: (dnsResolution as 'tor' | 'system' | null) ?? base.dnsResolution,
  };
}

function getAnnounceAddresses(
  database: ChatDatabase,
  networkMode: NetworkMode,
  port: number,
): string[] {
  const announceAddrs: string[] = [];
  const onionAddress = database.getSetting('tor_onion_address');

  if (networkMode === NETWORK_MODES.ANONYMOUS && onionAddress) {
    const onionHost = onionAddress.replace('.onion', '');
    const announceAddr = `/onion3/${onionHost}:${port}`;
    try {
      multiaddr(announceAddr);
      announceAddrs.push(announceAddr);
      console.log(`Using onion announce address: ${announceAddr}`);
    } catch {
      console.warn(`Invalid onion announce address ignored: ${announceAddr}`);
    }
  }

  if (process.env.ANNOUNCE_ADDRS) {
    const rawAddrs = process.env.ANNOUNCE_ADDRS.split(',').map((addr) => addr.trim()).filter(Boolean);
    for (const addr of rawAddrs) {
      try {
        multiaddr(addr);
        if (!announceAddrs.includes(addr)) {
          announceAddrs.push(addr);
        }
      } catch {
        console.warn(`Invalid announce address ignored: ${addr}`);
      }
    }
  }

  return announceAddrs;
}

export async function createChatNode(
  port: number,
  userIdentity: EncryptedUserIdentity,
  database: ChatDatabase,
): Promise<ChatNode> {
  try {
    if (port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port}. Must be between 1024-65535`);
    }

    const privateKey = userIdentity.getLibp2pPrivateKey();
    const networkMode = database.getSessionNetworkMode();
    const isAnonymousMode = networkMode === NETWORK_MODES.ANONYMOUS;
    const modeConfig = getNetworkModeConfig(networkMode);
    const modeRuntime = getNetworkModeRuntime(networkMode);
    const bootstrapResolution = resolveBootstrapAddressesForCurrentMode(database);
    const relayConfig = networkMode === NETWORK_MODES.FAST
      ? getConfiguredFastRelayAddrs(database)
      : { addresses: [], source: 'none' as const };
    const relayRuntime: RelayRuntime = networkMode === NETWORK_MODES.FAST
      ? {
          relayTransportFactory: circuitRelayTransport(),
          dcutrFactory: dcutr() as unknown as (components: unknown) => unknown,
        }
      : { relayTransportFactory: null, dcutrFactory: null };
    const torConfig = getTorConfigFromSettings(database);

    console.log(`[STACK] mode=${networkMode}`);
    console.log(`[STACK] protocol=${modeConfig.protocolName} dhtProtocol=${modeConfig.dhtProtocol}`);
    console.log(`[STACK] bootstrapConfigured=${bootstrapResolution.addresses.length}`);
    console.log(`[STACK] transport=${isAnonymousMode ? 'tcp+tor-socks' : 'tcp+relay(+dcutr)'}`);
    console.log(`[STACK] relaySource=${relayConfig.source} relayConfigured=${relayConfig.addresses.length}`);
    if (!isAnonymousMode) {
      console.log('[STACK][FAST] relay runtime loaded');
    }

    if (isAnonymousMode) {
      console.log('Tor transport enabled - routing through SOCKS5 proxy');
      console.log(`  Initial Proxy: ${torConfig.socksHost}:${torConfig.socksPort}`);

      const bootstrapTargets = extractTorBootstrapTargets(bootstrapResolution.addresses);
      console.log('Validating Tor connectivity...');
      const { available: torAvailable } = await validateTorConnection({
        socksProxy: {
          host: torConfig.socksHost,
          port: torConfig.socksPort,
        },
        connectionTimeout: torConfig.connectionTimeout,
        maxRetries: torConfig.maxRetries,
      }, bootstrapTargets);

      if (!torAvailable) {
        console.error('WARNING: Tor connectivity check failed!');
        console.error(`  Make sure Tor is running and accessible via ${torConfig.socksHost}:${torConfig.socksPort}`);
        console.error('  Continuing anyway, but connections may fail...');
      } else {
        console.log('✓ Tor connectivity validated');
      }
    } else {
      console.log('Fast mode selected: using direct TCP + relay/DCUtR path');
    }

    const transports = createTransportArray({
      networkMode,
      torConfig,
      relayTransportFactory: relayRuntime.relayTransportFactory,
    });
    const announceAddrs = getAnnounceAddresses(database, networkMode, port);
    const listenAddrs = isAnonymousMode ? [`/ip4/0.0.0.0/tcp/${port}`] : getFastModeListenAddrs(port);

    const node = await createLibp2p({
      privateKey,
      addresses: {
        listen: listenAddrs,
        announce: isAnonymousMode ? announceAddrs : [],
      },
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: 100,
      },
      connectionMonitor: {
        enabled: true,
        pingInterval: isAnonymousMode ? 120000 : 30000,
        pingTimeout: {
          minTimeout: isAnonymousMode ? 30000 : 5000,
          maxTimeout: isAnonymousMode ? 120000 : 30000,
        },
        abortConnectionOnPingFailure: false,
      },
      connectionGater: createConnectionGater(database),
      services: {
        pubsub: gossipsub({
          emitSelf: false,
          runOnLimitedConnection: true,
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
              `[MODE-GUARD][REJECT][dht_validate_update] mode=${networkMode} reason=unknown_namespace key=${keyStr}`
            );
            throw new Error('cross_mode_dht_key_rejected');
          },
        }),
        identify: identify({
          runOnConnectionOpen: true,
        }),
        ping: ping({
          timeout: isAnonymousMode ? 60000 : 10000,
        }),
        ...(networkMode === NETWORK_MODES.FAST && relayRuntime.dcutrFactory
          ? { dcutr: relayRuntime.dcutrFactory }
          : {}),
      },
    });

    await node.start();
    return node as ChatNode;
  } catch (error: unknown) {
    generalErrorHandler(error);
    throw error;
  }
}
