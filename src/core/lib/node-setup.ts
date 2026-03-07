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
import type { PeerId, PeerInfo, Transport } from '@libp2p/interface';

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
  groupInfoVersionedValidator, groupInfoVersionedValidateUpdate,
} from './group/group-dht-validator.js';
import dotenv from 'dotenv';
import {
  DHT_KEY_PREFIXES,
  DHT_NAMESPACE_NAMES,
  K_BUCKET_SIZE,
  NETWORK_MODE_BOOTSTRAP_ENV_KEYS,
  NETWORK_MODE_RELAY_ENV_KEYS,
  NETWORK_MODES,
  PREFIX_LENGTH,
  getNetworkModeConfig,
  getTorConfig,
} from '../constants.js';
import { filterOnionAddressesMapper } from '../utils/miscellaneous.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { createConnectionGater } from './connection-gater.js';
import { ChatDatabase } from './db/database.js';
import { tcp, type TCPComponents } from '@libp2p/tcp';
import { torTransport, validateTorConnection, type TorTransportComponents } from './tor-transport.js';

dotenv.config();

type RelayRuntime = {
  relayTransportFactory: ReturnType<typeof circuitRelayTransport> | null;
  dcutrFactory: ((components: unknown) => unknown) | null;
};

type DhtAdmissionApi = {
  routingTable: { size: number };
  onPeerConnect: (peerData: PeerInfo) => Promise<void>;
};

function parseCommaSeparatedEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isOnionMultiaddr(addr: string): boolean {
  return addr.includes('/onion3/');
}

function getDhtAdmissionApi(node: ChatNode): DhtAdmissionApi | null {
  const dhtCandidate = node.services.dht as unknown as Partial<DhtAdmissionApi>;
  if (
    dhtCandidate == null
    || typeof dhtCandidate.onPeerConnect !== 'function'
    || dhtCandidate.routingTable == null
    || typeof dhtCandidate.routingTable.size !== 'number'
  ) {
    return null;
  }

  return dhtCandidate as DhtAdmissionApi;
}

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
      })
    ];
  }

  const transports: Array<(components: TCPComponents & TorTransportComponents) => Transport> = [tcp()];
  if (relayTransportFactory !== null) {
    transports.push(relayTransportFactory as (components: TCPComponents & TorTransportComponents) => Transport);
  }

  console.log(`[STACK][FAST] Tor disabled. relayTransport=${relayTransportFactory !== null ? 'enabled' : 'disabled'}`);
  return transports;
}

function getTorConfigFromSettings(database: ChatDatabase): ReturnType<typeof getTorConfig> {
  const base = getTorConfig();
  const get = (key: string) => database.getSetting(key);

  const networkMode = database.getNetworkMode();
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
    dnsResolution: (dnsResolution as 'tor' | 'system' | null) ?? base.dnsResolution
  };
}

export async function createChatNode(port: number, userIdentity: EncryptedUserIdentity, database: ChatDatabase): Promise<ChatNode> {
  try {
    if (port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port}. Must be between 1024-65535`);
    }

    // Use the libp2p private key from user identity (unified identity)
    const privateKey = userIdentity.getLibp2pPrivateKey();

    const listenAddress = `/ip4/0.0.0.0/tcp/${port}`;
    const networkMode = database.getNetworkMode();
    const isAnonymousMode = networkMode === NETWORK_MODES.ANONYMOUS;
    const modeConfig = getNetworkModeConfig(networkMode);
    const bootstrapEnvKey = NETWORK_MODE_BOOTSTRAP_ENV_KEYS[networkMode];
    const relayEnvKey = NETWORK_MODE_RELAY_ENV_KEYS[networkMode];
    const relayAddresses = relayEnvKey ? parseCommaSeparatedEnv(relayEnvKey) : [];

    const relayRuntime: RelayRuntime = networkMode === NETWORK_MODES.FAST
      ? {
          relayTransportFactory: circuitRelayTransport(),
          dcutrFactory: dcutr() as unknown as (components: unknown) => unknown,
        }
      : { relayTransportFactory: null, dcutrFactory: null };

    const torConfig = getTorConfigFromSettings(database);

    console.log(`[STACK] mode=${networkMode}`);
    console.log(`[STACK] protocol=${modeConfig.protocolName} dhtProtocol=${modeConfig.dhtProtocol}`);
    console.log(`[STACK] bootstrapEnv=${bootstrapEnvKey}`);
    console.log(`[STACK] transport=${isAnonymousMode ? 'tcp+tor-socks' : 'tcp+relay(+dcutr)'}`);
    console.log(`[STACK] relayEnv=${relayEnvKey ?? 'n/a'} relayConfigured=${relayAddresses.length}`);
    if (!isAnonymousMode) {
      console.log('[STACK][FAST] relay runtime loaded');
    }

    if (isAnonymousMode) {
      console.log('Tor transport enabled - routing through SOCKS5 proxy');
      console.log(`  Initial Proxy: ${torConfig.socksHost}:${torConfig.socksPort}`);

      // Extract first bootstrap node for health check if available
      const configuredBootstrapNodes = parseCommaSeparatedEnv(bootstrapEnvKey);
      const bootstrapTargets: Array<{ host: string, port: number }> = [];

      if (configuredBootstrapNodes.length > 0) {
        try {
          for (const nodeAddr of configuredBootstrapNodes) {
            if (!nodeAddr) continue;
            const ma = multiaddr(nodeAddr);
            const onionTuple = ma.getComponents().find(c => c.code === 445);
            if (!onionTuple?.value) continue;
            const [host, p] = onionTuple.value.split(':');
            if (!host || !p) continue;
            const portNum = parseInt(p, 10);
            if (!Number.isFinite(portNum)) continue;
            bootstrapTargets.push({ host: `${host}.onion`, port: portNum });
          }
        } catch { /* ignore invalid multiaddr */ }
      }

      // Validate Tor connectivity before proceeding
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

    const announceAddrs: string[] = [];

    // Check for onion address in database (set by TorManager)
    const onionAddress = database.getSetting('tor_onion_address');
    if (isAnonymousMode && onionAddress) {
      // Construct announce address from stored onion address
      // Format: /onion3/<address-without-.onion>:<port>
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

    // Also check environment variable (fallback/override)
    if (process.env.ANNOUNCE_ADDRS) {
      const rawAddrs = process.env.ANNOUNCE_ADDRS.split(',').map(addr => addr.trim()).filter(Boolean);
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

    const node = await createLibp2p({
      privateKey: privateKey,
      addresses: {
        listen: [listenAddress],
        announce: isAnonymousMode ? announceAddrs : []
      },
      transports: transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: 100,
      },
      connectionMonitor: {
        enabled: true,
        pingInterval: isAnonymousMode ? 120000 : 30000,  // 2 minutes for Tor, 30s for local
        pingTimeout: {
          minTimeout: isAnonymousMode ? 30000 : 5000,    // 30s for Tor, 5s for local
          maxTimeout: isAnonymousMode ? 120000 : 30000,  // 2 min for Tor, 30s for local
        },
        abortConnectionOnPingFailure: !isAnonymousMode,  // Don't abort on Tor, do on local
      },
      connectionGater: createConnectionGater(database),
      services: {
        // TODO research kad dodes na grupe
        pubsub: gossipsub(
          { emitSelf: false }
        ),
        dht: kadDHT({
          protocol: modeConfig.dhtProtocol,
          peerInfoMapper: isAnonymousMode ? filterOnionAddressesMapper : passthroughMapper,
          clientMode: false,
          kBucketSize: K_BUCKET_SIZE,
          prefixLength: PREFIX_LENGTH,
          validators: {
            [DHT_NAMESPACE_NAMES.offline]: offlineMessageValidator,
            [DHT_NAMESPACE_NAMES.username]: usernameRegistrationValidator,
            [DHT_NAMESPACE_NAMES.groupOffline]: groupOfflineMessageValidator,
            [DHT_NAMESPACE_NAMES.groupInfoLatest]: groupInfoLatestValidator,
            [DHT_NAMESPACE_NAMES.groupInfoVersion]: groupInfoVersionedValidator,
          },
          selectors: {
            [DHT_NAMESPACE_NAMES.offline]: offlineMessageSelector,
            [DHT_NAMESPACE_NAMES.username]: usernameRegistrationSelector,
            [DHT_NAMESPACE_NAMES.groupOffline]: groupOfflineMessageSelector,
            [DHT_NAMESPACE_NAMES.groupInfoLatest]: groupInfoLatestSelector,
          },
          validateUpdate: async (key, existing, incoming) => {
            const keyStr = new TextDecoder().decode(key);
            if (keyStr.startsWith(DHT_KEY_PREFIXES.offline)) {
              return offlineMessageValidateUpdate(key, existing, incoming);
            }
            if (keyStr.startsWith(DHT_KEY_PREFIXES.username)) {
              return usernameRegistrationValidateUpdate(key, existing, incoming);
            }
            if (keyStr.startsWith(DHT_KEY_PREFIXES.groupOffline)) {
              return groupOfflineValidateUpdate(key, existing, incoming);
            }
            if (keyStr.startsWith(DHT_KEY_PREFIXES.groupInfoLatest)) {
              return groupInfoLatestValidateUpdate(key, existing, incoming);
            }
            if (keyStr.startsWith(DHT_KEY_PREFIXES.groupInfoVersion)) {
              return groupInfoVersionedValidateUpdate(key, existing, incoming);
            }
          }
        }),
        identify: identify({
          runOnConnectionOpen: true
        }),
        ping: ping({
          // Longer timeout for Tor (default is too aggressive)
          timeout: isAnonymousMode ? 60000 : 10000,
        }),
        ...(networkMode === NETWORK_MODES.FAST && relayRuntime.dcutrFactory
          ? {
              dcutr: relayRuntime.dcutrFactory
            }
          : {})
      }
    });

    await node.start();
    return node as ChatNode;
  } catch (error: unknown) {
    generalErrorHandler(error);
    throw error;
  }
}

export async function connectToBootstrap(node: ChatNode, database: ChatDatabase): Promise<void> {
  database.clearAllBootstrapNodeStatus();

  const networkMode = database.getNetworkMode();
  const bootstrapEnvKey = NETWORK_MODE_BOOTSTRAP_ENV_KEYS[networkMode];
  const relayEnvKey = NETWORK_MODE_RELAY_ENV_KEYS[networkMode];

  const dedupe = (values: string[]) => Array.from(new Set(values));
  const filterByMode = (values: string[]) => {
    if (networkMode === NETWORK_MODES.ANONYMOUS) {
      console.log('TOR enabled: ignoring non-onion bootstrap addresses');
      return values.filter(isOnionMultiaddr);
    }
    const filtered = values.filter(addr => !isOnionMultiaddr(addr));
    const ignored = values.length - filtered.length;
    if (ignored > 0) {
      console.log(`[STACK][FAST] ignoring ${ignored} onion bootstrap addresses`);
    }
    return filtered;
  };

  const dbAddresses = database.getBootstrapNodes()
    .map(bootstrapNode => bootstrapNode.address)
    .filter(addr => addr !== node.peerId.toString());
  const envAddresses = parseCommaSeparatedEnv(bootstrapEnvKey)
    .filter(addr => addr !== node.peerId.toString());

  let addressesToTry = filterByMode(dedupe([
    ...dbAddresses,
    ...envAddresses,
  ]));

  const fastRelayAddrs = relayEnvKey ? parseCommaSeparatedEnv(relayEnvKey) : [];

  const dialFastRelays = async (): Promise<void> => {
    if (networkMode !== NETWORK_MODES.FAST || fastRelayAddrs.length === 0) {
      return;
    }

    const concurrency = Math.min(5, fastRelayAddrs.length);
    console.log(`[STACK][FAST] attempting deterministic relay dials count=${fastRelayAddrs.length} concurrency=${concurrency}`);
    let connected = 0;
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < fastRelayAddrs.length) {
        const relayAddr = fastRelayAddrs[cursor++];
        try {
          await node.dial(multiaddr(relayAddr));
          connected++;
          console.log(`[STACK][FAST][RELAY] connected ${relayAddr}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown';
          console.warn(`[STACK][FAST][RELAY] failed ${relayAddr} reason=${reason}`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    console.log(`[STACK][FAST][RELAY] connected=${connected}/${fastRelayAddrs.length}`);
  };

  if (addressesToTry.length === 0 && envAddresses.length > 0) {
    // Defensive fallback in case DB entries are stale for current mode.
    addressesToTry = filterByMode(envAddresses);
  }

  if (addressesToTry.length === 0) {
    console.log(`[STACK] No bootstrap addresses configured for mode=${networkMode}.`);
    await dialFastRelays();
    // Status will be sent by periodic peer count checker
    return;
  }

  console.log(`Attempting to connect to bootstrap nodes... mode=${networkMode} envKey=${bootstrapEnvKey}`);

  const probeDhtAdmission = async (remotePeer: PeerId | undefined): Promise<void> => {
    try {
      const dhtAdmission = getDhtAdmissionApi(node);
      if (!dhtAdmission || !remotePeer) {
        return;
      }

      const peerInfo = await node.peerStore.get(remotePeer);
      const multiaddrs = (peerInfo.addresses ?? []).map((entry) => entry.multiaddr);

      await dhtAdmission.onPeerConnect({
        id: remotePeer,
        multiaddrs,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[BOOTSTRAP] DHT admission probe failed: ${message}`);
    }
  };

  for (const addr of addressesToTry) {
    try {
      console.log(`Trying bootstrap: ${addr}`);
      const ma = multiaddr(addr);
      // eslint-disable-next-line no-await-in-loop
      const connection = await node.dial(ma);
      console.log(`Connected to bootstrap peer: ${addr}`);
      database.updateBootstrapNodeStatus(addr, true);
      await probeDhtAdmission(connection?.remotePeer);
      await dialFastRelays();

      return;

    } catch (err: unknown) {
      generalErrorHandler(err);
      database.updateBootstrapNodeStatus(addr, false);
    }
  }

  console.log('No hardcoded bootstrap nodes available.');
  await dialFastRelays();
  // Status will be sent by periodic peer count checker
} 
