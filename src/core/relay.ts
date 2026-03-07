import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import dotenv from 'dotenv';

import type { PeerId } from '@libp2p/interface';

import { PeerIdManager } from './lib/peer-id-manager.js';

dotenv.config();

const DEFAULT_RELAY_PEER_ID_FILE = './relay-peer-id.bin';
const DEFAULT_RELAY_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/4002';

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAnnounceAddrs(): string[] {
  const raw = (process.env.RELAY_ANNOUNCE_ADDRS ?? '')
    .split(',')
    .map(addr => addr.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const addr of raw) {
    try {
      multiaddr(addr);
      out.push(addr);
    } catch {
      console.warn(`[RELAY] Invalid announce address ignored: ${addr}`);
    }
  }
  return out;
}

async function createRelayNode() {
  const peerIdFile = process.env.RELAY_PEER_ID_FILE?.trim() || DEFAULT_RELAY_PEER_ID_FILE;
  const listenAddress = process.env.RELAY_LISTEN_ADDRESS?.trim() || DEFAULT_RELAY_LISTEN_ADDRESS;
  const announceAddrs = parseAnnounceAddrs();

  const maxReservations = parseOptionalPositiveInt(process.env.RELAY_MAX_RESERVATIONS);
  const reservationTtl = parseOptionalPositiveInt(process.env.RELAY_RESERVATION_TTL_MS);
  const defaultDurationLimit = parseOptionalPositiveInt(process.env.RELAY_DEFAULT_DURATION_LIMIT_MS);
  const defaultDataLimit = parseOptionalPositiveInt(process.env.RELAY_DEFAULT_DATA_LIMIT_BYTES);

  const { privateKey } = await PeerIdManager.loadOrCreate(peerIdFile);

  console.log('[STACK][RELAY] mode=fast');
  console.log(`[STACK][RELAY] listen=${listenAddress}`);
  console.log(`[STACK][RELAY] announceCount=${announceAddrs.length}`);
  console.log(`[STACK][RELAY] maxReservations=${maxReservations ?? 'default'}`);
  console.log(`[STACK][RELAY] reservationTtlMs=${reservationTtl ?? 'default'}`);
  console.log(`[STACK][RELAY] durationLimitMs=${defaultDurationLimit ?? 'default'}`);
  console.log(`[STACK][RELAY] dataLimitBytes=${defaultDataLimit ?? 'default'}`);

  const relay = await createLibp2p({
    privateKey,
    addresses: {
      listen: [listenAddress],
      announce: announceAddrs,
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 1000,
      maxPeerAddrsToDial: 20,
    },
    services: {
      identify: identify({
        runOnConnectionOpen: true,
      }),
      ping: ping({
        timeout: 10000,
      }),
      circuitRelay: circuitRelayServer({
        reservations: {
          ...(maxReservations != null ? { maxReservations } : {}),
          ...(reservationTtl != null ? { reservationTtl } : {}),
          ...(defaultDurationLimit != null ? { defaultDurationLimit } : {}),
          ...(defaultDataLimit != null ? { defaultDataLimit: BigInt(defaultDataLimit) } : {}),
        },
      }),
    },
  });

  await relay.start();
  return relay;
}

async function main(): Promise<void> {
  try {
    const relay = await createRelayNode();
    console.log(`Relay Peer ID: ${relay.peerId.toString()}`);

    relay.getMultiaddrs().forEach(addr => {
      console.log(`Listening on: ${addr.toString()}`);
    });

    relay.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
      console.log(`Peer connected: ${evt.detail.toString()}`);
    });

    relay.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
      console.log(`Peer disconnected: ${evt.detail.toString()}`);
    });

    console.log('Relay node ready for reservations...');

    process.on('SIGINT', () => {
      void (async () => {
        console.log('\nShutting down relay node...');
        await relay.stop();
        process.exit(0);
      })();
    });

    process.on('SIGTERM', () => {
      void (async () => {
        console.log('\nShutting down relay node...');
        await relay.stop();
        process.exit(0);
      })();
    });
  } catch (err: unknown) {
    console.error('Failed to start relay node:', err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(console.error);
