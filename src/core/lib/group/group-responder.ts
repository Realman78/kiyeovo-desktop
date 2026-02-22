import { randomUUID, privateDecrypt } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { ChatNode, GroupChatActivatedEvent } from '../../types.js';
import type { ChatDatabase } from '../db/database.js';
import type { EncryptedUserIdentity } from '../encrypted-user-identity.js';
import { OfflineMessageManager } from '../offline-message-manager.js';
import { toBase64Url } from '../base64url.js';
import {
  GroupMessageType,
  type GroupInvite,
  type GroupInviteDeliveredAck,
  type GroupInviteResponse,
  type GroupInviteResponseAck,
  type GroupWelcome,
  type GroupControlAck,
  type GroupStatus,
} from './types.js';

export interface GroupResponderDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  myUsername: string;
  onGroupChatActivated?: (data: GroupChatActivatedEvent) => void;
  nudgePeer?: (peerId: string) => void;
}

export class GroupResponder {
  private deps: GroupResponderDeps;

  constructor(deps: GroupResponderDeps) {
    this.deps = deps;
  }

  async handleGroupInvite(invite: GroupInvite): Promise<void> {
    const { database } = this.deps;

    // Check blocked
    if (database.isBlocked(invite.inviterPeerId)) {
      console.log(`[GROUP] Ignoring invite from blocked peer ${invite.inviterPeerId}`);
      return;
    }

    // Verify inviter is a known contact
    const inviter = database.getUserByPeerId(invite.inviterPeerId);
    if (!inviter) {
      console.log(`[GROUP] Ignoring invite from unknown peer ${invite.inviterPeerId}`);
      return;
    }

    // Verify signature
    this.verifySignature(invite, inviter.signing_public_key);

    // Check expiry
    if (Date.now() > invite.expiresAt) {
      console.log(`[GROUP] Invite expired for group ${invite.groupId}`);
      return;
    }

    // Check if we already have this group (dedup)
    const existing = database.getChatByGroupId(invite.groupId);
    if (existing) {
      console.log(`[GROUP] Already have group ${invite.groupId}, ignoring duplicate invite`);
      try {
        await this.sendInviteDeliveredAck(invite);
      } catch (error: unknown) {
        console.warn(
          `[GROUP] Failed to send duplicate invite delivery ACK for ${invite.groupId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return;
    }

    // Create local group chat entry with invited_pending status
    const chatId = await database.createChat({
      type: 'group',
      name: invite.groupName,
      created_by: invite.inviterPeerId,
      offline_bucket_secret: '',
      notifications_bucket_key: '',
      group_id: invite.groupId,
      status: 'pending',
      offline_last_read_timestamp: 0,
      offline_last_ack_sent: 0,
      trusted_out_of_band: false,
      muted: false,
      key_version: 0,
      group_creator_peer_id: invite.inviterPeerId,
      group_status: 'invited_pending',
      created_at: new Date(),
      participants: [invite.inviterPeerId],
    });

    database.updateChatGroupStatus(chatId, 'invited_pending' satisfies GroupStatus);

    // Create notification for UI
    database.createNotification({
      id: invite.inviteId,
      notification_type: 'group_invitation',
      notification_data: JSON.stringify({
        groupId: invite.groupId,
        groupName: invite.groupName,
        inviterPeerId: invite.inviterPeerId,
        inviteId: invite.inviteId,
        expiresAt: invite.expiresAt,
      }),
      bucket_key: '',
      status: 'pending',
    });

    try {
      await this.sendInviteDeliveredAck(invite);
    } catch (error: unknown) {
      console.warn(
        `[GROUP] Failed to send invite delivery ACK for ${invite.groupId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async respondToInvite(groupId: string, accept: boolean): Promise<void> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);
    if (chat.group_status !== 'invited_pending') {
      throw new Error(`Cannot respond to group ${groupId} in status ${chat.group_status}`);
    }

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) throw new Error(`Group ${groupId} has no creator`);

    // Find newest pending invite notification for this group
    const notifications = database.getAllNotifications();
    const inviteNotification = notifications.find(n => {
      if (n.notification_type !== 'group_invitation') return false;
      if (n.status !== 'pending') return false;
      try {
        const data = JSON.parse(n.notification_data) as { groupId?: string };
        return data.groupId === groupId;
      } catch {
        return false;
      }
    });

    if (!inviteNotification) {
      throw new Error(`No invite notification found for group ${groupId}`);
    }

    const inviteData = JSON.parse(inviteNotification.notification_data) as {
      inviteId: string;
      expiresAt: number;
    };

    if (Date.now() > inviteData.expiresAt) {
      database.updateNotificationStatus(inviteNotification.id, 'expired');
      database.updateChatGroupStatus(chat.id, 'invite_expired' satisfies GroupStatus);
      throw new Error(`Invite for group ${groupId} has expired`);
    }

    const response: Omit<GroupInviteResponse, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_RESPONSE,
      groupId,
      inviteId: inviteData.inviteId,
      messageId: randomUUID(),
      responderPeerId: myPeerId,
      response: accept ? 'accept' : 'reject',
      timestamp: Date.now(),
    };

    const signature = this.sign(response);
    const signedResponse: GroupInviteResponse = { ...response, signature };

    // Persist response for re-publish before first send (durability across crashes/restarts).
    database.insertPendingAck(
      groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE', JSON.stringify(signedResponse),
    );

    // Update local UI state immediately after local intent is persisted.
    database.updateNotificationStatus(inviteNotification.id, accept ? 'accepted' : 'rejected');
    database.updateChatGroupStatus(
      chat.id,
      accept ? ('awaiting_activation' satisfies GroupStatus) : ('invite_expired' satisfies GroupStatus),
    );

    // Send via pairwise offline bucket to creator
    await this.sendControlMessageToPeer(creatorPeerId, signedResponse);
  }

  async handleInviteResponseAck(ack: GroupInviteResponseAck): Promise<void> {
    const { database } = this.deps;

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat) return;

    // Verify creator signature
    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) return;

    const creator = database.getUserByPeerId(creatorPeerId);
    if (!creator) return;

    this.verifySignature(ack, creator.signing_public_key);

    const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
    const pendingResponse = pendingAcks.find(
      a => a.target_peer_id === creatorPeerId && a.message_type === 'GROUP_INVITE_RESPONSE',
    );
    if (!pendingResponse) return;

    let storedResponse: GroupInviteResponse;
    try {
      storedResponse = JSON.parse(pendingResponse.message_payload) as GroupInviteResponse;
    } catch {
      return;
    }

    // ACK must match the currently pending response exactly.
    if (ack.ackedMessageId !== storedResponse.messageId) return;
    if (ack.inviteId !== storedResponse.inviteId) return;

    // Remove response from pending ACKs (stop re-publishing)
    database.removePendingAck(ack.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');
  }

  async handleGroupWelcome(welcome: GroupWelcome): Promise<void> {
    const { database, userIdentity } = this.deps;

    const chat = database.getChatByGroupId(welcome.groupId);
    if (!chat) {
      console.log(`[GROUP] Received welcome for unknown group ${welcome.groupId}`);
      return;
    }

    // Verify creator signature
    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) return;

    const creator = database.getUserByPeerId(creatorPeerId);
    if (!creator) return;

    this.verifySignature(welcome, creator.signing_public_key);

    // If already active, this is a duplicate welcome — just re-send the ACK
    if (chat.group_status === 'active') {
      if (creatorPeerId) {
        database.removePendingAck(welcome.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');
      }
      await this.sendWelcomeAck(welcome);
      return;
    }

    // Decrypt group key with our RSA private key
    const ourPrivateKeyPem = userIdentity.offlinePrivateKey;
    const groupKey = privateDecrypt(
      ourPrivateKeyPem,
      Buffer.from(welcome.encryptedGroupKey, 'base64'),
    ).toString('base64');

    // Store key in history
    database.insertGroupKeyHistory(welcome.groupId, welcome.keyVersion, groupKey);

    // Update chat with key version and group info DHT key
    database.updateChatKeyVersion(chat.id, welcome.keyVersion);
    if (welcome.groupInfoLatestDhtKey) {
      database.updateChatGroupInfoDhtKey(chat.id, welcome.groupInfoLatestDhtKey);
    }

    // Ensure all roster members exist in users table (required by chat_participants FK)
    for (const entry of welcome.roster) {
      if (entry.peerId === this.deps.myPeerId) continue;
      if (!database.getUserByPeerId(entry.peerId)) {
        await database.createUser({
          peer_id: entry.peerId,
          username: entry.username,
          signing_public_key: entry.signingPubKey,
          offline_public_key: entry.offlinePubKey,
          // No handshake signature for group-only contacts; empty string is safe because
          // key-exchange.ts treats a falsy signature as "not yet verified via direct KX"
          // and falls through to a full re-handshake if they ever become direct contacts.
          signature: '',
        });
      }
    }

    // Save roster to chat_participants
    const participantPeerIds = welcome.roster.map(r => r.peerId);
    database.updateGroupParticipants(chat.id, participantPeerIds);

    // Transition to active (both group_status and the top-level status so ChatList shows it)
    database.updateChatGroupStatus(chat.id, 'active' satisfies GroupStatus);
    database.updateChatStatus(chat.id, 'active');

    // Creator has definitely processed our invite response if they sent welcome.
    database.removePendingAck(welcome.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');

    // Notify UI that this group chat is now active
    this.deps.onGroupChatActivated?.({ chatId: chat.id });

    // Send ACK back to creator
    await this.sendWelcomeAck(welcome);
  }

  async republishPendingControl(targetPeerId: string, payloadJson: string): Promise<void> {
    let parsed: object;
    try {
      parsed = JSON.parse(payloadJson) as object;
    } catch {
      throw new Error(`Invalid pending ACK payload for ${targetPeerId}`);
    }
    await this.sendControlMessageToPeer(targetPeerId, parsed);
  }

  private async sendWelcomeAck(welcome: GroupWelcome): Promise<void> {
    const creatorPeerId = this.deps.database.getChatByGroupId(welcome.groupId)?.group_creator_peer_id;
    if (!creatorPeerId) return;

    const ack: Omit<GroupControlAck, 'signature'> = {
      type: GroupMessageType.GROUP_CONTROL_ACK,
      groupId: welcome.groupId,
      ackedMessageType: GroupMessageType.GROUP_WELCOME,
      ackedMessageId: welcome.messageId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupControlAck = { ...ack, signature };

    await this.sendControlMessageToPeer(creatorPeerId, signedAck);
  }

  private async sendInviteDeliveredAck(invite: GroupInvite): Promise<void> {
    const ack: Omit<GroupInviteDeliveredAck, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_DELIVERED_ACK,
      groupId: invite.groupId,
      inviteId: invite.inviteId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupInviteDeliveredAck = { ...ack, signature };
    await this.sendControlMessageToPeer(invite.inviterPeerId, signedAck);
  }

  // --- Helpers ---

  private sign(payload: object): string {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signatureBytes = ed25519.sign(payloadBytes, this.deps.userIdentity.signingPrivateKey);
    return Buffer.from(signatureBytes).toString('base64');
  }

  private verifySignature(message: object & { signature: string }, signingPubKeyBase64: string): void {
    const { signature, ...payload } = message as Record<string, unknown>;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const sigBytes = Buffer.from(signature as string, 'base64');
    const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');

    if (!ed25519.verify(sigBytes, payloadBytes, pubKeyBytes)) {
      throw new Error('Signature verification failed');
    }
  }

  private async sendControlMessageToPeer(peerId: string, message: object): Promise<void> {
    const { node, database, userIdentity, myPeerId, myUsername } = this.deps;

    const user = database.getUserByPeerId(peerId);
    if (!user) throw new Error(`User ${peerId} not found`);

    const bucketSecret = database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      throw new Error(`No offline bucket secret for peer ${peerId}`);
    }

    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    const writeBucketKey = `/kiyeovo-offline/${bucketSecret}/${ourPubKeyBase64url}`;

    const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
    const lastReadTimestamp = database.getOfflineLastReadTimestampByPeerId(peerId);
    const lastAckSent = database.getOfflineLastAckSentByPeerId(peerId);
    const shouldSendAck = lastReadTimestamp > lastAckSent;

    const offlineMessage = OfflineMessageManager.createOfflineMessage(
      myPeerId,
      myUsername,
      JSON.stringify(message),
      recipientPubKeyPem,
      userIdentity.signingPrivateKey,
      writeBucketKey,
      shouldSendAck ? lastReadTimestamp : undefined,
    );

    await OfflineMessageManager.storeOfflineMessage(
      node,
      writeBucketKey,
      offlineMessage,
      userIdentity.signingPrivateKey,
      database,
    );

    if (shouldSendAck) {
      database.updateOfflineLastAckSentByPeerId(peerId, lastReadTimestamp);
    }

    // DHT write succeeded — best-effort nudge so an online recipient checks their bucket immediately
    this.deps.nudgePeer?.(peerId);
  }
}
