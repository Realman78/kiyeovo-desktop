// Group chat message types and state structures

export const GroupMessageType = {
  GROUP_INVITE: 'GROUP_INVITE',
  GROUP_INVITE_RESPONSE: 'GROUP_INVITE_RESPONSE',
  GROUP_INVITE_RESPONSE_ACK: 'GROUP_INVITE_RESPONSE_ACK',
  GROUP_WELCOME: 'GROUP_WELCOME',
  GROUP_STATE_UPDATE: 'GROUP_STATE_UPDATE',
  GROUP_CONTROL_ACK: 'GROUP_CONTROL_ACK',
  GROUP_LEAVE_REQUEST: 'GROUP_LEAVE_REQUEST',
  GROUP_KICK: 'GROUP_KICK',
  GROUP_MESSAGE: 'GROUP_MESSAGE',
} as const;

export type GroupMessageType = typeof GroupMessageType[keyof typeof GroupMessageType];

export type GroupStatus =
  | 'invited_pending'
  | 'awaiting_activation'
  | 'active'
  | 'rekeying'
  | 'left'
  | 'removed'
  | 'invite_expired';

export type GroupMembershipEvent = 'join' | 'leave' | 'kick';

// --- Control messages (pairwise, via offline buckets) ---

export interface GroupInvite {
  type: typeof GroupMessageType.GROUP_INVITE;
  groupId: string;
  groupName: string;
  inviterPeerId: string;
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export interface GroupInviteResponse {
  type: typeof GroupMessageType.GROUP_INVITE_RESPONSE;
  groupId: string;
  inviteId: string;
  messageId: string;
  responderPeerId: string;
  response: 'accept' | 'reject';
  timestamp: number;
  signature: string;
}

export interface GroupInviteResponseAck {
  type: typeof GroupMessageType.GROUP_INVITE_RESPONSE_ACK;
  groupId: string;
  inviteId: string;
  ackedMessageId: string; // messageId of the GroupInviteResponse being acknowledged
  ackId: string;
  signature: string;
}

export interface GroupWelcome {
  type: typeof GroupMessageType.GROUP_WELCOME;
  groupId: string;
  groupName: string;
  keyVersion: number;
  encryptedGroupKey: string; // RSA-encrypted per recipient
  roster: GroupRosterEntry[];
  groupInfoLatestDhtKey: string;
  messageId: string;
  signature: string;
}

export interface GroupStateUpdate {
  type: typeof GroupMessageType.GROUP_STATE_UPDATE;
  groupId: string;
  keyVersion: number;
  encryptedGroupKey: string; // RSA-encrypted per recipient
  roster: GroupRosterEntry[];
  event: GroupMembershipEvent;
  targetPeerId: string; // who joined/left/was kicked
  messageId: string;
  signature: string;
}

export interface GroupLeaveRequest {
  type: typeof GroupMessageType.GROUP_LEAVE_REQUEST;
  groupId: string;
  peerId: string;
  messageId: string;
  timestamp: number;
  signature: string;
}

export interface GroupKick {
  type: typeof GroupMessageType.GROUP_KICK;
  groupId: string;
  kickedPeerId: string;
  messageId: string;
  timestamp: number;
  signature: string;
}

export interface GroupControlAck {
  type: typeof GroupMessageType.GROUP_CONTROL_ACK;
  groupId: string;
  ackedMessageType: string;
  ackedMessageId: string;
  ackId: string;
  signature: string;
}

// --- Roster ---

export interface GroupRosterEntry {
  peerId: string;
  username: string;
  signingPubKey: string; // base64 Ed25519
  offlinePubKey: string; // base64 RSA (PEM-extracted)
}

// --- DHT records ---

export interface GroupInfoLatest {
  groupId: string;
  latestVersion: number;
  latestStateHash: string;
  lastUpdated: number;
  creatorSignature: string;
}

export interface GroupInfoVersioned {
  groupId: string;
  version: number;
  prevVersionHash: string; // SHA256 of previous version record, empty string for v1
  members: string[]; // peerIds
  memberSigningPubKeys: Record<string, string>; // peerId -> base64 Ed25519 pubkey
  activatedAt: number;
  // usedUntil is NOT in the DHT record (immutable records can't be updated after the fact).
  // Remote members derive it: usedUntil(version N) = activatedAt(version N+1).
  // Creator tracks it locally in group_key_history.used_until.
  senderSeqBoundaries: Record<string, number>; // peerId -> last valid seq for this keyVersion
  stateHash: string;
  creatorSignature: string;
}

// --- Group offline bucket ---

export interface GroupOfflineMessage {
  id: string;
  groupId: string;
  keyVersion: number;
  senderPeerId: string;
  seq: number;
  encryptedContent: string; // XChaCha20-Poly1305 encrypted with group key
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface GroupOfflineSignedPayload {
  messageIds: string[];
  highestSeq: number;
  version: number;
  timestamp: number;
  bucketKey: string;
}

export interface GroupOfflineStore {
  messages: GroupOfflineMessage[];
  highestSeq: number;
  lastUpdated: number;
  version: number;
  storeSignature: string;
  storeSignedPayload: GroupOfflineSignedPayload;
}

// --- GossipSub group message ---

export interface GroupChatMessage {
  groupId: string;
  keyVersion: number;
  senderPeerId: string;
  messageId: string;
  seq: number;
  encryptedContent: string;
  nonce: string;
  timestamp: number;
  messageType: 'text' | 'system';
  signature: string;
}

// --- Local state ---

export interface GroupLocalState {
  groupId: string;
  groupName: string;
  status: GroupStatus;
  keyVersion: number;
  creatorPeerId: string;
  roster: GroupRosterEntry[];
  myRole: 'creator' | 'member';
}

// --- Pending ACK tracking ---

export type AckMessageType = 'GROUP_INVITE' | 'GROUP_INVITE_RESPONSE' | 'GROUP_WELCOME' | 'GROUP_STATE_UPDATE';

export interface PendingAck {
  groupId: string;
  targetPeerId: string;
  messageType: AckMessageType;
  messagePayload: string; // signed bytes to re-publish (base64)
  createdAt: number;
  lastPublishedAt: number;
}

// Union of all group control messages
export type GroupControlMessage =
  | GroupInvite
  | GroupInviteResponse
  | GroupInviteResponseAck
  | GroupWelcome
  | GroupStateUpdate
  | GroupControlAck
  | GroupLeaveRequest
  | GroupKick;
