import { randomUUID, publicEncrypt, randomBytes, createCipheriv } from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { ChatNode, OfflineCheckCacheEntry, OfflineMessage, OfflineMessageStore, OfflineSenderInfo, OfflineSignedPayload, StoreSignedPayload } from '../types.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { generalErrorHandler } from '../utils/general-error.js';
import { MAX_MESSAGES_PER_STORE, MESSAGE_TTL } from '../constants.js';
import type { ChatDatabase } from './db/database.js';
import { QueryEvent } from '@libp2p/kad-dht';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Manages offline message storage and retrieval using DHT
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class OfflineMessageManager {
    static offlineCheckCache: Map<string, OfflineCheckCacheEntry> = new Map<string, OfflineCheckCacheEntry>();
    static inFlightOfflineChecks: Map<string, Promise<any>> = new Map<string, Promise<any>>();
 
    static async storeOfflineMessage(
        node: ChatNode,
        bucketKey: string,
        message: OfflineMessage,
        signingPrivateKey: Uint8Array,  // Ed25519 private key for signing store
        database: ChatDatabase          // Local database for caching
    ): Promise<void> {
        try {
            // Read from local database instead of DHT
            const local = database.getOfflineSentMessages(bucketKey);
            const messages: OfflineMessage[] = OfflineMessageManager.filterExpiredMessages(local.messages);
            let version = local.version;

            if (messages.length >= MAX_MESSAGES_PER_STORE) {
                throw new Error(`Offline message store full (${messages.length}/${MAX_MESSAGES_PER_STORE})`);
            }

            messages.push(message);
            version++;

            // Sign the store before putting to DHT
            const signedStore = OfflineMessageManager.signStore(
                messages,
                version,
                bucketKey,
                signingPrivateKey
            );

            await OfflineMessageManager.putToDHT(node, bucketKey, signedStore);

            database.saveOfflineSentMessages(bucketKey, messages, version);
            console.log(`Stored offline message (${messages.length} total in bucket)`);
        } catch (error: unknown) {
            generalErrorHandler(error);
            throw error;
        }
    }

    static async getOfflineMessages(
        node: ChatNode,
        bucketKeys: string[],
        appendBucketKey: boolean = true
    ): Promise<OfflineMessageStore> {
        // Fetch all buckets in parallel for better performance (especially over Tor)
        const fetchPromises = bucketKeys.map(async (bucketKey) => {
            const key = new TextEncoder().encode(bucketKey);
            const bucketMessages: OfflineMessage[] = [];

            try {
                let foundValue = false;

                for await (const event of node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
                    if (event.name === 'VALUE' && event.value.length > 0) {
                        foundValue = true;

                        // Decompress the data before parsing
                        const compressedBuffer = Buffer.from(event.value);
                        const decompressedBuffer = await gunzipAsync(compressedBuffer);
                        const store = JSON.parse(decompressedBuffer.toString('utf8')) as unknown;

                        if (!store || typeof store !== 'object' || !('messages' in store) || !Array.isArray(store.messages) || store.messages.length === 0) continue;

                        const validMessages = store.messages.filter(
                            (msg: unknown) => OfflineMessageManager.isValidOfflineMessage(msg)
                        );

                        if (appendBucketKey) {
                            bucketMessages.push(...validMessages.map(msg => ({ ...msg, bucket_key: bucketKey })));
                        } else {
                            bucketMessages.push(...validMessages);
                        }
                    }
                }

                if (!foundValue) {
                    console.log(`No value found in DHT for bucket key: ${bucketKey}`);
                }

            } catch (error: unknown) {
                generalErrorHandler(error, `Failed to fetch offline messages for bucket: ${bucketKey}`);
            }

            return bucketMessages;
        });

        // Wait for all bucket fetches to complete in parallel
        const results = await Promise.all(fetchPromises);
        const messages = results.flat();

        // Return structure with placeholder signature fields
        // The caller must call signStore() before putting to DHT
        return {
            messages,
            last_updated: Date.now(),
            version: 0,
            store_signature: '',
            store_signed_payload: {
                message_ids: [],
                version: 0,
                timestamp: 0,
                bucket_key: ''
            }
        };
    }

    private static filterExpiredMessages(messages: OfflineMessage[]): OfflineMessage[] {
        const now = Date.now();
        return messages.filter(msg => msg.expires_at > now).map(msg => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { bucket_key, ...clean } = msg;
            return clean;
        });
    }

    /**
     * Sign the entire store to prevent unauthorized modifications
     *
     * The signature covers: message_ids, version, timestamp, bucket_key
     * This prevents third parties from deleting/modifying messages even if they know the bucket key
     */
    static signStore(
        messages: OfflineMessage[],
        version: number,
        bucketKey: string,
        signingPrivateKey: Uint8Array
    ): OfflineMessageStore {
        const timestamp = Date.now();
        const messageIds = messages.map(m => m.id);

        const storeSignedPayload: StoreSignedPayload = {
            message_ids: messageIds,
            version,
            timestamp,
            bucket_key: bucketKey
        };

        const payloadBytes = new TextEncoder().encode(JSON.stringify(storeSignedPayload));
        const signatureBytes = ed25519.sign(payloadBytes, signingPrivateKey);
        const storeSignature = Buffer.from(signatureBytes).toString('base64');

        return {
            messages,
            last_updated: timestamp,
            version,
            store_signature: storeSignature,
            store_signed_payload: storeSignedPayload
        };
    }

    // Clear acknowledged messages from a bucket. 
    static async clearAcknowledgedMessages(
        node: ChatNode,
        bucketKey: string,
        ackTimestamp: number,
        signingPrivateKey: Uint8Array,
        database: ChatDatabase
    ): Promise<void> {
        const local = database.getOfflineSentMessages(bucketKey);
        const remainingMessages = local.messages.filter(msg => msg.timestamp > ackTimestamp);

        const cleanMessages = OfflineMessageManager.filterExpiredMessages(remainingMessages);

        // Only update if something changed
        if (cleanMessages.length === local.messages.length) {
            return;
        }

        const version = local.version + 1;

        // Sign the new store
        const signedStore = OfflineMessageManager.signStore(
            cleanMessages,
            version,
            bucketKey,
            signingPrivateKey
        );

        await OfflineMessageManager.putToDHT(node, bucketKey, signedStore);
        database.saveOfflineSentMessages(bucketKey, cleanMessages, version);

        console.log(`Cleared ${local.messages.length - cleanMessages.length} acknowledged messages from bucket`);
    }

    /**
     * Create a new offline message
     *
     * 1. Encrypt content and sender info with recipient's RSA public key
     * 2. Sign the hashes of encrypted data (for DHT validation)
     *
     * The signature is over: {content_hash, sender_info_hash, timestamp, bucket_key}
     * This allows DHT validators to verify writes without decryption.
     */
    static createOfflineMessage(
        senderPeerId: string,
        senderUsername: string,
        content: string,
        recipientPublicKey: string,           // RSA public key of recipient (PEM format)
        senderSigningPrivateKey: Uint8Array,  // Ed25519 private key for signing
        bucketKey: string,                    // Full bucket key for signature binding
        offlineAckTimestamp?: number          // Optional ACK for messages we've read from recipient's bucket
    ): OfflineMessage {
        // RSA-OAEP (Node default) max plaintext for a 2048-bit key: 256 - 2*20 - 2 = 214 bytes
        const RSA_MAX_PLAINTEXT = 214;

        try {
            const timestamp = Date.now();

            const contentBytes = Buffer.from(content, 'utf8');
            let encryptedContentB64: string;
            let encryptedAesKey: string | undefined;
            let aesIv: string | undefined;
            let messageType: 'encrypted' | 'hybrid';

            if (contentBytes.byteLength <= RSA_MAX_PLAINTEXT) {
                // Small enough to RSA-encrypt directly
                const encryptedContent = publicEncrypt(recipientPublicKey, contentBytes);
                encryptedContentB64 = encryptedContent.toString('base64');
                messageType = 'encrypted';
            } else {
                // Hybrid: AES-256-GCM for content, RSA for the AES key
                const aesKey = randomBytes(32);
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
                const ciphertext = Buffer.concat([cipher.update(contentBytes), cipher.final()]);
                const authTag = cipher.getAuthTag();
                // Prepend authTag (16 bytes) to ciphertext so decryptor can extract it
                encryptedContentB64 = Buffer.concat([authTag, ciphertext]).toString('base64');
                encryptedAesKey = publicEncrypt(recipientPublicKey, aesKey).toString('base64');
                aesIv = iv.toString('base64');
                messageType = 'hybrid';
            }

            // Encrypt sender info (peer_id, username, and optional ACK) with recipient's RSA public key
            const senderInfo: OfflineSenderInfo = {
                peer_id: senderPeerId,
                username: senderUsername,
            };
            if (offlineAckTimestamp) {
                senderInfo.offline_ack_timestamp = offlineAckTimestamp;
            }
            const encryptedSenderInfo = publicEncrypt(
                recipientPublicKey,
                Buffer.from(JSON.stringify(senderInfo), 'utf8')
            );
            const encryptedSenderInfoB64 = encryptedSenderInfo.toString('base64');

            const encryptedContentBuf = Buffer.from(encryptedContentB64, 'base64');
            const signedPayload: OfflineSignedPayload = {
                content_hash: Buffer.from(sha256(encryptedContentBuf)).toString('base64'),
                sender_info_hash: Buffer.from(sha256(encryptedSenderInfo)).toString('base64'),
                timestamp,
                bucket_key: bucketKey
            };

            const payloadBytes = new TextEncoder().encode(JSON.stringify(signedPayload));
            const signatureBytes = ed25519.sign(payloadBytes, senderSigningPrivateKey);
            const signature = Buffer.from(signatureBytes).toString('base64');

            return {
                id: randomUUID(),
                encrypted_sender_info: encryptedSenderInfoB64,
                content: encryptedContentB64,
                signature,
                signed_payload: signedPayload,
                message_type: messageType,
                ...(encryptedAesKey !== undefined && { encrypted_aes_key: encryptedAesKey }),
                ...(aesIv !== undefined && { aes_iv: aesIv }),
                timestamp,
                expires_at: timestamp + MESSAGE_TTL
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to create offline message:', errorMessage);
            throw error;
        }
    }

    static verifyOfflineMessageSignature(
        message: OfflineMessage,
        senderSigningPublicKey: string, // Ed25519 public key (base64)
        expectedBucketKey: string
    ): boolean {
        try {
            if (!message.signature || !message.signed_payload) {
                console.log('Skipping signature verification: missing signature or signed_payload');
                return false;
            }

            // 1. Verify signature over signed_payload
            const payloadBytes = new TextEncoder().encode(JSON.stringify(message.signed_payload));
            const signatureBytes = Buffer.from(message.signature, 'base64');
            const publicKeyBytes = Buffer.from(senderSigningPublicKey, 'base64');

            const isSignatureValid = ed25519.verify(signatureBytes, payloadBytes, publicKeyBytes);
            if (!isSignatureValid) {
                console.log('Offline message signature verification failed');
                return false;
            }

            // 2. Verify content_hash matches actual encrypted content
            const contentBytes = Buffer.from(message.content, 'base64');
            const actualContentHash = Buffer.from(sha256(contentBytes)).toString('base64');
            if (actualContentHash !== message.signed_payload.content_hash) {
                console.log('Offline message content_hash mismatch');
                return false;
            }

            // 3. Verify sender_info_hash matches actual encrypted sender info
            const senderInfoBytes = Buffer.from(message.encrypted_sender_info, 'base64');
            const actualSenderInfoHash = Buffer.from(sha256(senderInfoBytes)).toString('base64');
            if (actualSenderInfoHash !== message.signed_payload.sender_info_hash) {
                console.log('Offline message sender_info_hash mismatch');
                return false;
            }

            // 4. Verify bucket_key
            if (message.signed_payload.bucket_key !== expectedBucketKey) {
                console.log('Offline message bucket_key mismatch');
                return false;
            }

            return true;
        } catch (error: unknown) {
            generalErrorHandler(error);
            return false;
        }
    }

    private static async putToDHT(node: ChatNode, key: string, data: OfflineMessageStore): Promise<void> {
        const keyBytes = new TextEncoder().encode(key);
        const jsonBytes = Buffer.from(JSON.stringify(data), 'utf8');

        // Compress data with gzip before storing
        const compressedBytes = await gzipAsync(jsonBytes);

        console.log(`PUT to DHT - Key: ${key}, Original: ${jsonBytes.length} bytes`);
        console.log(`Compressed: ${compressedBytes.length} bytes (${Math.round((1 - compressedBytes.length / jsonBytes.length) * 100)}% reduction)`);

        try {
            let hadSuccess = false;
            let errorCount = 0;
            const events: QueryEvent[] = [];

            for await (const event of node.services.dht.put(keyBytes, compressedBytes) as AsyncIterable<QueryEvent>) {
                events.push(event);

                if (event.name === 'QUERY_ERROR') errorCount++;
                else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
            }
            if (errorCount > 0 && !hadSuccess) {
                throw new Error(`DHT PUT failed: All ${errorCount} peers unreachable`);
            }

            console.log(`DHT PUT completed with ${events.length} events`);

            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error: unknown) {
            generalErrorHandler(error, "PUT to DHT failed");
            throw error;
        }
    }

    private static isValidOfflineMessage(msg: unknown): msg is OfflineMessage {
        return typeof msg === 'object' && 
        msg !== null && 
        'id' in msg && 
        typeof msg.id === 'string' && 
        'encrypted_sender_info' in msg && 
        typeof msg.encrypted_sender_info === 'string' && 
        'content' in msg && 
        typeof msg.content === 'string' && 
        'signature' in msg && 
        typeof msg.signature === 'string' && 'signed_payload' in msg && typeof msg.signed_payload === 'object' && 'message_type' in msg && typeof msg.message_type === 'string' && 'timestamp' in msg && typeof msg.timestamp === 'number' && 'expires_at' in msg && typeof msg.expires_at === 'number';
    }
}
