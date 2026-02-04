import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import type { Transport } from '@libp2p/interface';

import type { ChatNode } from '../types.js';

import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { offlineMessageValidator, offlineMessageSelector } from './offline-message-validator.js';
import dotenv from 'dotenv';
import {
  DHT_PROTOCOL,
  K_BUCKET_SIZE,
  PREFIX_LENGTH,
  getTorConfig,
} from '../constants.js';
import { filterOnionAddressesMapper } from '../utils/miscellaneous.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { createConnectionGater } from './connection-gater.js';
import { ChatDatabase } from './db/database.js';
import { tcp, type TCPComponents } from '@libp2p/tcp';
import { torTransport, validateTorConnection, type TorTransportComponents } from './tor-transport.js';

dotenv.config();

export function createTransportArray(torConfig: ReturnType<typeof getTorConfig>):
    Array<(components: TCPComponents & TorTransportComponents) => Transport> {
  if (torConfig.enabled) {
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
  } else {
    console.log('WARNING: Tor is disabled, using direct TCP transport');
    return [tcp()];
  }
}

function getTorConfigFromSettings(database: ChatDatabase): ReturnType<typeof getTorConfig> {
  const base = getTorConfig();
  const get = (key: string) => database.getSetting(key);

  const enabled = get('tor_enabled');
  const socksHost = get('tor_socks_host');
  const socksPort = get('tor_socks_port');
  const connectionTimeout = get('tor_connection_timeout');
  const circuitTimeout = get('tor_circuit_timeout');
  const maxRetries = get('tor_max_retries');
  const healthCheckInterval = get('tor_health_check_interval');
  const dnsResolution = get('tor_dns_resolution');

  return {
    enabled: enabled === null ? base.enabled : enabled === 'true',
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
    const torConfig = getTorConfigFromSettings(database);

    if (torConfig.enabled) {
      console.log('Tor transport enabled - routing through SOCKS5 proxy');
      console.log(`  Initial Proxy: ${torConfig.socksHost}:${torConfig.socksPort}`);

      // Extract first bootstrap node for health check if available
      const KNOWN_BOOTSTRAP_NODES = process.env.KNOWN_BOOTSTRAP_NODES ? process.env.KNOWN_BOOTSTRAP_NODES.split(',').map(addr => addr.trim()).filter(Boolean) : [];
      const bootstrapTargets: Array<{ host: string, port: number }> = [];

      if (KNOWN_BOOTSTRAP_NODES.length > 0) {
        try {
          for (const nodeAddr of KNOWN_BOOTSTRAP_NODES) {
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
      console.log('Using direct TCP transport');
    }

    const transports = createTransportArray(torConfig);

    const announceAddrs: string[] = [];

    if (process.env.ANNOUNCE_ADDRS) {
      const rawAddrs = process.env.ANNOUNCE_ADDRS.split(',').map(addr => addr.trim()).filter(Boolean);
      for (const addr of rawAddrs) {
        try {
          multiaddr(addr);
          announceAddrs.push(addr);
        } catch {
          console.warn(`Invalid announce address ignored: ${addr}`);
        }
      }
    }

    const node = await createLibp2p({
      privateKey: privateKey,
      addresses: {
        listen: [listenAddress],
        announce: torConfig.enabled ? announceAddrs : []
      },
      transports: transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: 100,
      },
      connectionGater: createConnectionGater(database),
      // peerDiscovery: [mdns()],
      services: {
        // TODO research kad dodes na grupe
        pubsub: gossipsub(),
        dht: kadDHT({
          protocol: DHT_PROTOCOL,
          peerInfoMapper: torConfig.enabled ? filterOnionAddressesMapper : removePublicAddressesMapper,
          clientMode: false,
          kBucketSize: K_BUCKET_SIZE,
          prefixLength: PREFIX_LENGTH,
          // DHT validators: verify write authorization for offline message buckets
          validators: {
            'kiyeovo-offline': offlineMessageValidator
          },
          // DHT selectors: choose best record when multiple exist
          selectors: {
            'kiyeovo-offline': offlineMessageSelector
          }
        }),
        identify: identify({
          runOnConnectionOpen: true
        }),
        ping: ping()
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

  let addressesToTry = database.getBootstrapNodes()
    .map(bootstrapNode => bootstrapNode.address)
    .filter(addr => addr !== node.peerId.toString());

  // In Tor mode, only use onion bootstrap addresses to avoid Tor exit failures
  const torCfg = getTorConfigFromSettings(database);
  if (torCfg.enabled) {
    const onionAddrs = addressesToTry.filter(a => a.includes('/onion3/'));
    console.log('TOR enabled: ignoring non-onion bootstrap addresses');
    addressesToTry = onionAddrs;
  }

  if (addressesToTry.length === 0) {
    console.log('No bootstrap addresses configured. YOU ARE ALONE IN THE DARK!');
    // Status will be sent by periodic peer count checker
    return;
  }

  console.log('Attempting to connect to bootstrap nodes...');

  for (const addr of addressesToTry) {
    try {
      console.log(`Trying bootstrap: ${addr}`);
      const ma = multiaddr(addr);
      // eslint-disable-next-line no-await-in-loop
      await node.dial(ma);
      console.log(`Connected to bootstrap peer: ${addr}`);
      database.updateBootstrapNodeStatus(addr, true);

      return;

    } catch (err: unknown) {
      generalErrorHandler(err);
      database.updateBootstrapNodeStatus(addr, false);
    }
  }

  console.log('No hardcoded bootstrap nodes available.');
  // Status will be sent by periodic peer count checker
} 
