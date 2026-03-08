import type { ConnectionGater } from '../types.js';
import { ChatDatabase } from './db/database.js';
import type { PeerId } from '@libp2p/interface';

export function createConnectionGater(database: ChatDatabase): Partial<ConnectionGater> {
    return {
      // Block outbound dials to blocked peers
      denyDialPeer: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();
        const isBlocked = database.isBlocked(peerIdStr);
        
        if (isBlocked) {
          console.log(`[ConnectionGater] Blocked outbound dial to ${peerIdStr.slice(0, 8)}...`);
        }
        
        return isBlocked;
      },
  
      // Block inbound connections from blocked/unknown peers (after handshake)
      denyInboundEncryptedConnection: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();
        const shortPeer = peerIdStr.slice(-8);
        const contactMode = database.getSetting('contact_mode') ?? 'unset';

        // Block if peer is explicitly blocked
        if (database.isBlocked(peerIdStr)) {
          console.log(`[ConnectionGater][DIAG][INBOUND][DENY] peer=${shortPeer} reason=blocked_peer contactMode=${contactMode}`);
          return true;
        }

        // Block unknown peers if contact mode is 'block'
        if (contactMode === 'block') {
          const chat = database.getChatByPeerId(peerIdStr);
          if (chat === null) {
            console.log(`[ConnectionGater][DIAG][INBOUND][DENY] peer=${shortPeer} reason=unknown_peer_in_block_mode contactMode=${contactMode}`);
            return true;
          }
          console.log(
            `[ConnectionGater][DIAG][INBOUND][ALLOW] peer=${shortPeer} reason=known_peer_in_block_mode ` +
            `contactMode=${contactMode} chatId=${chat.id} chatType=${chat.type}`,
          );
          return false;
        }

        console.log(`[ConnectionGater][DIAG][INBOUND][ALLOW] peer=${shortPeer} reason=mode_allows_unknown contactMode=${contactMode}`);
        return false;
      },

      // Block outbound connections to blocked peers (after socket creation but before handshake)
      denyOutboundConnection: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();
        const isBlocked = database.isBlocked(peerIdStr);
        
        if (isBlocked) {
          console.log(`[ConnectionGater] Blocked outbound connection to ${peerIdStr.slice(0, 8)}...`);
        }
        
        return isBlocked;
      }
    };
  }
