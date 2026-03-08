import type { PeerId, Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';

import type { ChatNode } from '../types.js';
import { FAST_RELAY_MULTIADDRS_SETTING_KEY, NETWORK_MODES } from '../constants.js';
import { DEFAULT_FAST_RELAY_MULTIADDRS } from '../default-relay-nodes.js';
import type { ChatDatabase } from './db/database.js';

type DialProtocolWithRelayFallbackParams = {
  node: ChatNode;
  database: ChatDatabase;
  targetPeerId: PeerId;
  protocol: string;
  context: string;
  runOnLimitedConnection?: boolean;
};

function parseRelayMultiaddrs(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

export function getConfiguredFastRelayMultiaddrs(database: ChatDatabase): string[] {
  const configured = database.getSetting(FAST_RELAY_MULTIADDRS_SETTING_KEY);
  const source = configured ?? DEFAULT_FAST_RELAY_MULTIADDRS.join(',');
  return parseRelayMultiaddrs(source);
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
    runOnLimitedConnection,
  } = params;

  const dialOptions = runOnLimitedConnection === undefined
    ? undefined
    : { runOnLimitedConnection };

  try {
    return await node.dialProtocol(targetPeerId, protocol, dialOptions);
  } catch (directDialError: unknown) {
    if (database.getNetworkMode() !== NETWORK_MODES.FAST) {
      throw directDialError;
    }

    const relayAddrs = getConfiguredFastRelayMultiaddrs(database);
    if (relayAddrs.length === 0) {
      throw directDialError;
    }

    const targetPeer = targetPeerId.toString();
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
