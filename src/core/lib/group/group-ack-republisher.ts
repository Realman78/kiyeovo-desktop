import type { ChatNode, GroupChatActivatedEvent, GroupMembersUpdatedEvent } from '../../types.js';
import { GROUP_INVITE_LIFETIME } from '../../constants.js';
import { generalErrorHandler } from '../../utils/general-error.js';
import type { ChatDatabase, GroupPendingAck } from '../db/database.js';
import { UsernameRegistry } from '../username-registry.js';
import { GroupCreator } from './group-creator.js';
import { GroupResponder } from './group-responder.js';

interface GroupAckRepublisherDeps {
  node: ChatNode;
  database: ChatDatabase;
  usernameRegistry: UsernameRegistry;
  onGroupChatActivated: (data: GroupChatActivatedEvent) => void;
  onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void;
  nudgePeer: (peerId: string) => void;
}

type PendingActionResult = { action: 'republish' | 'skip' | 'remove'; reason?: string };

export class GroupAckRepublisher {
  private readonly deps: GroupAckRepublisherDeps;
  private inFlight = false;

  constructor(deps: GroupAckRepublisherDeps) {
    this.deps = deps;
  }

  async runCycle(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const pendingAcks = this.deps.database.getAllPendingAcks();
      if (pendingAcks.length === 0) return;
      const connectedPeers = this.deps.node.getConnections().length;
      console.log(
        `[GROUP-ACK][CYCLE][START] pendingCount=${pendingAcks.length} connectedPeers=${connectedPeers}`,
      );

      const userIdentity = this.deps.usernameRegistry.getUserIdentity();
      if (!userIdentity) return;

      const myPeerId = this.deps.node.peerId.toString();
      const myUser = this.deps.database.getUserByPeerId(myPeerId);
      const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

      const sendDeps = {
        node: this.deps.node,
        database: this.deps.database,
        userIdentity,
        myPeerId,
        myUsername,
        onGroupChatActivated: this.deps.onGroupChatActivated,
        onGroupMembersUpdated: this.deps.onGroupMembersUpdated,
        nudgePeer: this.deps.nudgePeer,
      };

      const creator = new GroupCreator(sendDeps);
      const responder = new GroupResponder(sendDeps);
      let rePublished = 0;
      let skippedNoConnection = 0;
      let skippedDelivered = 0;
      let removedInvalid = 0;
      let removedExpired = 0;
      let removedStaleTarget = 0;
      let failed = 0;

      for (const pending of pendingAcks) {
        try {
          console.log(
            `[GROUP-ACK][ITEM][START] type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)} ${this.describePendingPayload(pending.message_payload)}`,
          );
          const pendingAction = this.evaluatePendingAckAction(pending);
          if (pendingAction.action === 'remove') {
            this.deps.database.removePendingAck(
              pending.group_id,
              pending.target_peer_id,
              pending.message_type,
            );
            if (pending.message_type === 'GROUP_INVITE') {
              this.deps.database.removeInviteDeliveryAcksForMember(pending.group_id, pending.target_peer_id);
            }
            if (pendingAction.reason === 'invalid_payload' || pendingAction.reason === 'invalid_type') removedInvalid++;
            if (pendingAction.reason === 'invite_expired' || pendingAction.reason === 'response_expired') removedExpired++;
            if (
              pendingAction.reason === 'group_missing'
              || pendingAction.reason === 'target_not_participant'
              || pendingAction.reason === 'target_already_member'
              || pendingAction.reason === 'not_creator'
            ) {
              removedStaleTarget++;
            }
            console.log(
              `[GROUP-ACK][ITEM][REMOVE] type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)} reason=${pendingAction.reason}`,
            );
            continue;
          }
          if (pendingAction.action === 'skip') {
            if (pendingAction.reason === 'invite_delivered') skippedDelivered++;
            console.log(
              `[GROUP-ACK][ITEM][SKIP] type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)} reason=${pendingAction.reason}`,
            );
            continue;
          }
          if (connectedPeers === 0) {
            skippedNoConnection++;
            console.log(
              `[GROUP-ACK][ITEM][SKIP] type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)} reason=no_connected_peers`,
            );
            continue;
          }
          // TODO(optional): add dead-peer retry ceiling/backoff policy if automatic
          // prolonged-unreachable member handling is introduced in future phases.

          if (pending.message_type === 'GROUP_INVITE_RESPONSE') {
            // Responder -> creator flow
            // eslint-disable-next-line no-await-in-loop
            await responder.republishPendingControl(pending.target_peer_id, pending.message_payload);
          } else {
            // Creator -> members flow
            // eslint-disable-next-line no-await-in-loop
            await creator.republishPendingControl(pending.target_peer_id, pending.message_payload);
          }

          this.deps.database.updatePendingAckLastPublished(
            pending.group_id,
            pending.target_peer_id,
            pending.message_type,
          );
          rePublished++;
          console.log(
            `[GROUP-ACK][ITEM][DONE] type=${pending.message_type} group=${pending.group_id} target=${pending.target_peer_id.slice(-8)}`,
          );
        } catch (error: unknown) {
          failed++;
          generalErrorHandler(
            error,
            `[GROUP-ACK] Failed to re-publish ${pending.message_type} to ${pending.target_peer_id.slice(-8)}`,
          );
        }
      }
      console.log(
        `[GROUP-ACK][CYCLE][DONE] rePublished=${rePublished} skippedNoConnection=${skippedNoConnection} skippedDelivered=${skippedDelivered} removedInvalid=${removedInvalid} removedExpired=${removedExpired} removedStaleTarget=${removedStaleTarget} failed=${failed}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private evaluatePendingAckAction(pending: GroupPendingAck): PendingActionResult {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(pending.message_payload) as Record<string, unknown>;
    } catch {
      return { action: 'remove', reason: 'invalid_payload' };
    }

    if (pending.message_type === 'GROUP_INVITE') {
      return this.evaluateInvitePendingAck(pending, payload);
    }
    if (pending.message_type === 'GROUP_INVITE_RESPONSE') {
      return this.evaluateInviteResponsePendingAck(pending, payload);
    }
    if (pending.message_type === 'GROUP_WELCOME' || pending.message_type === 'GROUP_STATE_UPDATE') {
      return this.evaluateKeyBearingPendingAck(pending, payload);
    }
    return { action: 'remove', reason: 'invalid_type' };
  }

  private evaluateInvitePendingAck(pending: GroupPendingAck, payload: Record<string, unknown>): PendingActionResult {
    const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId : null;
    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : null;

    if (!inviteId || !expiresAt) {
      return { action: 'remove', reason: 'invalid_payload' };
    }
    if (Date.now() > expiresAt) {
      return { action: 'remove', reason: 'invite_expired' };
    }

    const chat = this.deps.database.getChatByGroupId(pending.group_id);
    const myPeerId = this.deps.node.peerId.toString();
    if (!chat || chat.created_by !== myPeerId) {
      return { action: 'remove', reason: !chat ? 'group_missing' : 'not_creator' };
    }

    // If target already joined, invite row is stale.
    const alreadyParticipant = this.deps.database.getChatParticipants(chat.id)
      .some((p) => p.peer_id === pending.target_peer_id);
    if (alreadyParticipant) {
      return { action: 'remove', reason: 'target_already_member' };
    }

    if (this.deps.database.isInviteDeliveryAckReceived(pending.group_id, pending.target_peer_id, inviteId)) {
      return { action: 'skip', reason: 'invite_delivered' };
    }
    return { action: 'republish' };
  }

  private evaluateInviteResponsePendingAck(pending: GroupPendingAck, payload: Record<string, unknown>): PendingActionResult {
    const timestamp = typeof payload.timestamp === 'number' ? payload.timestamp : null;
    const now = Date.now();
    // TODO(optional): if we later persist creator-signed invite expiry alongside pending
    // responses, prefer invite.expiresAt over responder timestamp for stricter cleanup.
    if (timestamp !== null && now > timestamp + GROUP_INVITE_LIFETIME) {
      return { action: 'remove', reason: 'response_expired' };
    }

    const chat = this.deps.database.getChatByGroupId(pending.group_id);
    if (!chat) return { action: 'remove', reason: 'group_missing' };
    if (chat.group_status === 'invite_expired' || chat.group_status === 'left' || chat.group_status === 'removed') {
      return { action: 'remove', reason: 'group_missing' };
    }
    if (chat.group_creator_peer_id !== pending.target_peer_id) {
      return { action: 'remove', reason: 'target_not_participant' };
    }
    return { action: 'republish' };
  }

  private evaluateKeyBearingPendingAck(pending: GroupPendingAck, payload: Record<string, unknown>): PendingActionResult {
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
    if (!messageId) {
      return { action: 'remove', reason: 'invalid_payload' };
    }

    const chat = this.deps.database.getChatByGroupId(pending.group_id);
    const myPeerId = this.deps.node.peerId.toString();
    if (!chat || chat.created_by !== myPeerId) {
      return { action: 'remove', reason: !chat ? 'group_missing' : 'not_creator' };
    }

    const isParticipant = this.deps.database.getChatParticipants(chat.id)
      .some((p) => p.peer_id === pending.target_peer_id);
    if (!isParticipant) {
      return { action: 'remove', reason: 'target_not_participant' };
    }

    return { action: 'republish' };
  }

  private describeParsedGroupMessage(parsed: Record<string, unknown>): string {
    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const groupId = typeof parsed.groupId === 'string' ? parsed.groupId : 'n/a';
    const inviteId = typeof parsed.inviteId === 'string' ? parsed.inviteId : 'n/a';
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : 'n/a';
    const ackedMessageId = typeof parsed.ackedMessageId === 'string' ? parsed.ackedMessageId : 'n/a';
    const ackId = typeof parsed.ackId === 'string' ? parsed.ackId : 'n/a';
    return `type=${type} group=${groupId} inviteId=${inviteId} msgId=${messageId} ackedMsgId=${ackedMessageId} ackId=${ackId}`;
  }

  private describePendingPayload(payloadJson: string): string {
    try {
      const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
      return this.describeParsedGroupMessage(parsed);
    } catch {
      return 'type=invalid_json group=n/a inviteId=n/a msgId=n/a ackedMsgId=n/a ackId=n/a';
    }
  }
}
