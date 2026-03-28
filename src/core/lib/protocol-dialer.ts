import type { PeerId, Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';

import type { ChatNode } from '../types.js';
import { NETWORK_MODES, getNetworkModeConfig } from '../constants.js';
import type { ChatDatabase } from './db/database.js';
import { getConfiguredFastRelayAddrs } from './node-relays.js';

const PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS = 2_000;

type DialProtocolWithRelayFallbackParams = {
  node: ChatNode;
  database: ChatDatabase;
  targetPeerId: PeerId;
  protocol: string;
  context: string;
};

function isPrivateHost(host: string): boolean {
  return /^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host) ||
    /^::1$/i.test(host);
}

function extractIpHost(address: string): string | null {
  const matched = address.match(/\/(?:ip4|ip6)\/([^/]+)/);
  return matched?.[1] ?? null;
}

function isDirectAddressPrivateOnly(address: string): boolean {
  if (address.includes('/p2p-circuit')) {
    return false;
  }

  const host = extractIpHost(address);
  if (host === null) {
    return false;
  }

  return isPrivateHost(host);
}

async function shouldUseShortDirectTimeout(node: ChatNode, targetPeerId: PeerId): Promise<boolean> {
  const targetPeer = targetPeerId.toString();
  const hasActiveConnection = node.getConnections().some((connection) => connection.remotePeer.toString() === targetPeer);
  if (hasActiveConnection) {
    return false;
  }

  try {
    const peerData = await node.peerStore.get(targetPeerId);
    const knownAddresses = (peerData.addresses ?? []).map((entry) => entry.multiaddr.toString());
    const directAddresses = knownAddresses.filter((address) => !address.includes('/p2p-circuit'));
    if (directAddresses.length === 0) {
      return false;
    }

    return directAddresses.every(isDirectAddressPrivateOnly);
  } catch {
    return false;
  }
}

export async function dialProtocolWithRelayFallback(
  params: DialProtocolWithRelayFallbackParams
): Promise<Stream> {
  const {
    node,
    database,
    targetPeerId,
    protocol,
    context,
  } = params;

  const networkMode = database.getSessionNetworkMode();
  const modeConfig = getNetworkModeConfig(networkMode);
  const expectedProtocolPrefix = `${modeConfig.protocolName}/`;
  if (!protocol.startsWith(expectedProtocolPrefix)) {
    console.warn(
      `[MODE-GUARD][REJECT][dial_protocol] mode=${networkMode} context=${context} ` +
      `protocol=${protocol} expectedPrefix=${expectedProtocolPrefix}`
    );
    throw new Error('cross_mode_protocol_rejected');
  }

  const dialOptions = { runOnLimitedConnection: true };
  const targetPeer = targetPeerId.toString();
  const directDialOptions = {
    ...dialOptions,
    ...(networkMode === NETWORK_MODES.FAST && await shouldUseShortDirectTimeout(node, targetPeerId)
      ? { signal: AbortSignal.timeout(PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS) }
      : {}),
  };

  if ('signal' in directDialOptions) {
    console.log(
      `[DIAL][${context}] using short direct timeout target=${targetPeer} timeoutMs=${PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS} reason=private_only_known_addrs`,
    );
  }

  try {
    return await node.dialProtocol(targetPeerId, protocol, directDialOptions);
  } catch (directDialError: unknown) {
    if (networkMode !== NETWORK_MODES.FAST) {
      throw directDialError;
    }

    const relayAddrs = getConfiguredFastRelayAddrs(database).addresses;
    if (relayAddrs.length === 0) {
      throw directDialError;
    }

    const directReason = directDialError instanceof Error ? directDialError.message : String(directDialError);
    console.warn(
      `[DIAL][${context}] direct dial failed target=${targetPeer} reason=${directReason}. trying relay fallback count=${relayAddrs.length}`
    );

    let lastRelayError: unknown = directDialError;
    for (const relayAddr of relayAddrs) {
      try {
        let relayBase = relayAddr;
        if (relayBase.includes('/p2p-circuit')) {
          relayBase = relayBase.split('/p2p-circuit')[0] ?? relayAddr;
        }

        const relayMa = multiaddr(relayBase);
        if (!relayMa.getPeerId()) {
          console.warn(`[DIAL][${context}] skipping relay without /p2p peer id: ${relayAddr}`);
          continue;
        }

        const circuitAddr = `${relayBase}/p2p-circuit/p2p/${targetPeer}`;
        const stream = await node.dialProtocol(multiaddr(circuitAddr), protocol, dialOptions);
        console.log(`[DIAL][${context}] relay fallback succeeded target=${targetPeer} via=${relayBase}`);
        return stream;
      } catch (relayError: unknown) {
        lastRelayError = relayError;
        const reason = relayError instanceof Error ? relayError.message : String(relayError);
        console.warn(`[DIAL][${context}] relay fallback failed via=${relayAddr} reason=${reason}`);
      }
    }

    throw lastRelayError;
  }
}
