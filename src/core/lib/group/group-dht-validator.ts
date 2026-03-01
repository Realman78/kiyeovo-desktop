import { ed25519 } from '@noble/curves/ed25519';
import { gunzipSync } from 'zlib';
import { fromBase64Url } from '../base64url.js';
import {
  GROUP_OFFLINE_BUCKET_PREFIX,
  GROUP_INFO_LATEST_PREFIX,
  GROUP_INFO_VERSION_PREFIX,
  GROUP_MAX_MESSAGES_PER_SENDER,
  GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
} from '../../constants.js';
import type {
  GroupContentMessage,
  GroupInfoLatest,
  GroupInfoVersioned,
  GroupOfflineMessage,
  GroupOfflineStore,
} from './types.js';

// --- Group offline bucket validator ---
// Key format: /kiyeovo-group-offline/<groupId>/<keyVersion>/<senderPubKeyBase64url>

function getOfflineMessageId(message: GroupOfflineMessage): string {
  return message.messageId ?? message.id;
}

function toCanonicalUnsignedMessage(message: GroupOfflineMessage): Omit<GroupContentMessage, 'signature'> {
  return {
    type: message.type ?? 'GROUP_MESSAGE',
    groupId: message.groupId,
    keyVersion: message.keyVersion,
    senderPeerId: message.senderPeerId,
    messageId: getOfflineMessageId(message),
    seq: message.seq,
    encryptedContent: message.encryptedContent,
    nonce: message.nonce,
    timestamp: message.timestamp,
    messageType: message.messageType ?? 'text',
  };
}

export async function groupOfflineMessageValidator(
  key: Uint8Array,
  value: Uint8Array
): Promise<void> {
  if (value.length > GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Group offline store too large (${value.length}B > ${GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES}B)`,
    );
  }
  const keyStr = new TextDecoder().decode(key);

  if (!keyStr.startsWith(GROUP_OFFLINE_BUCKET_PREFIX + '/')) {
    throw new Error(`Invalid group offline bucket key prefix`);
  }

  // /kiyeovo-group-offline/<groupId>/<keyVersion>/<senderPubKey> = 5 parts (leading slash makes [0] empty)
  const parts = keyStr.split('/');
  if (parts.length !== 5) {
    throw new Error(`Invalid group offline bucket key format: expected 5 parts, got ${parts.length}`);
  }

  // split('/') gives ['', 'kiyeovo-group-offline', groupId, keyVersion, senderPubKey]
  const pathGroupId = parts[2];
  const pathKeyVersion = parts[3];
  const senderPubKeyBase64url = parts[4];

  if (!pathGroupId || !pathKeyVersion || !senderPubKeyBase64url) {
    throw new Error('Missing required parts in group offline bucket key');
  }

  const senderPubKey = fromBase64Url(senderPubKeyBase64url);
  if (senderPubKey.length !== 32) {
    throw new Error(`Invalid sender public key length: ${senderPubKey.length}`);
  }

  const store = decompressGroupOfflineStore(value);

  if (!Array.isArray(store.messages)) {
    throw new Error('Invalid store format: messages is not an array');
  }

  if (store.messages.length > GROUP_MAX_MESSAGES_PER_SENDER) {
    throw new Error(`Too many messages in group offline store: ${store.messages.length}`);
  }

  // Validate store signature
  if (!store.storeSignature || !store.storeSignedPayload) {
    throw new Error('Store missing storeSignature or storeSignedPayload');
  }

  if (store.storeSignedPayload.bucketKey !== keyStr) {
    throw new Error('Store bucketKey mismatch');
  }

  const actualIds = store.messages.map((m) => getOfflineMessageId(m));
  const signedIds = store.storeSignedPayload.messageIds;
  if (actualIds.length !== signedIds.length || actualIds.some((id, i) => id !== signedIds[i])) {
    throw new Error('Store messageIds mismatch');
  }

  if (store.version !== store.storeSignedPayload.version) {
    throw new Error('Store version mismatch');
  }

  // Validate highestSeq consistency
  if (store.messages.length > 0) {
    const maxSeqInMessages = Math.max(...store.messages.map(m => m.seq));
    if (store.highestSeq < maxSeqInMessages) {
      throw new Error(`Store highestSeq (${store.highestSeq}) is less than max message seq (${maxSeqInMessages})`);
    }
    if (store.storeSignedPayload.highestSeq !== store.highestSeq) {
      throw new Error('Store highestSeq mismatch between store and signed payload');
    }
  }

  const storePayloadBytes = new TextEncoder().encode(JSON.stringify(store.storeSignedPayload));
  const storeSigBytes = Buffer.from(store.storeSignature, 'base64');
  if (!ed25519.verify(storeSigBytes, storePayloadBytes, senderPubKey)) {
    throw new Error('Store signature verification failed');
  }

  // Validate each message — signature + key-path binding
  const pathKeyVersionNum = parseInt(pathKeyVersion, 10);
  if (!Number.isInteger(pathKeyVersionNum) || pathKeyVersionNum < 1) {
    throw new Error(`Invalid keyVersion in key path: ${pathKeyVersion}`);
  }

  for (const msg of store.messages) {
    const messageId = getOfflineMessageId(msg);

    if (!msg.signature) {
      throw new Error(`Message ${messageId} missing signature`);
    }

    // Verify message groupId and keyVersion match key path
    if (msg.groupId !== pathGroupId) {
      throw new Error(`Message ${messageId} groupId mismatch: payload=${msg.groupId}, keyPath=${pathGroupId}`);
    }
    if (msg.keyVersion !== pathKeyVersionNum) {
      throw new Error(`Message ${messageId} keyVersion mismatch: payload=${msg.keyVersion}, keyPath=${pathKeyVersion}`);
    }

    const canonicalUnsigned = toCanonicalUnsignedMessage(msg);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(canonicalUnsigned));
    const sigBytes = Buffer.from(msg.signature, 'base64');

    if (!ed25519.verify(sigBytes, payloadBytes, senderPubKey)) {
      throw new Error(`Message ${messageId} signature verification failed`);
    }
  }
  console.log(
    `DHT validator: accepted write to ${keyStr.slice(0, 80)}... with ${store.messages.length} messages`
  );
}

// --- Group offline bucket selector ---

export function groupOfflineMessageSelector(
  _key: Uint8Array,
  records: Uint8Array[]
): number {
  if (records.length <= 1) return 0;

  let bestIndex = 0;
  let bestVersion = -1;
  let bestTimestamp = 0;

  for (let i = 0; i < records.length; i++) {
    try {
      const record = records[i];
      if (!record) continue;
      const store = decompressGroupOfflineStore(record);

      if (
        store.version > bestVersion ||
        (store.version === bestVersion && store.lastUpdated > bestTimestamp)
      ) {
        bestVersion = store.version;
        bestTimestamp = store.lastUpdated;
        bestIndex = i;
      }
    } catch {
      continue;
    }
  }

  return bestIndex;
}

// --- Group offline bucket validateUpdate ---

export async function groupOfflineValidateUpdate(
  _key: Uint8Array,
  existing: Uint8Array,
  incoming: Uint8Array
): Promise<void> {
  const existingStore = decompressGroupOfflineStore(existing);
  const incomingStore = decompressGroupOfflineStore(incoming);

  if (incomingStore.version < existingStore.version) {
    throw new Error('stale record rejected');
  }
  if (
    incomingStore.version === existingStore.version &&
    incomingStore.lastUpdated < existingStore.lastUpdated
  ) {
    throw new Error('stale record rejected');
  }
}

function decompressGroupOfflineStore(value: Uint8Array): GroupOfflineStore {
  const buf = gunzipSync(Buffer.from(value));
  return JSON.parse(buf.toString('utf8'));
}

// --- Group info latest validator ---
// Key format: /kiyeovo-group-info-latest/<groupId>/<creatorPubKeyBase64url>

export async function groupInfoLatestValidator(
  key: Uint8Array,
  value: Uint8Array
): Promise<void> {
  const keyStr = new TextDecoder().decode(key);

  if (!keyStr.startsWith(GROUP_INFO_LATEST_PREFIX + '/')) {
    throw new Error('Invalid group info latest key prefix');
  }

  // ['', 'kiyeovo-group-info-latest', groupId, creatorPubKey]
  const parts = keyStr.split('/');
  if (parts.length !== 4) {
    throw new Error(`Invalid group info latest key format: expected 4 parts, got ${parts.length}`);
  }

  const pathGroupId = parts[2];
  const creatorPubKeyBase64url = parts[3];
  if (!pathGroupId || !creatorPubKeyBase64url) {
    throw new Error('Missing groupId or creator public key in group info latest key');
  }

  const creatorPubKey = fromBase64Url(creatorPubKeyBase64url);
  if (creatorPubKey.length !== 32) {
    throw new Error(`Invalid creator public key length: ${creatorPubKey.length}`);
  }

  const record: GroupInfoLatest = JSON.parse(new TextDecoder().decode(value));

  // Verify groupId in payload matches key path
  if (record.groupId !== pathGroupId) {
    throw new Error(`groupId mismatch: payload=${record.groupId}, keyPath=${pathGroupId}`);
  }

  if (!record.creatorSignature) {
    throw new Error('Missing creatorSignature');
  }

  const { creatorSignature, ...payload } = record;
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sigBytes = Buffer.from(creatorSignature, 'base64');

  if (!ed25519.verify(sigBytes, payloadBytes, creatorPubKey)) {
    throw new Error('Creator signature verification failed for group info latest');
  }
}

// --- Group info latest selector ---

export function groupInfoLatestSelector(
  _key: Uint8Array,
  records: Uint8Array[]
): number {
  if (records.length <= 1) return 0;

  let bestIndex = 0;
  let bestVersion = -1;
  let bestTimestamp = 0;

  for (let i = 0; i < records.length; i++) {
    try {
      const record = records[i];
      if (!record) continue;
      const info: GroupInfoLatest = JSON.parse(new TextDecoder().decode(record));

      if (
        info.latestVersion > bestVersion ||
        (info.latestVersion === bestVersion && info.lastUpdated > bestTimestamp)
      ) {
        bestVersion = info.latestVersion;
        bestTimestamp = info.lastUpdated;
        bestIndex = i;
      }
    } catch {
      continue;
    }
  }

  return bestIndex;
}

// --- Group info latest validateUpdate ---

export async function groupInfoLatestValidateUpdate(
  _key: Uint8Array,
  existing: Uint8Array,
  incoming: Uint8Array
): Promise<void> {
  const existingInfo: GroupInfoLatest = JSON.parse(new TextDecoder().decode(existing));
  const incomingInfo: GroupInfoLatest = JSON.parse(new TextDecoder().decode(incoming));

  if (incomingInfo.latestVersion < existingInfo.latestVersion) {
    throw new Error('stale record rejected');
  }

  // Same version: only allow identical re-publish (same hash)
  if (incomingInfo.latestVersion === existingInfo.latestVersion) {
    if (incomingInfo.latestStateHash !== existingInfo.latestStateHash) {
      throw new Error('stale record rejected');
    }
  }
}

// --- Group info versioned validator ---
// Key format: /kiyeovo-group-info-v/<groupId>/<creatorPubKeyBase64url>/<version>

export async function groupInfoVersionedValidator(
  key: Uint8Array,
  value: Uint8Array
): Promise<void> {
  const keyStr = new TextDecoder().decode(key);

  if (!keyStr.startsWith(GROUP_INFO_VERSION_PREFIX + '/')) {
    throw new Error('Invalid group info versioned key prefix');
  }

  // ['', 'kiyeovo-group-info-v', groupId, creatorPubKey, version]
  const parts = keyStr.split('/');
  if (parts.length !== 5) {
    throw new Error(`Invalid group info versioned key format: expected 5 parts, got ${parts.length}`);
  }

  const pathGroupId = parts[2];
  const creatorPubKeyBase64url = parts[3];
  const versionStr = parts[4];
  if (!pathGroupId || !creatorPubKeyBase64url || !versionStr) {
    throw new Error('Missing required parts in group info versioned key');
  }

  const creatorPubKey = fromBase64Url(creatorPubKeyBase64url);
  if (creatorPubKey.length !== 32) {
    throw new Error(`Invalid creator public key length: ${creatorPubKey.length}`);
  }

  const record: GroupInfoVersioned = JSON.parse(new TextDecoder().decode(value));

  // Verify groupId matches key path
  if (record.groupId !== pathGroupId) {
    throw new Error(`groupId mismatch: payload=${record.groupId}, keyPath=${pathGroupId}`);
  }

  // Version in payload must match version in key path
  const pathVersion = parseInt(versionStr, 10);
  if (!Number.isInteger(pathVersion) || pathVersion < 1) {
    throw new Error(`Invalid version in key path: ${versionStr}`);
  }
  if (record.version !== pathVersion) {
    throw new Error(`Version mismatch: key says ${versionStr}, payload says ${record.version}`);
  }

  if (!record.creatorSignature) {
    throw new Error('Missing creatorSignature');
  }

  const { creatorSignature, ...payload } = record;
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sigBytes = Buffer.from(creatorSignature, 'base64');

  if (!ed25519.verify(sigBytes, payloadBytes, creatorPubKey)) {
    throw new Error('Creator signature verification failed for group info versioned');
  }
}

// --- Group info versioned validateUpdate ---
// Immutable records: only allow byte-identical re-publish

export async function groupInfoVersionedValidateUpdate(
  _key: Uint8Array,
  existing: Uint8Array,
  incoming: Uint8Array
): Promise<void> {
  if (existing.length !== incoming.length) {
    throw new Error('stale record rejected');
  }
  for (let i = 0; i < existing.length; i++) {
    if (existing[i] !== incoming[i]) {
      throw new Error('stale record rejected');
    }
  }
}
