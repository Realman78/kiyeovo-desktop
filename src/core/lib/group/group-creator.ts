import { randomUUID, publicEncrypt } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import type { ChatNode, GroupMembersUpdatedEvent } from '../../types.js';
import type { ChatDatabase } from '../db/database.js';
import type { EncryptedUserIdentity } from '../encrypted-user-identity.js';
import { OfflineMessageManager } from '../offline-message-manager.js';
import { toBase64Url } from '../base64url.js';
import {
  GROUP_INVITE_LIFETIME,
  GROUP_MAX_MEMBERS,
  GROUP_INFO_LATEST_PREFIX,
  GROUP_INFO_VERSION_PREFIX,
} from '../../constants.js';
import {
  GroupMessageType,
  type GroupInvite,
  type GroupInviteDeliveredAck,
  type GroupInviteResponse,
  type GroupInviteResponseAck,
  type GroupWelcome,
  type GroupStateUpdate,
  type GroupControlAck,
  type GroupRosterEntry,
  type GroupInfoLatest,
  type GroupInfoVersioned,
  type GroupStatus,
  type AckMessageType,
} from './types.js';

export interface GroupCreatorDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  myUsername: string;
  onGroupMembersUpdated?: (data: GroupMembersUpdatedEvent) => void;
  nudgePeer?: (peerId: string) => void;
}

export type GroupInviteDeliveryStatus = 'sent' | 'queued_for_retry';

export interface GroupInviteDelivery {
  peerId: string;
  username: string;
  status: GroupInviteDeliveryStatus;
  reason?: string;
}

export interface GroupCreateResult {
  groupId: string;
  inviteDeliveries: GroupInviteDelivery[];
}

export class GroupCreator {
  private deps: GroupCreatorDeps;

  constructor(deps: GroupCreatorDeps) {
    this.deps = deps;
  }

  async createGroup(groupName: string, invitedPeerIds: string[]): Promise<GroupCreateResult> {
    const { database, myPeerId } = this.deps;

    if (invitedPeerIds.length + 1 > GROUP_MAX_MEMBERS) {
      throw new Error(`Group cannot exceed ${GROUP_MAX_MEMBERS} members`);
    }
    
    if (invitedPeerIds.length < 2) {
      throw new Error(`You must invite at least 2 people`);
    }

    // Verify all invitees are known contacts
    for (const peerId of invitedPeerIds) {
      const user = database.getUserByPeerId(peerId);
      if (!user) {
        throw new Error(`User ${peerId} not found in contacts`);
      }
    }

    const groupId = randomUUID();

    // Create the chat entry
    const chatId = await database.createChat({
      type: 'group',
      name: groupName,
      created_by: myPeerId,
      offline_bucket_secret: '',
      notifications_bucket_key: '',
      group_id: groupId,
      status: 'active',
      offline_last_read_timestamp: 0,
      offline_last_ack_sent: 0,
      trusted_out_of_band: false,
      muted: false,
      key_version: 0,
      group_creator_peer_id: myPeerId,
      group_status: 'invited_pending',
      created_at: new Date(),
      participants: [myPeerId],
    });

    database.updateChatGroupStatus(chatId, 'invited_pending' satisfies GroupStatus);
    database.updateChatKeyVersion(chatId, 0);

    // Send invites
    const inviteDeliveries = await this.sendGroupInvites(groupId, groupName, invitedPeerIds);

    return { groupId, inviteDeliveries };
  }

  private async sendGroupInvites(groupId: string, groupName: string, invitedPeerIds: string[]): Promise<GroupInviteDelivery[]> {
    const { database, myPeerId } = this.deps;
    const now = Date.now();
    let sent = 0;
    let queued = 0;
    const deliveries: GroupInviteDelivery[] = [];
    const batchSize = 3;

    for (let i = 0; i < Math.min(invitedPeerIds.length, 9); i += batchSize) {
      const batch = invitedPeerIds.slice(i, i + batchSize);
      const round = Math.floor(i / batchSize) + 1;
      console.log(`[GROUP][TRACE][INVITE][ROUND_START] group=${groupId} round=${round} size=${batch.length}`);

      const roundResults = await Promise.all(batch.map(async (peerId): Promise<GroupInviteDelivery> => {
        const inviteId = randomUUID();
        const expiresAt = now + GROUP_INVITE_LIFETIME;
        const invitee = database.getUserByPeerId(peerId);
        const username = invitee?.username || peerId;

        const invite: Omit<GroupInvite, 'signature'> = {
          type: GroupMessageType.GROUP_INVITE,
          groupId,
          groupName,
          inviterPeerId: myPeerId,
          inviteId,
          createdAt: now,
          expiresAt,
        };

        const signature = this.sign(invite);
        const signedInvite: GroupInvite = { ...invite, signature };

        // Store in pending ACKs first, then send
        database.insertPendingAck(groupId, peerId, 'GROUP_INVITE', JSON.stringify(signedInvite));
        console.log(
          `[GROUP][TRACE][INVITE][CREATE] group=${groupId} inviteId=${inviteId} to=${peerId.slice(-8)} pendingSaved=true expiresAt=${expiresAt}`,
        );

        try {
          await this.sendControlMessageToPeer(peerId, signedInvite);
          console.log(
            `[GROUP][TRACE][INVITE][SENT] group=${groupId} inviteId=${inviteId} to=${peerId.slice(-8)}`,
          );
          return { peerId, username, status: 'sent' };
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[GROUP] Invite to ${peerId} queued for retry: ${reason}`);
          return { peerId, username, status: 'queued_for_retry', reason };
        }
      }));

      for (const result of roundResults) {
        deliveries.push(result);
        if (result.status === 'sent') sent++;
        else queued++;
      }

      console.log(`[GROUP][TRACE][INVITE][ROUND_DONE] group=${groupId} round=${round} sent=${sent} queued=${queued}`);
    }

    if (queued > 0) {
      console.log(`[GROUP] Group ${groupId}: invites sent now=${sent}, queued for retry=${queued}`);
    }
    return deliveries;
  }

  async processInviteResponse(response: GroupInviteResponse): Promise<void> {
    const { database, myPeerId } = this.deps;
    console.log(
      `[GROUP][TRACE][RESP][IN] group=${response.groupId} inviteId=${response.inviteId} msgId=${response.messageId} from=${response.responderPeerId.slice(-8)} response=${response.response} ts=${response.timestamp}`,
    );

    // Verify this is for a group we created
    const chat = database.getChatByGroupId(response.groupId);
    if (!chat || chat.created_by !== myPeerId) {
      console.log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} reason=not_creator chatExists=${!!chat} createdBy=${chat?.created_by?.slice(-8) ?? 'n/a'} me=${myPeerId.slice(-8)}`,
      );
      throw new Error(`Not creator of group ${response.groupId}`);
    }

    // Reconstruct invite state from pending_acks (survives restart)
    const pendingAcks = database.getPendingAcksForGroup(response.groupId);
    const inviteCandidates = pendingAcks.filter(
      a => a.target_peer_id === response.responderPeerId && a.message_type === 'GROUP_INVITE'
    );
    const inviteCandidateIds = inviteCandidates.map(candidate => {
      try {
        const parsed = JSON.parse(candidate.message_payload) as { inviteId?: string };
        return parsed.inviteId ?? 'missing_invite_id';
      } catch {
        return 'invalid_json';
      }
    });
    console.log(
      `[GROUP][TRACE][RESP][LOOKUP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} pendingInviteCount=${inviteCandidates.length} pendingInviteIds=${inviteCandidateIds.join(',') || 'none'}`,
    );
    const inviteAck = inviteCandidates[0];

    if (!inviteAck) {
      // No pending invite = already processed (dedup) or never sent
      console.log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=no_pending_invite`,
      );
      return;
    }

    // Parse stored invite to verify inviteId match and check expiry
    let storedInvite: GroupInvite;
    try {
      storedInvite = JSON.parse(inviteAck.message_payload) as GroupInvite;
    } catch {
      console.log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=invalid_pending_invite_payload`,
      );
      throw new Error('Invalid pending invite payload');
    }
    console.log(
      `[GROUP][TRACE][RESP][MATCH] group=${response.groupId} from=${response.responderPeerId.slice(-8)} incomingInviteId=${response.inviteId} pendingInviteId=${storedInvite.inviteId}`,
    );
    if (response.inviteId !== storedInvite.inviteId) {
      throw new Error(
        `Invite ID mismatch: incoming=${response.inviteId} pending=${storedInvite.inviteId}`,
      );
    }

    if (Date.now() > storedInvite.expiresAt) {
      console.log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=invite_expired now=${Date.now()} expiresAt=${storedInvite.expiresAt}`,
      );
      database.removePendingAck(response.groupId, response.responderPeerId, 'GROUP_INVITE');
      database.removeInviteDeliveryAcksForMember(response.groupId, response.responderPeerId);
      return;
    }

    // Verify signature
    const responder = database.getUserByPeerId(response.responderPeerId);
    if (!responder) {
      throw new Error(`Responder ${response.responderPeerId} not found`);
    }
    this.verifySignature(response, responder.signing_public_key);
    console.log(
      `[GROUP][TRACE][RESP][SIG_OK] group=${response.groupId} from=${response.responderPeerId.slice(-8)} msgId=${response.messageId}`,
    );

    // Send ACK back
    console.log(
      `[GROUP][TRACE][RESP][ACK_SEND] group=${response.groupId} inviteId=${response.inviteId} to=${response.responderPeerId.slice(-8)} ackedMsgId=${response.messageId}`,
    );
    await this.sendInviteResponseAck(response);

    if (response.response === 'reject') {
      // Reject is terminal for this invite.
      database.removePendingAck(response.groupId, response.responderPeerId, 'GROUP_INVITE');
      database.removeInviteDeliveryAcksForMember(response.groupId, response.responderPeerId);
      console.log(
        `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=rejected`,
      );
      return;
    }

    // If already a participant, treat this as idempotent duplicate acceptance.
    const alreadyParticipant = database.getChatParticipants(chat.id)
      .some(p => p.peer_id === response.responderPeerId);
    if (alreadyParticipant) {
      database.removePendingAck(response.groupId, response.responderPeerId, 'GROUP_INVITE');
      database.removeInviteDeliveryAcksForMember(response.groupId, response.responderPeerId);
      console.log(
        `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=already_participant`,
      );
      return;
    }

    console.log(
      `[GROUP][TRACE][RESP][WELCOME] group=${response.groupId} to=${response.responderPeerId.slice(-8)} action=send_group_welcome`,
    );
    await this.sendGroupWelcome(response.groupId, response.responderPeerId);

    // Remove invite only after welcome path succeeds.
    database.removePendingAck(response.groupId, response.responderPeerId, 'GROUP_INVITE');
    database.removeInviteDeliveryAcksForMember(response.groupId, response.responderPeerId);
    console.log(
      `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=accepted_pending_removed`,
    );
  }

  async handleInviteDeliveredAck(ack: GroupInviteDeliveredAck, senderPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    console.log(
      `[GROUP][TRACE][DELIVERED_ACK][IN] group=${ack.groupId} inviteId=${ack.inviteId} ackId=${ack.ackId} from=${senderPeerId.slice(-8)}`,
    );

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat || chat.created_by !== myPeerId) {
      console.log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=not_creator`,
      );
      return;
    }

    const sender = database.getUserByPeerId(senderPeerId);
    if (!sender) {
      console.log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=unknown_sender`,
      );
      return;
    }
    this.verifySignature(ack, sender.signing_public_key);

    const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
    const pendingInvite = pendingAcks.find(
      a => a.target_peer_id === senderPeerId && a.message_type === 'GROUP_INVITE',
    );
    if (!pendingInvite) {
      console.log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=no_pending_invite`,
      );
      return;
    }

    try {
      const storedInvite = JSON.parse(pendingInvite.message_payload) as GroupInvite;
      if (storedInvite.inviteId !== ack.inviteId) {
        console.log(
          `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invite_id_mismatch pendingInviteId=${storedInvite.inviteId} incomingInviteId=${ack.inviteId}`,
        );
        return;
      }
      database.markInviteDeliveryAckReceived(ack.groupId, senderPeerId, ack.inviteId);
      console.log(
        `[GROUP][TRACE][DELIVERED_ACK][APPLY] group=${ack.groupId} from=${senderPeerId.slice(-8)} inviteId=${ack.inviteId}`,
      );
    } catch {
      console.log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invalid_pending_invite_payload`,
      );
      return;
    }
  }

  async handleControlAck(ack: GroupControlAck, senderPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat || chat.created_by !== myPeerId) return;

    // Verify sender is a known participant
    const sender = database.getUserByPeerId(senderPeerId);
    if (!sender) return;
    this.verifySignature(ack, sender.signing_public_key);
    console.log(
      `[GROUP][TRACE][CONTROL_ACK][IN] group=${ack.groupId} from=${senderPeerId.slice(-8)} ackType=${ack.ackedMessageType} ackedMsgId=${ack.ackedMessageId} ackId=${ack.ackId}`,
    );

    // Map the acked message type to the pending ack type
    const ackType = ack.ackedMessageType as AckMessageType;
    if (ackType === 'GROUP_WELCOME' || ackType === 'GROUP_STATE_UPDATE') {
      // Verify the ACK matches the currently pending message to prevent stale/duplicate ACKs
      // from clearing a newer pending entry for the same member+type.
      const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
      const pending = pendingAcks.find(
        a => a.target_peer_id === senderPeerId && a.message_type === ackType,
      );
      if (!pending) {
        console.log(
          `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=no_pending_for_type ackType=${ackType}`,
        );
        return;
      }

      try {
        const stored = JSON.parse(pending.message_payload) as { messageId?: string };
        if (stored.messageId !== ack.ackedMessageId) {
          console.log(
            `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=message_id_mismatch pendingMsgId=${stored.messageId ?? 'missing'} ackedMsgId=${ack.ackedMessageId}`,
          );
          return;
        }
      } catch {
        console.log(
          `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invalid_pending_payload`,
        );
        return;
      }

      database.removePendingAck(ack.groupId, senderPeerId, ackType);
      console.log(
        `[GROUP][TRACE][CONTROL_ACK][APPLY] group=${ack.groupId} from=${senderPeerId.slice(-8)} ackType=${ackType}`,
      );
    }
  }

  private async sendInviteResponseAck(response: GroupInviteResponse): Promise<void> {
    const ack: Omit<GroupInviteResponseAck, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_RESPONSE_ACK,
      groupId: response.groupId,
      inviteId: response.inviteId,
      ackedMessageId: response.messageId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupInviteResponseAck = { ...ack, signature };

    console.log(
      `[GROUP][TRACE][RESP_ACK][SEND] group=${response.groupId} inviteId=${response.inviteId} to=${response.responderPeerId.slice(-8)} ackedMsgId=${response.messageId} ackId=${signedAck.ackId}`,
    );
    await this.sendControlMessageToPeer(response.responderPeerId, signedAck);
  }

  async sendGroupWelcome(groupId: string, acceptedPeerId: string): Promise<void> {
    const { database, userIdentity } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);

    // Get accepted user's info for RSA encryption
    const acceptedUser = database.getUserByPeerId(acceptedPeerId);
    if (!acceptedUser) throw new Error(`User ${acceptedPeerId} not found`);

    // Rotate key (join always triggers rotation)
    const { groupKey, keyVersion } = await this.rotateGroupKey(groupId, acceptedPeerId, 'join');

    // Build roster (creator + all existing active members + new joiner)
    const participants = database.getChatParticipants(chat.id);
    const roster = this.buildRoster(participants.map(p => p.peer_id));

    // RSA-encrypt group key for the new joiner
    const recipientPubKeyPem = Buffer.from(acceptedUser.offline_public_key, 'base64').toString();
    const encryptedGroupKey = publicEncrypt(
      recipientPubKeyPem,
      Buffer.from(groupKey, 'base64'),
    ).toString('base64');

    // Construct GroupWelcome
    const creatorPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    const groupInfoLatestDhtKey = `${GROUP_INFO_LATEST_PREFIX}/${groupId}/${creatorPubKeyBase64url}`;

    const welcome: Omit<GroupWelcome, 'signature'> = {
      type: GroupMessageType.GROUP_WELCOME,
      groupId,
      groupName: chat.name,
      keyVersion,
      encryptedGroupKey,
      roster,
      groupInfoLatestDhtKey,
      messageId: randomUUID(),
    };

    const signature = this.sign(welcome);
    const signedWelcome: GroupWelcome = { ...welcome, signature };

    // Store in pending ACKs first, then send. If send fails, re-publisher can still deliver later.
    database.insertPendingAck(groupId, acceptedPeerId, 'GROUP_WELCOME', JSON.stringify(signedWelcome));
    console.log(
      `[GROUP][TRACE][WELCOME][CREATE] group=${groupId} to=${acceptedPeerId.slice(-8)} msgId=${signedWelcome.messageId} keyVersion=${keyVersion}`,
    );

    // Deliver to new member via pairwise offline bucket
    await this.sendControlMessageToPeer(acceptedPeerId, signedWelcome);
    console.log(
      `[GROUP][TRACE][WELCOME][SENT] group=${groupId} to=${acceptedPeerId.slice(-8)} msgId=${signedWelcome.messageId}`,
    );

    // Send GroupStateUpdate to all existing members (excluding new joiner — they get welcome)
    await this.sendGroupStateUpdate(groupId, keyVersion, groupKey, roster, 'join', acceptedPeerId);

    // Publish group-info DHT records
    await this.publishGroupInfoRecords(groupId, keyVersion, roster);

    // Transition group_status to 'active' now that at least one member has been welcomed
    database.updateChatGroupStatus(chat.id, 'active');
    console.log(
      `[GROUP][TRACE][WELCOME][DONE] group=${groupId} activated=true welcomedPeer=${acceptedPeerId.slice(-8)} keyVersion=${keyVersion}`,
    );
    this.deps.onGroupMembersUpdated?.({
      chatId: chat.id,
      groupId,
      memberPeerId: acceptedPeerId,
    });
  }

  async rotateGroupKey(
    groupId: string,
    targetPeerId: string,
    event: 'join' | 'leave' | 'kick',
  ): Promise<{ groupKey: string; keyVersion: number }> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);

    // Generate new key
    const keyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(keyBytes);
    const groupKey = Buffer.from(keyBytes).toString('base64');

    const keyVersion = (chat.key_version ?? 0) + 1;

    // Update roster based on event
    const participants = database.getChatParticipants(chat.id);
    let newParticipantPeerIds = participants.map(p => p.peer_id);

    if (event === 'join') {
      if (!newParticipantPeerIds.includes(targetPeerId)) {
        newParticipantPeerIds.push(targetPeerId);
      }
    } else {
      // leave or kick — remove target
      newParticipantPeerIds = newParticipantPeerIds.filter(id => id !== targetPeerId);
    }

    // Update chat participants
    database.updateGroupPermanentKey(chat.id, groupKey, newParticipantPeerIds, myPeerId);
    database.updateChatKeyVersion(chat.id, keyVersion);

    // Store key in history
    database.insertGroupKeyHistory(groupId, keyVersion, groupKey);

    return { groupKey, keyVersion };
  }

  async republishPendingControl(targetPeerId: string, payloadJson: string): Promise<void> {
    let parsed: object;
    try {
      parsed = JSON.parse(payloadJson) as object;
    } catch {
      throw new Error(`Invalid pending ACK payload for ${targetPeerId}`);
    }
    console.log(
      `[GROUP][TRACE][REPUBLISH][CREATOR] target=${targetPeerId.slice(-8)} ${this.describeControlMessage(parsed)}`,
    );
    await this.sendControlMessageToPeer(targetPeerId, parsed);
  }

  private async sendGroupStateUpdate(
    groupId: string,
    keyVersion: number,
    groupKey: string,
    roster: GroupRosterEntry[],
    event: 'join' | 'leave' | 'kick',
    targetPeerId: string,
  ): Promise<void> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) return;

    const participants = database.getChatParticipants(chat.id);

    for (const participant of participants) {
      // Skip self and the target of the event (joiner gets welcome, leaver/kicked gets nothing or kick msg)
      if (participant.peer_id === myPeerId || participant.peer_id === targetPeerId) continue;

      const user = database.getUserByPeerId(participant.peer_id);
      if (!user) continue;

      // RSA-encrypt the new group key for this member
      const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
      const encryptedGroupKey = publicEncrypt(
        recipientPubKeyPem,
        Buffer.from(groupKey, 'base64'),
      ).toString('base64');

      const update: Omit<GroupStateUpdate, 'signature'> = {
        type: GroupMessageType.GROUP_STATE_UPDATE,
        groupId,
        keyVersion,
        encryptedGroupKey,
        roster,
        event,
        targetPeerId,
        messageId: randomUUID(),
      };

      const signature = this.sign(update);
      const signedUpdate: GroupStateUpdate = { ...update, signature };

      // Store in pending ACKs first, then send.
      database.insertPendingAck(groupId, participant.peer_id, 'GROUP_STATE_UPDATE', JSON.stringify(signedUpdate));
      await this.sendControlMessageToPeer(participant.peer_id, signedUpdate);
    }
  }

  private async publishGroupInfoRecords(
    groupId: string,
    keyVersion: number,
    roster: GroupRosterEntry[],
  ): Promise<void> {
    const { database, userIdentity } = this.deps;
    const creatorPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);

    // Build versioned record
    const members = roster.map(r => r.peerId);
    const memberSigningPubKeys: Record<string, string> = {};
    for (const r of roster) {
      memberSigningPubKeys[r.peerId] = r.signingPubKey;
    }

    // Get previous version's stateHash for hash chain
    const prevVersion = keyVersion - 1;
    let prevVersionHash = '';
    if (prevVersion >= 1) {
      const storedHash = database.getGroupKeyStateHash(groupId, prevVersion);
      if (storedHash) {
        prevVersionHash = storedHash;
      }
    }

    // Collect per-sender seq boundaries from previous key version
    // Includes observed seqs from all members (tracked on message receipt) + our own sending seq
    const senderSeqBoundaries: Record<string, number> = {};
    if (prevVersion >= 1) {
      const observed = database.getAllMemberSeqs(groupId, prevVersion);
      for (const [peerId, seq] of Object.entries(observed)) {
        senderSeqBoundaries[peerId] = seq;
      }
      // Also include our own sending seq (may be higher than what we've "observed" from ourselves)
      const mySeq = database.getCurrentSeq(groupId, prevVersion);
      if (mySeq > 0) {
        senderSeqBoundaries[this.deps.myPeerId] = Math.max(
          senderSeqBoundaries[this.deps.myPeerId] ?? 0,
          mySeq,
        );
      }
    }

    const versionedPayload: Omit<GroupInfoVersioned, 'creatorSignature' | 'stateHash'> = {
      groupId,
      version: keyVersion,
      prevVersionHash,
      members,
      memberSigningPubKeys,
      activatedAt: Date.now(),
      senderSeqBoundaries,
    };

    const stateHash = Buffer.from(
      sha256(new TextEncoder().encode(JSON.stringify(versionedPayload)))
    ).toString('base64');

    const versionedRecord: Omit<GroupInfoVersioned, 'creatorSignature'> = {
      ...versionedPayload,
      stateHash,
    };

    const versionedSignature = this.sign(versionedRecord);
    const signedVersioned: GroupInfoVersioned = { ...versionedRecord, creatorSignature: versionedSignature };

    // Publish versioned record
    const versionedDhtKey = `${GROUP_INFO_VERSION_PREFIX}/${groupId}/${creatorPubKeyBase64url}/${keyVersion}`;
    await this.putJsonToDHT(versionedDhtKey, signedVersioned);

    // Store stateHash locally for hash chain continuity
    database.updateGroupKeyStateHash(groupId, keyVersion, stateHash);

    // Mark previous version as superseded
    if (prevVersion >= 1) {
      database.markGroupKeyUsedUntil(groupId, prevVersion, Date.now());
    }

    // Publish latest pointer
    const latestPayload: Omit<GroupInfoLatest, 'creatorSignature'> = {
      groupId,
      latestVersion: keyVersion,
      latestStateHash: stateHash,
      lastUpdated: Date.now(),
    };

    const latestSignature = this.sign(latestPayload);
    const signedLatest: GroupInfoLatest = { ...latestPayload, creatorSignature: latestSignature };

    const latestDhtKey = `${GROUP_INFO_LATEST_PREFIX}/${groupId}/${creatorPubKeyBase64url}`;
    await this.putJsonToDHT(latestDhtKey, signedLatest);
  }

  // --- Helpers ---

  private buildRoster(peerIds: string[]): GroupRosterEntry[] {
    const { database } = this.deps;
    const roster: GroupRosterEntry[] = [];

    for (const peerId of peerIds) {
      const user = database.getUserByPeerId(peerId);
      if (!user) continue;
      roster.push({
        peerId: user.peer_id,
        username: user.username,
        signingPubKey: user.signing_public_key,
        offlinePubKey: user.offline_public_key,
      });
    }

    return roster;
  }

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

    // Get the pairwise offline bucket for this peer
    const bucketSecret = database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      throw new Error(`No offline bucket secret for peer ${peerId}`);
    }

    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    const writeBucketKey = `/kiyeovo-offline/${bucketSecret}/${ourPubKeyBase64url}`;
    const bucketTag = writeBucketKey.slice(-12);

    // Wrap the group control message as an offline message
    const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
    const lastReadTimestamp = database.getOfflineLastReadTimestampByPeerId(peerId);
    const lastAckSent = database.getOfflineLastAckSentByPeerId(peerId);
    const shouldSendAck = lastReadTimestamp > lastAckSent;
    console.log(
      `[GROUP][TRACE][SEND] to=${peerId.slice(-8)} bucket=*${bucketTag} shouldAck=${shouldSendAck} ackTs=${shouldSendAck ? lastReadTimestamp : 0} ${this.describeControlMessage(message)}`,
    );

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
    console.log(
      `[GROUP][TRACE][SEND][DHT_OK] to=${peerId.slice(-8)} bucket=*${bucketTag} offlineMsgId=${offlineMessage.id} ${this.describeControlMessage(message)}`,
    );

    if (shouldSendAck) {
      database.updateOfflineLastAckSentByPeerId(peerId, lastReadTimestamp);
    }

    // DHT write succeeded — best-effort nudge so an online recipient checks their bucket immediately
    this.deps.nudgePeer?.(peerId);
  }

  private describeControlMessage(message: object): string {
    const m = message as Record<string, unknown>;
    const type = typeof m.type === 'string' ? m.type : 'unknown';
    const groupId = typeof m.groupId === 'string' ? m.groupId : 'n/a';
    const inviteId = typeof m.inviteId === 'string' ? m.inviteId : 'n/a';
    const messageId = typeof m.messageId === 'string' ? m.messageId : 'n/a';
    const ackedMessageId = typeof m.ackedMessageId === 'string' ? m.ackedMessageId : 'n/a';
    const ackId = typeof m.ackId === 'string' ? m.ackId : 'n/a';
    return `type=${type} group=${groupId} inviteId=${inviteId} msgId=${messageId} ackedMsgId=${ackedMessageId} ackId=${ackId}`;
  }

  private async putJsonToDHT(dhtKey: string, data: object): Promise<void> {
    const { node } = this.deps;
    const keyBytes = new TextEncoder().encode(dhtKey);
    const valueBytes = new TextEncoder().encode(JSON.stringify(data));

    for await (const event of node.services.dht.put(keyBytes, valueBytes) as AsyncIterable<import('@libp2p/kad-dht').QueryEvent>) {
      if (event.name === 'QUERY_ERROR') {
        console.warn(`[GROUP] DHT put error for ${dhtKey.slice(0, 50)}`);
      }
    }
  }
}
