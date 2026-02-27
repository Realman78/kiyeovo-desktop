import { ed25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { QueryEvent } from '@libp2p/kad-dht';
import type { ChatNode, GroupOfflineGapWarning, MessageReceivedEvent } from '../../types.js';
import type { ChatDatabase, Chat } from '../db/database.js';
import type { EncryptedUserIdentity } from '../encrypted-user-identity.js';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  GROUP_INFO_VERSION_PREFIX,
  GROUP_MAX_MESSAGES_PER_SENDER,
  GROUP_OFFLINE_BUCKET_PREFIX,
  GROUP_OFFLINE_CLEANUP_INTERVAL_MS,
  GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES,
  GROUP_OFFLINE_LOCAL_CACHE_TTL_MS,
  GROUP_OFFLINE_MESSAGE_TTL_MS,
  GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
  GROUP_ROTATION_GRACE_WINDOW_MS,
} from '../../constants.js';
import {
  type GroupContentMessage,
  type GroupInfoVersioned,
  type GroupOfflineMessage,
  type GroupOfflineSignedPayload,
  type GroupOfflineStore,
  GroupMessageType,
} from './types.js';
import { toBase64Url } from '../base64url.js';
import { generalErrorHandler } from '../../utils/general-error.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface GroupOfflineManagerDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  onMessageReceived: (data: MessageReceivedEvent) => void;
}

interface GroupOfflineVersionMeta {
  members: string[];
  senderSeqBoundaries: Record<string, number>;
}

interface CachedStoreEntry {
  store: GroupOfflineStore;
  cachedAt: number;
}

interface CachedVersionMetaEntry {
  value: GroupOfflineVersionMeta;
  cachedAt: number;
}

export interface GroupOfflineCheckResult {
  checkedChatIds: number[];
  unreadFromChats: Map<number, number>;
  gapWarnings: GroupOfflineGapWarning[];
}

export class GroupOfflineManager {
  private readonly deps: GroupOfflineManagerDeps;
  private readonly bucketMutationQueues = new Map<string, Promise<void>>();
  private readonly localStoreCache = new Map<string, CachedStoreEntry>();
  private readonly versionMetaCache = new Map<string, CachedVersionMetaEntry>();
  private lastCleanupAt = 0;
  private offlineCheckRunCounter = 0;

  constructor(deps: GroupOfflineManagerDeps) {
    this.deps = deps;
  }

  async storeGroupMessage(message: GroupContentMessage): Promise<void> {
    this.pruneLocalCaches();
    const ownPubKeyBase64url = toBase64Url(this.deps.userIdentity.signingPublicKey);
    const bucketKey = `${GROUP_OFFLINE_BUCKET_PREFIX}/${message.groupId}/${message.keyVersion}/${ownPubKeyBase64url}`;
    const offlineMessage: GroupOfflineMessage = {
      id: message.messageId,
      messageId: message.messageId,
      type: message.type,
      groupId: message.groupId,
      keyVersion: message.keyVersion,
      senderPeerId: message.senderPeerId,
      messageType: message.messageType,
      seq: message.seq,
      encryptedContent: message.encryptedContent,
      nonce: message.nonce,
      timestamp: message.timestamp,
      signature: message.signature,
    };

    await this.withBucketMutationLock(bucketKey, async () => {
      const local = this.deps.database.getGroupOfflineSentMessages(bucketKey);
      const existingMessages = this.filterLiveMessages(local.messages, Date.now());
      const existingVersion = local.version;

      const offlineMessageId = this.getOfflineMessageId(offlineMessage);
      if (existingMessages.some(m => this.getOfflineMessageId(m) === offlineMessageId)) {
        return;
      }

      const nextMessages = [...existingMessages, offlineMessage]
        .sort((a, b) => (a.seq - b.seq) || (a.timestamp - b.timestamp));

      if (nextMessages.length > GROUP_MAX_MESSAGES_PER_SENDER) {
        const overflow = nextMessages.length - GROUP_MAX_MESSAGES_PER_SENDER;
        nextMessages.splice(0, overflow);
        console.warn(
          `[GROUP-OFFLINE] Bucket overflow trimmed ${overflow} oldest message(s) for ${bucketKey.slice(0, 48)}...`,
        );
      }

      const highestSeq = Math.max(offlineMessage.seq, ...nextMessages.map(m => m.seq));
      const version = existingVersion + 1;
      const signedStore = this.signStore(nextMessages, highestSeq, version, bucketKey);

      try {
        await this.putStore(bucketKey, signedStore);
        this.deps.database.saveGroupOfflineSentMessages(bucketKey, nextMessages, version);
        this.setCachedStore(bucketKey, signedStore);
        return;
      } catch (firstError: unknown) {
        // Oversized stores cannot be recovered via remote merge.
        if (this.isStoreTooLargeError(firstError)) {
          throw firstError;
        }

        // Recovery path: local version may be stale (restart/cleanup race). Fetch once, merge, retry once.
        this.localStoreCache.delete(bucketKey);
        const remote = await this.getLatestStore(bucketKey);
        if (!remote) {
          // No remote state discovered -> likely connectivity issue; preserve original error.
          throw firstError;
        }

        const remoteMessages = this.filterLiveMessages(remote.messages, Date.now());
        const mergedById = new Map<string, GroupOfflineMessage>();

        for (const msg of remoteMessages) {
          mergedById.set(this.getOfflineMessageId(msg), msg);
        }
        for (const msg of existingMessages) {
          mergedById.set(this.getOfflineMessageId(msg), msg);
        }
        mergedById.set(offlineMessageId, offlineMessage);

        const mergedMessages = Array.from(mergedById.values())
          .sort((a, b) => (a.seq - b.seq) || (a.timestamp - b.timestamp));

        if (mergedMessages.length > GROUP_MAX_MESSAGES_PER_SENDER) {
          const overflow = mergedMessages.length - GROUP_MAX_MESSAGES_PER_SENDER;
          mergedMessages.splice(0, overflow);
        }

        const mergedVersion = remote.version + 1;
        const mergedHighestSeq = Math.max(
          remote.highestSeq,
          offlineMessage.seq,
          ...mergedMessages.map((m) => m.seq),
        );
        const mergedStore = this.signStore(mergedMessages, mergedHighestSeq, mergedVersion, bucketKey);
        await this.putStore(bucketKey, mergedStore);
        this.deps.database.saveGroupOfflineSentMessages(bucketKey, mergedMessages, mergedVersion);
        this.setCachedStore(bucketKey, mergedStore);
      }
    });
  }

  async checkGroupOfflineMessages(chatIds?: number[]): Promise<GroupOfflineCheckResult> {
    const runId = ++this.offlineCheckRunCounter;
    const runStart = Date.now();
    this.pruneLocalCaches();
    const unreadFromChats = new Map<number, number>();
    const gapWarnings: GroupOfflineGapWarning[] = [];
    const checkedChatIds: number[] = [];
    const targetChats = this.resolveTargetChats(chatIds);
    console.log(
      `[GROUP-OFFLINE][TIMING][RUN:${runId}] start targetChats=${targetChats.length} ` +
      `chatIds=${targetChats.map((c) => c.id).join(',') || 'none'}`
    );

    if (Date.now() - this.lastCleanupAt >= GROUP_OFFLINE_CLEANUP_INTERVAL_MS) {
      this.lastCleanupAt = Date.now();
      const cleanupStart = Date.now();
      await this.cleanupExpiredBuckets(targetChats);
      console.log(
        `[GROUP-OFFLINE][TIMING][RUN:${runId}] cleanupExpiredBuckets took ${Date.now() - cleanupStart}ms`
      );
    }

    for (const chat of targetChats) {
      const chatStart = Date.now();
      const unreadBefore = unreadFromChats.get(chat.id) ?? 0;
      const processed = await this.checkGroupChat(chat, unreadFromChats, gapWarnings);
      const unreadAfter = unreadFromChats.get(chat.id) ?? 0;
      console.log(
        `[GROUP-OFFLINE][TIMING][RUN:${runId}] chat=${chat.id} processed=${processed} ` +
        `unreadAdded=${Math.max(0, unreadAfter - unreadBefore)} took=${Date.now() - chatStart}ms`
      );
      if (processed) {
        checkedChatIds.push(chat.id);
      }
    }

    const totalUnread = Array.from(unreadFromChats.values()).reduce((sum, count) => sum + count, 0);
    console.log(
      `[GROUP-OFFLINE][TIMING][RUN:${runId}] done checkedChats=${checkedChatIds.length} ` +
      `totalUnread=${totalUnread} gaps=${gapWarnings.length} took=${Date.now() - runStart}ms`
    );

    return {
      checkedChatIds,
      unreadFromChats,
      gapWarnings,
    };
  }

  private resolveTargetChats(chatIds?: number[]): Chat[] {
    const groups = this.deps.database.getAllGroupChats(CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES * 5)
      .filter(c =>
        c.type === 'group'
        && !!c.group_id
        && c.group_status === 'active'
        && (c.key_version ?? 0) > 0,
      );

    if (!chatIds || chatIds.length === 0) {
      return groups
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .slice(0, CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES);
    }

    const wanted = new Set(chatIds);
    return groups.filter(c => wanted.has(c.id));
  }

  private async checkGroupChat(
    chat: Chat,
    unreadFromChats: Map<number, number>,
    gapWarnings: GroupOfflineGapWarning[],
  ): Promise<boolean> {
    if (!chat.group_id) return false;
    const chatStart = Date.now();

    let sawAnyStore = false;
    let epochsProcessed = 0;
    const history = this.deps.database.getGroupKeyHistory(chat.group_id)
      .filter(h => h.key_version <= (chat.key_version ?? 0))
      .sort((a, b) => a.key_version - b.key_version);

    for (const epoch of history) {
      epochsProcessed++;
      const epochStart = Date.now();
      const metaStart = Date.now();
      const versionMeta = await this.getVersionMeta(chat, epoch.key_version);
      const metaMs = Date.now() - metaStart;
      if (this.shouldSkipEpoch(chat, epoch, versionMeta)) {
        console.log(
          `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] epoch=${epoch.key_version} skipped ` +
          `metaMs=${metaMs} totalMs=${Date.now() - epochStart}`
        );
        continue;
      }

      const keyBase64 = this.deps.database.getGroupKeyForEpoch(chat.group_id, epoch.key_version);
      if (!keyBase64) continue;

      const keyBytes = Buffer.from(keyBase64, 'base64');
      if (keyBytes.length !== 32) continue;

      const roster = this.getEpochSenderPeerIds(chat, versionMeta);

      const senderDescriptors = roster
        .map((senderPeerId) => {
          const sender = this.deps.database.getUserByPeerId(senderPeerId);
          if (!sender) return null;
          const senderPubKeyBase64url = toBase64Url(Buffer.from(sender.signing_public_key, 'base64'));
          const bucketKey = `${GROUP_OFFLINE_BUCKET_PREFIX}/${chat.group_id}/${epoch.key_version}/${senderPubKeyBase64url}`;
          return { senderPeerId, sender, bucketKey };
        })
        .filter((item): item is { senderPeerId: string; sender: NonNullable<ReturnType<ChatDatabase['getUserByPeerId']>>; bucketKey: string } => item !== null);

      const storesFetchStart = Date.now();
      const senderStores = await Promise.all(senderDescriptors.map(async (desc) => ({
        ...desc,
        store: await this.getLatestStore(desc.bucketKey),
      })));
      const storesFetchMs = Date.now() - storesFetchStart;

      let epochMessagesDelivered = 0;

      for (const { senderPeerId, sender, store } of senderStores) {
        const senderStart = Date.now();
        if (!store || store.messages.length === 0) continue;

        sawAnyStore = true;
        const orderedMessages = [...store.messages]
          .sort((a, b) => (a.seq - b.seq) || (a.timestamp - b.timestamp));

        const cursor = this.deps.database.getGroupOfflineCursor(chat.group_id, epoch.key_version, senderPeerId);
        let lastReadTs = cursor?.last_read_timestamp ?? 0;
        let lastReadMessageId = cursor?.last_read_message_id ?? '';
        let highestSeenSeq = this.deps.database.getMemberSeq(chat.group_id, epoch.key_version, senderPeerId);
        const senderBoundary = versionMeta?.senderSeqBoundaries?.[senderPeerId];
        let deliveredForSender = 0;
        let skippedSeen = 0;
        let skippedInvalidSignature = 0;
        let skippedByBoundary = 0;

        for (const msg of orderedMessages) {
          if (msg.groupId !== chat.group_id || msg.keyVersion !== epoch.key_version) continue;
          if (
            epoch.used_until !== null
            && msg.timestamp > epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS
          ) {
            continue;
          }

          if (senderBoundary !== undefined && msg.seq > senderBoundary) {
            skippedByBoundary++;
            continue;
          }

          if (!this.verifyOfflineMessageSignature(msg, sender.signing_public_key)) {
            skippedInvalidSignature++;
            continue;
          }

          if (msg.seq <= highestSeenSeq) {
            ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
            skippedSeen++;
            continue;
          }

          const expectedSeq = highestSeenSeq + 1;
          if (msg.seq > expectedSeq) {
            gapWarnings.push({
              chatId: chat.id,
              groupId: chat.group_id,
              keyVersion: epoch.key_version,
              senderPeerId,
              expectedSeq,
              actualSeq: msg.seq,
            });
          }

          highestSeenSeq = msg.seq;
          this.deps.database.updateMemberSeq(chat.group_id, epoch.key_version, senderPeerId, msg.seq);
          ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));

          const messageId = this.getOfflineMessageId(msg);
          if (this.deps.database.messageExists(messageId)) {
            continue;
          }

          try {
            const content = this.decryptContent(msg.encryptedContent, keyBytes, msg.nonce);
            await this.deps.database.createMessage({
              id: messageId,
              chat_id: chat.id,
              sender_peer_id: senderPeerId,
              content,
              message_type: 'text',
              timestamp: new Date(msg.timestamp),
            });

            const unread = unreadFromChats.get(chat.id) ?? 0;
            unreadFromChats.set(chat.id, unread + 1);
            deliveredForSender++;
            epochMessagesDelivered++;

            this.deps.onMessageReceived({
              chatId: chat.id,
              messageId,
              content,
              senderPeerId,
              senderUsername: sender.username,
              timestamp: msg.timestamp,
              messageSentStatus: 'offline',
              messageType: 'text',
            });
          } catch (error: unknown) {
            generalErrorHandler(error, `[GROUP-OFFLINE] Failed to process message ${messageId}`);
          }
        }

        this.deps.database.upsertGroupOfflineCursor(
          chat.group_id,
          epoch.key_version,
          senderPeerId,
          lastReadTs,
          lastReadMessageId,
        );
        console.log(
          `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] epoch=${epoch.key_version} sender=${sender.username} ` +
          `bucketMessages=${orderedMessages.length} delivered=${deliveredForSender} skippedSeen=${skippedSeen} ` +
          `skippedBoundary=${skippedByBoundary} skippedSig=${skippedInvalidSignature} ` +
          `took=${Date.now() - senderStart}ms`
        );
      }

      console.log(
        `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] epoch=${epoch.key_version} ` +
        `metaMs=${metaMs} storeFetchMs=${storesFetchMs} senderBuckets=${senderStores.length} ` +
        `delivered=${epochMessagesDelivered} totalMs=${Date.now() - epochStart}`
      );
    }

    console.log(
      `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] done epochs=${epochsProcessed} ` +
      `sawAnyStore=${sawAnyStore} totalMs=${Date.now() - chatStart}ms`
    );

    return sawAnyStore;
  }

  private async getVersionMeta(chat: Chat, keyVersion: number): Promise<GroupOfflineVersionMeta | null> {
    if (!chat.group_id || !chat.group_creator_peer_id) return null;
    const cacheKey = `${chat.group_id}:${keyVersion}`;
    const cached = this.versionMetaCache.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    let creatorPubBytes: Uint8Array | null = null;
    if (chat.group_creator_peer_id === this.deps.myPeerId) {
      creatorPubBytes = this.deps.userIdentity.signingPublicKey;
    } else {
      const creator = this.deps.database.getUserByPeerId(chat.group_creator_peer_id);
      if (creator) {
        creatorPubBytes = Buffer.from(creator.signing_public_key, 'base64');
      }
    }
    if (!creatorPubBytes) return null;

    const creatorPubKeyBase64url = toBase64Url(creatorPubBytes);
    const dhtKey = `${GROUP_INFO_VERSION_PREFIX}/${chat.group_id}/${creatorPubKeyBase64url}/${keyVersion}`;
    const keyBytes = new TextEncoder().encode(dhtKey);
    let best: GroupInfoVersioned | null = null;

    try {
      for await (const event of this.deps.node.services.dht.get(keyBytes) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        try {
          const candidate = JSON.parse(new TextDecoder().decode(event.value)) as GroupInfoVersioned;
          if (candidate.groupId !== chat.group_id || candidate.version !== keyVersion) continue;
          if (!this.verifyGroupInfoVersionSignature(candidate, creatorPubBytes)) continue;
          best = candidate;
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }

    if (!best) return null;
    const value = {
      members: best.members,
      senderSeqBoundaries: best.senderSeqBoundaries ?? {},
    };
    this.versionMetaCache.set(cacheKey, { value, cachedAt: Date.now() });
    this.pruneLocalCaches();
    return value;
  }

  private verifyGroupInfoVersionSignature(record: GroupInfoVersioned, creatorPubKey: Uint8Array): boolean {
    try {
      const { creatorSignature, ...payload } = record;
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = Buffer.from(creatorSignature, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, creatorPubKey);
    } catch {
      return false;
    }
  }

  private signStore(
    messages: GroupOfflineMessage[],
    highestSeq: number,
    version: number,
    bucketKey: string,
  ): GroupOfflineStore {
    const timestamp = Date.now();
    const storeSignedPayload: GroupOfflineSignedPayload = {
      messageIds: messages.map(m => this.getOfflineMessageId(m)),
      highestSeq,
      version,
      timestamp,
      bucketKey,
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(storeSignedPayload));
    const signature = ed25519.sign(payloadBytes, this.deps.userIdentity.signingPrivateKey);

    return {
      messages,
      highestSeq,
      lastUpdated: timestamp,
      version,
      storeSignature: Buffer.from(signature).toString('base64'),
      storeSignedPayload,
    };
  }

  private async getLatestStore(bucketKey: string): Promise<GroupOfflineStore | null> {
    const startedAt = Date.now();
    const cached = this.getCachedStore(bucketKey);
    if (cached) {
      console.log(
        `[GROUP-OFFLINE][TIMING][STORE] bucket=*${bucketKey.slice(-10)} cacheHit=true took=${Date.now() - startedAt}ms`
      );
      return cached;
    }

    const key = new TextEncoder().encode(bucketKey);
    let best: GroupOfflineStore | null = null;
    let valueEvents = 0;

    try {
      for await (const event of this.deps.node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        valueEvents++;
        try {
          const decompressed = await gunzipAsync(Buffer.from(event.value));
          const store = JSON.parse(decompressed.toString('utf8')) as GroupOfflineStore;
          if (
            !best
            || store.version > best.version
            || (store.version === best.version && store.lastUpdated > best.lastUpdated)
          ) {
            best = store;
          }
        } catch {
          continue;
        }
      }
    } catch {
      console.log(
        `[GROUP-OFFLINE][TIMING][STORE] bucket=*${bucketKey.slice(-10)} cacheHit=false dhtError=true ` +
        `valueEvents=${valueEvents} took=${Date.now() - startedAt}ms`
      );
      return null;
    }

    if (best) {
      this.setCachedStore(bucketKey, best);
    }
    console.log(
      `[GROUP-OFFLINE][TIMING][STORE] bucket=*${bucketKey.slice(-10)} cacheHit=false hasStore=${!!best} ` +
      `valueEvents=${valueEvents} took=${Date.now() - startedAt}ms`
    );
    return best;
  }

  private async putStore(bucketKey: string, store: GroupOfflineStore): Promise<void> {
    const key = new TextEncoder().encode(bucketKey);
    const payload = Buffer.from(JSON.stringify(store), 'utf8');
    const compressed = await gzipAsync(payload);
    if (compressed.length > GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES) {
      throw new Error(
        `Group offline store too large (${compressed.length}B > ${GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES}B)`,
      );
    }

    let successCount = 0;
    for await (const event of this.deps.node.services.dht.put(key, compressed) as AsyncIterable<QueryEvent>) {
      if (event.name === 'PEER_RESPONSE') {
        successCount++;
      }
    }

    if (successCount === 0) {
      throw new Error('Failed to store group offline message: no successful DHT peers');
    }
  }

  private isStoreTooLargeError(error: unknown): boolean {
    const errorText = error instanceof Error ? error.message : String(error);
    return errorText.includes('store too large');
  }

  private decryptContent(encryptedContent: string, key: Uint8Array, nonceBase64: string): string {
    const nonce = Buffer.from(nonceBase64, 'base64');
    const encryptedBytes = Buffer.from(encryptedContent, 'base64');
    const cipher = xchacha20poly1305(key, nonce);
    const decrypted = cipher.decrypt(encryptedBytes);
    return new TextDecoder().decode(decrypted);
  }

  private async withBucketMutationLock<T>(bucketKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bucketMutationQueues.get(bucketKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    this.bucketMutationQueues.set(bucketKey, previous.catch(() => undefined).then(() => current));
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.bucketMutationQueues.get(bucketKey) === current) {
        this.bucketMutationQueues.delete(bucketKey);
      }
    }
  }

  private shouldSkipEpoch(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
    versionMeta: GroupOfflineVersionMeta | null,
  ): boolean {
    if (!chat.group_id) return false;
    if (epoch.key_version >= (chat.key_version ?? 0)) return false;
    if (epoch.used_until === null) return false;
    const threshold = epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
    if (Date.now() < threshold) return false;

    const senderPeerIds = this.getEpochSenderPeerIds(chat, versionMeta);
    if (senderPeerIds.length === 0) return false;

    const boundaries = versionMeta?.senderSeqBoundaries ?? {};
    const hasAllBoundaries = senderPeerIds.every((peerId) => boundaries[peerId] !== undefined);
    if (hasAllBoundaries) {
      return senderPeerIds.every((peerId) => {
        const boundary = boundaries[peerId] as number;
        const seen = this.deps.database.getMemberSeq(chat.group_id!, epoch.key_version, peerId);
        return seen >= boundary;
      });
    }

    const cursors = this.deps.database.getGroupOfflineCursors(chat.group_id, epoch.key_version);
    if (cursors.length === 0) return false;
    if (cursors.length < senderPeerIds.length) return false;
    return cursors.every((cursor) => cursor.last_read_timestamp >= threshold);
  }

  private getEpochSenderPeerIds(chat: Chat, versionMeta: GroupOfflineVersionMeta | null): string[] {
    const fromMeta = versionMeta?.members ?? [];
    const fromParticipants = this.deps.database.getChatParticipants(chat.id).map((p) => p.peer_id);
    const base = fromMeta.length > 0 ? fromMeta : fromParticipants;
    return base.filter((peerId) => peerId !== this.deps.myPeerId);
  }

  private verifyOfflineMessageSignature(msg: GroupOfflineMessage, signingPubKeyBase64: string): boolean {
    try {
      const unsignedMessage: Omit<GroupContentMessage, 'signature'> = {
        type: msg.type ?? GroupMessageType.GROUP_MESSAGE,
        groupId: msg.groupId,
        keyVersion: msg.keyVersion,
        senderPeerId: msg.senderPeerId,
        messageId: this.getOfflineMessageId(msg),
        seq: msg.seq,
        encryptedContent: msg.encryptedContent,
        nonce: msg.nonce,
        timestamp: msg.timestamp,
        messageType: msg.messageType ?? 'text',
      };
      const payloadBytes = new TextEncoder().encode(JSON.stringify(unsignedMessage));
      const sigBytes = Buffer.from(msg.signature, 'base64');
      const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, pubKeyBytes);
    } catch {
      return false;
    }
  }

  private advanceCursor(
    lastReadTs: number,
    lastReadMessageId: string,
    msg: GroupOfflineMessage,
  ): { lastReadTs: number; lastReadMessageId: string } {
    const msgId = this.getOfflineMessageId(msg);
    if (
      msg.timestamp > lastReadTs
      || (msg.timestamp === lastReadTs && msgId !== lastReadMessageId)
    ) {
      return { lastReadTs: msg.timestamp, lastReadMessageId: msgId };
    }
    return { lastReadTs, lastReadMessageId };
  }

  private getOfflineMessageId(msg: GroupOfflineMessage): string {
    return msg.messageId ?? msg.id;
  }

  private filterLiveMessages(messages: GroupOfflineMessage[], now: number): GroupOfflineMessage[] {
    const cutoff = now - GROUP_OFFLINE_MESSAGE_TTL_MS;
    return messages.filter((msg) => msg.timestamp >= cutoff);
  }

  private getCachedStore(bucketKey: string): GroupOfflineStore | null {
    const entry = this.localStoreCache.get(bucketKey);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > GROUP_OFFLINE_LOCAL_CACHE_TTL_MS) {
      this.localStoreCache.delete(bucketKey);
      return null;
    }
    return entry.store;
  }

  private setCachedStore(bucketKey: string, store: GroupOfflineStore): void {
    this.localStoreCache.set(bucketKey, { store, cachedAt: Date.now() });
    this.pruneLocalCaches();
  }

  private pruneLocalCaches(): void {
    const now = Date.now();
    for (const [bucketKey, entry] of this.localStoreCache.entries()) {
      if (now - entry.cachedAt > GROUP_OFFLINE_LOCAL_CACHE_TTL_MS) {
        this.localStoreCache.delete(bucketKey);
      }
    }
    for (const [metaKey, entry] of this.versionMetaCache.entries()) {
      if (now - entry.cachedAt > GROUP_OFFLINE_LOCAL_CACHE_TTL_MS) {
        this.versionMetaCache.delete(metaKey);
      }
    }

    while (this.localStoreCache.size > GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES) {
      const oldest = this.localStoreCache.keys().next().value;
      if (!oldest) break;
      this.localStoreCache.delete(oldest);
    }
    while (this.versionMetaCache.size > GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES) {
      const oldest = this.versionMetaCache.keys().next().value;
      if (!oldest) break;
      this.versionMetaCache.delete(oldest);
    }
  }

  private async cleanupExpiredBuckets(chats: Chat[]): Promise<void> {
    const now = Date.now();
    const ownPubKeyBase64url = toBase64Url(this.deps.userIdentity.signingPublicKey);

    for (const chat of chats) {
      if (!chat.group_id) continue;
      const history = this.deps.database.getGroupKeyHistory(chat.group_id)
        .filter((h) => h.key_version <= (chat.key_version ?? 0))
        .sort((a, b) => a.key_version - b.key_version);

      for (const epoch of history) {
        const bucketKey = `${GROUP_OFFLINE_BUCKET_PREFIX}/${chat.group_id}/${epoch.key_version}/${ownPubKeyBase64url}`;
        await this.withBucketMutationLock(bucketKey, async () => {
          const existing = this.getCachedStore(bucketKey) ?? await this.getLatestStore(bucketKey);
          if (!existing || existing.messages.length === 0) return;

          const liveMessages = this.filterLiveMessages(existing.messages, now);
          if (liveMessages.length === existing.messages.length) return;

          const version = existing.version + 1;
          const highestSeq = Math.max(
            existing.highestSeq,
            ...liveMessages.map((m) => m.seq),
            0,
          );
          const signedStore = this.signStore(liveMessages, highestSeq, version, bucketKey);
          await this.putStore(bucketKey, signedStore);
          this.deps.database.saveGroupOfflineSentMessages(bucketKey, liveMessages, version);
          this.setCachedStore(bucketKey, signedStore);
        });
      }

      await this.cleanupConsumedEpochState(chat, history);
    }
  }

  private async cleanupConsumedEpochState(
    chat: Chat,
    history: Array<{ key_version: number; used_until: number | null }>,
  ): Promise<void> {
    if (!chat.group_id) return;

    for (const epoch of history) {
      const versionMeta = await this.getVersionMeta(chat, epoch.key_version);
      if (!this.shouldPruneEpochCursors(chat, epoch, versionMeta)) continue;

      this.deps.database.deleteGroupOfflineCursorsForEpoch(chat.group_id, epoch.key_version);
      this.deps.database.deleteGroupKeyHistoryForEpoch(chat.group_id, epoch.key_version);
      this.deps.database.deleteGroupSenderSeqForEpoch(chat.group_id, epoch.key_version);
      this.deps.database.deleteGroupMemberSeqsForEpoch(chat.group_id, epoch.key_version);

      const versionMetaCacheKey = `${chat.group_id}:${epoch.key_version}`;
      this.versionMetaCache.delete(versionMetaCacheKey);

      const bucketPrefix = `${GROUP_OFFLINE_BUCKET_PREFIX}/${chat.group_id}/${epoch.key_version}/`;
      this.deps.database.deleteGroupOfflineSentMessagesByPrefix(bucketPrefix);
      for (const bucketKey of this.localStoreCache.keys()) {
        if (bucketKey.startsWith(bucketPrefix)) {
          this.localStoreCache.delete(bucketKey);
        }
      }
    }
  }

  private shouldPruneEpochCursors(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
    versionMeta: GroupOfflineVersionMeta | null,
  ): boolean {
    if (!chat.group_id) return false;
    if (epoch.key_version >= (chat.key_version ?? 0)) return false;
    if (epoch.used_until === null) return false;

    const threshold = epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
    if (Date.now() < threshold) return false;

    const senderPeerIds = this.getEpochSenderPeerIds(chat, versionMeta);
    if (senderPeerIds.length === 0) return false;

    const boundaries = versionMeta?.senderSeqBoundaries ?? {};
    const hasAllBoundaries = senderPeerIds.every((peerId) => boundaries[peerId] !== undefined);
    if (!hasAllBoundaries) return false;

    return senderPeerIds.every((peerId) => {
      const boundary = boundaries[peerId] as number;
      const seen = this.deps.database.getMemberSeq(chat.group_id!, epoch.key_version, peerId);
      return seen >= boundary;
    });
  }
}
