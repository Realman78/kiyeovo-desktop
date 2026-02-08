import { ChatNode, StreamHandlerContext, ConversationSession, FileChunk, FileOffer, FileOfferResponse, FileTransferMessage, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, PendingFileReceivedEvent } from "../types";
import type { Stream } from "@libp2p/interface";
import { ChatDatabase, Chat } from "./db/database";
import { readFile, stat, writeFile, mkdir, access } from "fs/promises";
import { basename, extname } from "path";
import { blake3 } from "@napi-rs/blake-hash";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes, randomUUID } from "crypto";
import { pushable } from "it-pushable";
import { pipe } from "it-pipe";
import { StreamHandler } from "./stream-handler.js";
import mime from "mime-types";
import { CHUNK_SIZE, DOWNLOADS_DIR, FILE_ACCEPTANCE_TIMEOUT, FILE_OFFER, FILE_OFFER_RESPONSE, FILE_TRANSFER_PROTOCOL, MAX_FILE_MESSAGE_SIZE, MAX_FILE_SIZE, MAX_COPY_ATTEMPTS, CHUNK_RECEIVE_TIMEOUT, CHUNK_IDLE_TIMEOUT, FILE_OFFER_RATE_LIMIT, FILE_OFFER_RATE_LIMIT_WINDOW, MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL, FILE_REJECTION_COUNTER_RESET_INTERVAL, SILENT_REJECTION_THRESHOLD_GLOBAL, SILENT_REJECTION_THRESHOLD_PER_PEER } from "../constants.js";
import { MessageHandler } from "./message-handler.js";
import { generalErrorHandler } from "../utils/general-error.js";

interface FileMetadata {
  buffer: Buffer
  filename: string
  mimeType: string
  size: number
  checksum: string
  totalChunks: number
}

export class FileHandler {
  private node: ChatNode;
  private messageHandler: MessageHandler;
  private database: ChatDatabase;
  private pendingFileAcceptances = new Map<
    string,
    {
      resolve: (accepted: boolean) => void;
      reject: (error: Error) => void;
      offer: FileOffer;
      senderId: string;
      senderUsername: string;
      expiresAt: number;
      decision?: 'rejected' | 'expired';
    }
  >();
  private fileOfferTimestamps = new Map<string, number[]>();
  private perPeerPendingRejections = new Map<string, number>(); // Track "too many pending from you" rejections per peer
  private globalPendingRejectionsCount = 0; // Track total "too many global pending" rejections
  private onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  private onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  private onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  private onPendingFileReceived: (data: PendingFileReceivedEvent) => void;

  constructor(
    node: ChatNode,
    messageHandler: MessageHandler,
    database: ChatDatabase,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void
  ) {
    this.node = node;
    this.messageHandler = messageHandler;
    this.database = database;
    this.onFileTransferProgress = onFileTransferProgress;
    this.onFileTransferComplete = onFileTransferComplete;
    this.onFileTransferFailed = onFileTransferFailed;
    this.onPendingFileReceived = onPendingFileReceived;
    const expiredCount = this.database.expirePendingFileOffers(FILE_ACCEPTANCE_TIMEOUT);
    if (expiredCount > 0) {
      console.log(`[FileHandler] Expired ${expiredCount} pending file offer(s) on startup`);
    }
    const failedCount = this.database.failInProgressFileTransfers();
    if (failedCount > 0) {
      console.log(`[FileHandler] Marked ${failedCount} in-progress file transfer(s) as failed on startup`);
    }
    this.#setupProtocolHandler();
    this.#setupRejectionCounterReset();
  }

  // Get configuration values from database with fallback to constants
  private getMaxFileSize(): number {
    const setting = this.database.getSetting('max_file_size');
    return setting ? parseInt(setting, 10) : MAX_FILE_SIZE;
  }

  private getFileOfferRateLimit(): number {
    const setting = this.database.getSetting('file_offer_rate_limit');
    return setting ? parseInt(setting, 10) : FILE_OFFER_RATE_LIMIT;
  }

  private getMaxPendingFilesPerPeer(): number {
    const setting = this.database.getSetting('max_pending_files_per_peer');
    return setting ? parseInt(setting, 10) : MAX_PENDING_FILES_PER_PEER;
  }

  private getMaxPendingFilesTotal(): number {
    const setting = this.database.getSetting('max_pending_files_total');
    return setting ? parseInt(setting, 10) : MAX_PENDING_FILES_TOTAL;
  }

  private getSilentRejectionThresholdGlobal(): number {
    const setting = this.database.getSetting('silent_rejection_threshold_global');
    return setting ? parseInt(setting, 10) : SILENT_REJECTION_THRESHOLD_GLOBAL;
  }

  private getSilentRejectionThresholdPerPeer(): number {
    const setting = this.database.getSetting('silent_rejection_threshold_per_peer');
    return setting ? parseInt(setting, 10) : SILENT_REJECTION_THRESHOLD_PER_PEER;
  }

  // Reset rejection counters every 10 minutes to give users a fresh start
  #setupRejectionCounterReset(): void {
    setInterval(() => {
      const perPeerCount = this.perPeerPendingRejections.size;
      const globalCount = this.globalPendingRejectionsCount;

      if (perPeerCount > 0 || globalCount > 0) {
        console.log(`Resetting file rejection counters (per-peer: ${perPeerCount}, global: ${globalCount})`);
      }

      this.perPeerPendingRejections.clear();
      this.globalPendingRejectionsCount = 0;
    }, FILE_REJECTION_COUNTER_RESET_INTERVAL);
  }

  // Emit for first 5 chunks, then only every 10% increment
  #shouldEmitProgress(currentChunk: number, totalChunks: number, lastEmittedPercentage: number): { shouldEmit: boolean; newPercentage: number } {
    if (currentChunk <= 5) {
      const percentage = Math.floor((currentChunk / totalChunks) * 100);
      return { shouldEmit: true, newPercentage: percentage };
    }

    const currentPercentage = Math.floor((currentChunk / totalChunks) * 100);
    const percentageBucket = Math.floor(currentPercentage / 10) * 10; // Round down to nearest 10%
    const lastBucket = Math.floor(lastEmittedPercentage / 10) * 10;

    if (percentageBucket > lastBucket) {
      return { shouldEmit: true, newPercentage: currentPercentage };
    }

    return { shouldEmit: false, newPercentage: lastEmittedPercentage };
  }

  // Check if peer has exceeded file offer rate limit
  private isFileOfferRateLimitExceeded(peerId: string): boolean {
    const now = Date.now();
    const timestamps = this.fileOfferTimestamps.get(peerId) ?? [];

    const recentTimestamps = timestamps.filter(
      ts => now - ts < FILE_OFFER_RATE_LIMIT_WINDOW
    );

    this.fileOfferTimestamps.set(peerId, recentTimestamps);

    return recentTimestamps.length >= this.getFileOfferRateLimit();
  }

  // Track a new file offer from peer
  private trackFileOffer(peerId: string): void {
    const timestamps = this.fileOfferTimestamps.get(peerId) ?? [];
    timestamps.push(Date.now());
    this.fileOfferTimestamps.set(peerId, timestamps);
  }

  // Count pending files from specific peer
  private getPendingFilesFromPeer(peerId: string): number {
    return Array.from(this.pendingFileAcceptances.values())
      .filter(p => p.senderId === peerId)
      .length;
  }

  private getTotalPendingFiles(): number {
    return this.pendingFileAcceptances.size;
  }

  getPendingFiles(): Array<{ fileId: string; filename: string; size: number; senderId: string; senderUsername: string; expiresAt: number }> {
    return Array.from(this.pendingFileAcceptances.values()).map(p => ({
      fileId: p.offer.fileId,
      filename: p.offer.filename,
      size: p.offer.size,
      senderId: p.senderId,
      senderUsername: p.senderUsername,
      expiresAt: p.expiresAt
    }));
  }

  acceptPendingFile(fileId: string): void {
    const promise = this.pendingFileAcceptances.get(fileId);
    if (promise) {
      this.database.updateMessageTransfer(fileId, {
        transfer_status: 'in_progress'
      });
      promise.resolve(true);
      this.pendingFileAcceptances.delete(fileId);
    }
  }

  rejectPendingFile(fileId: string): void {
    const promise = this.pendingFileAcceptances.get(fileId);
    if (promise) {
      promise.decision = 'rejected';
      promise.resolve(false);
    }
  }

  #setupProtocolHandler(): void {
    void this.node.handle(FILE_TRANSFER_PROTOCOL, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);

      if (this.database.isBlocked(remoteId)) return stream.close();

      const chat = this.database.getChatByPeerId(remoteId);
      const session = this.messageHandler.getSessionManager().getSession(remoteId);

      if (!chat || !session) {
        return stream.close();
      }

      StreamHandler.logIncomingConnection(remoteId, FILE_TRANSFER_PROTOCOL);

      try {
        await this.#handleIncomingFile(remoteId, stream, chat, session);
      } catch (error: unknown) {
        generalErrorHandler(error, `Failed to handle incoming file`);
      }
    });
  }

  async #handleIncomingFile(
    senderPeerId: string,
    stream: Stream,
    chat: Chat,
    session: ConversationSession
  ): Promise<void> {
    const writable = pushable();
    const sinkPromise = pipe(writable, stream.sink);

    let offer: FileOffer | null = null;
    let chunkTimeout: NodeJS.Timeout | null = null;
    let lastEmittedPercentage = 0;

    try {
      let buffer = new Uint8Array(0);
      const receivedChunks: Map<number, Buffer> = new Map();

      for await (const chunk of stream.source) {
        const chunkData = (chunk as unknown as Uint8Array).subarray();

        // Memory Guard: Prevent buffer from growing indefinitely for JSON messages
        if (buffer.length + chunkData.length > MAX_FILE_MESSAGE_SIZE) {
          throw new Error('Incoming message buffer exceeded limit');
        }

        const newBuffer = new Uint8Array(buffer.length + chunkData.length);
        newBuffer.set(buffer);
        newBuffer.set(chunkData, buffer.length);
        buffer = newBuffer;

        for (;;) {
          const decoded = this.#decodeMessage(buffer);
          if (!decoded) break;

          buffer = buffer.slice(decoded.bytesRead);
          const message = decoded.message;

          if (message.type === FILE_OFFER) {
            const offerMsg = message;
            offer = offerMsg;

            // Global pending files limit
            const maxPendingTotal = this.getMaxPendingFilesTotal();
            if (this.getTotalPendingFiles() >= maxPendingTotal) {
              this.globalPendingRejectionsCount++;

              // After N rejections, switch to silent rejection (save bandwidth)
              const silentThreshold = this.getSilentRejectionThresholdGlobal();
              if (this.globalPendingRejectionsCount > silentThreshold) {
                console.log(`Silently rejecting file offer (global pending limit, rejection #${this.globalPendingRejectionsCount})`);
                return;
              }

              // Normal rejection (first 20 times)
              console.log(`File rejected: too many pending file transfers (${this.getTotalPendingFiles()}/${maxPendingTotal})`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Too many pending file transfers',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Per-peer pending files limit
            const pendingFromPeer = this.getPendingFilesFromPeer(senderPeerId);
            const maxPendingPerPeer = this.getMaxPendingFilesPerPeer();
            if (pendingFromPeer >= maxPendingPerPeer) {
              const rejectionCount = (this.perPeerPendingRejections.get(senderPeerId) ?? 0) + 1;
              this.perPeerPendingRejections.set(senderPeerId, rejectionCount);

              // After N rejections to this peer, switch to silent rejection (save bandwidth)
              const silentThreshold = this.getSilentRejectionThresholdPerPeer();
              if (rejectionCount > silentThreshold) {
                console.log(`Silently rejecting file from ${senderPeerId.slice(0, 8)}... (too many pending limit hit ${rejectionCount} times)`);
                return;
              }

              // Normal rejection (first 5 times)
              console.log(`File rejected: too many pending files from ${senderPeerId.slice(0, 8)}... (${pendingFromPeer}/${maxPendingPerPeer})`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Too many pending files from you',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Rate limiting check (offers per minute)
            if (this.isFileOfferRateLimitExceeded(senderPeerId)) {
              console.log(`File rejected: rate limit exceeded from ${senderPeerId.slice(0, 8)}...`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Rate limit exceeded',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Track this file offer
            this.trackFileOffer(senderPeerId);

            // Validate filename - reject path traversal attempts
            const sanitizedFilename = basename(offerMsg.filename);
            if (sanitizedFilename !== offerMsg.filename) {
              console.log(`File rejected: filename contains path traversal characters`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Invalid filename',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Validate filename length
            if (sanitizedFilename.length > 255 || sanitizedFilename.length === 0) {
              console.log(`File rejected: filename too long or empty`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Invalid filename length',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            console.log(`File offer: ${sanitizedFilename}, ${offerMsg.size} bytes`);

            const sender = this.database.getUserByPeerId(senderPeerId);
            if (!sender) {
              console.log(`File rejected: sender not in contacts (first message cannot be file transfer)`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Sender not in contacts',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Validate file size
            const maxFileSize = this.getMaxFileSize();
            if (offer.size > maxFileSize || offer.size <= 0) {
              console.log(`File rejected: invalid size (${offer.size} bytes, max ${maxFileSize} bytes)`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'File size invalid',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Validate totalChunks
            const expectedChunks = Math.ceil(offer.size / CHUNK_SIZE);
            if (offer.totalChunks !== expectedChunks || offer.totalChunks <= 0) {
              console.log(`File rejected: invalid chunk count (expected ${expectedChunks}, got ${offer.totalChunks})`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offer.fileId,
                accepted: false,
                reason: 'Invalid chunk count',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // Persist pending offer as a message (single row per file)
            await this.database.createMessage({
              id: offerMsg.fileId,
              chat_id: chat.id,
              sender_peer_id: senderPeerId,
              content: `${offerMsg.filename} (${offerMsg.size} bytes)`,
              message_type: 'file',
              file_name: offerMsg.filename,
              file_size: offerMsg.size,
              transfer_status: 'pending',
              transfer_progress: 0,
              timestamp: new Date(),
            });

            // Emit pending file received event
            const expiresAt = Date.now() + FILE_ACCEPTANCE_TIMEOUT;
            if (this.onPendingFileReceived) {
              this.onPendingFileReceived({
                chatId: chat.id,
                fileId: offerMsg.fileId,
                filename: offerMsg.filename,
                size: offerMsg.size,
                senderId: senderPeerId,
                senderUsername: sender.username,
                expiresAt
              });
            }

            // Prompt user for acceptance
            console.log(`\nFile Transfer Request from ${sender.username}`);
            console.log(`   File: ${offerMsg.filename}`);
            console.log(`   Size: ${offerMsg.size} bytes (${Math.round(offerMsg.size / 1024 / 1024 * 100) / 100} MB)`);
            console.log(`   To accept: accept-file ${offerMsg.fileId}`);
            console.log(`   To reject: reject-file ${offerMsg.fileId}\n`);

            // Wait for user decision with timeout
            const acceptancePromise = new Promise<boolean>((resolve, reject) => {
              this.pendingFileAcceptances.set(offerMsg.fileId, {
                resolve,
                reject,
                offer: offerMsg,
                senderId: senderPeerId,
                senderUsername: sender.username,
                expiresAt
              });
            });

            const timeoutPromise = new Promise<boolean>((resolve) => {
              setTimeout(() => {
                const pending = this.pendingFileAcceptances.get(offerMsg.fileId);
                if (pending) {
                  pending.decision = 'expired';
                }
                resolve(false);
              }, FILE_ACCEPTANCE_TIMEOUT);
            });

            // eslint-disable-next-line no-await-in-loop
            const accepted = await Promise.race([acceptancePromise, timeoutPromise]);

            if (!accepted) {
              const pending = this.pendingFileAcceptances.get(offerMsg.fileId);
              const decision = pending?.decision ?? 'expired';
              const transferStatus = decision === 'rejected' ? 'rejected' : 'expired';
              const transferError = decision === 'rejected' ? 'Offer rejected' : 'Offer expired';

              this.database.updateMessageTransfer(offerMsg.fileId, {
                transfer_status: transferStatus,
                transfer_progress: 0,
                transfer_error: transferError
              });

              this.pendingFileAcceptances.delete(offerMsg.fileId);

              console.log(`File transfer from ${sender.username} expired or rejected`);
              console.log(`To block future file transfers from ${sender.username}, use: block-user ${sender.username}`);
              const response: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offerMsg.fileId,
                accepted: false,
                reason: 'User rejected or timeout',
              };
              writable.push(this.#encodeMessage(response));
              return;
            }

            // User accepted - start chunk timeout
            console.log(`File transfer accepted, receiving chunks...`);
            const response: FileOfferResponse = {
              type: FILE_OFFER_RESPONSE,
              fileId: offerMsg.fileId,
              accepted: true,
            };
            writable.push(this.#encodeMessage(response));

            // Set per-chunk idle timeout (resets after each chunk received)
            // If no chunk is received for CHUNK_IDLE_TIMEOUT, transfer is stalled
            chunkTimeout = setTimeout(() => {
              try {
                stream.abort(new Error('Chunk receive timeout - no data received for 60 seconds'));
              } catch (error: unknown) {
                generalErrorHandler(error, 'Error aborting stream');
              }
            }, CHUNK_IDLE_TIMEOUT);

          } else if (message.type === 'file_chunk') {
            if (!offer) throw new Error('Received chunk before offer');

            const fileChunk = message;

            // Validate chunk index bounds
            if (fileChunk.index < 0 || fileChunk.index >= offer.totalChunks) {
              throw new Error(`Invalid chunk index ${fileChunk.index} (expected 0-${offer.totalChunks - 1})`);
            }

            // Detect duplicate chunks (potential memory exhaustion attack)
            if (receivedChunks.has(fileChunk.index)) {
              throw new Error(`Duplicate chunk ${fileChunk.index}`);
            }

            // Decrypt chunk
            const nonce = Buffer.from(fileChunk.nonce, 'base64');
            const encrypted = Buffer.from(fileChunk.data, 'base64');
            const cipher = xchacha20poly1305(session.receivingKey, nonce);
            const decrypted = Buffer.from(cipher.decrypt(encrypted));

            // Verify chunk hash
            const actualHash = blake3(decrypted).toString('hex');
            if (actualHash !== fileChunk.hash) {
              throw new Error(`Chunk ${fileChunk.index} hash mismatch`);
            }

            receivedChunks.set(fileChunk.index, decrypted);
            console.log(`Received chunk ${fileChunk.index + 1}/${offer.totalChunks}`);

            if (chunkTimeout) {
              clearTimeout(chunkTimeout);
              const currentChunk = fileChunk.index + 1;
              const totalChunks = offer.totalChunks;
              chunkTimeout = setTimeout(() => {
                try {
                  stream.abort(new Error(`Chunk receive timeout - stalled at chunk ${currentChunk}/${totalChunks}`));
                } catch (error: unknown) {
                  generalErrorHandler(error, 'Error aborting stream');
                }
              }, CHUNK_IDLE_TIMEOUT);
            }

            // Emit progress event (throttled: first 5 chunks, then every 10%)
            if (this.onFileTransferProgress) {
              const { shouldEmit, newPercentage } = this.#shouldEmitProgress(
                fileChunk.index + 1,
                offer.totalChunks,
                lastEmittedPercentage
              );
              if (shouldEmit) {
                lastEmittedPercentage = newPercentage;
                this.onFileTransferProgress({
                  chatId: chat.id,
                  messageId: offer.fileId,
                  current: fileChunk.index + 1,
                  total: offer.totalChunks,
                  filename: offer.filename,
                  size: offer.size
                });
              }
            }
          }
        }
      }

      if (!offer) throw new Error('No offer received');

      const fileBuffer = Buffer.concat(
        Array.from({ length: offer.totalChunks }, (_, i) => {
          const chunk = receivedChunks.get(i);
          if (!chunk) throw new Error('Chunk not found');
          return chunk;
        })
      );

      const actualChecksum = blake3(fileBuffer).toString('hex');
      if (actualChecksum !== offer.checksum) {
        throw new Error(`File checksum mismatch`);
      }

      // Clear chunk timeout on successful completion
      if (chunkTimeout) {
        clearTimeout(chunkTimeout);
        chunkTimeout = null;
      }

      // Get downloads directory from settings or use default
      const downloadsDir = this.database.getSetting('downloads_directory') || DOWNLOADS_DIR;
      await mkdir(downloadsDir, { recursive: true });

      // Find unique filename by adding "_copy", "_copy2", "_copy3", etc.
      const sanitizedFilename = basename(offer.filename);
      let savePath = `${downloadsDir}/${sanitizedFilename}`;
      let copyCounter = 0;

      while (copyCounter < MAX_COPY_ATTEMPTS) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await access(savePath);
          copyCounter++;
          const ext = extname(sanitizedFilename);
          const nameWithoutExt = basename(sanitizedFilename, ext);
          const suffix = copyCounter === 1 ? '_copy' : `_copy${copyCounter}`;
          savePath = `${downloadsDir}/${nameWithoutExt}${suffix}${ext}`;
        } catch {
          break;
        }
      }

      if (copyCounter >= MAX_COPY_ATTEMPTS) {
        throw new Error('Too many copies of this file already exist');
      }

      await writeFile(savePath, fileBuffer);
      console.log(`Saved to ${savePath}`);
      const messageId = offer.fileId;
        this.database.updateMessageTransfer(messageId, {
          file_name: offer.filename,
          file_size: offer.size,
          file_path: savePath,
          transfer_status: 'completed',
          transfer_progress: 100
        });

      // Emit completion event
      if (this.onFileTransferComplete) {
        this.onFileTransferComplete({
          chatId: chat.id,
          messageId: messageId,
          filePath: savePath
        });
      }
    } catch (error: unknown) {
      // Emit failure event
      if (offer && this.onFileTransferFailed) {
        this.onFileTransferFailed({
          chatId: chat.id,
          messageId: offer.fileId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      if (offer && (error instanceof Error)) {
        const response: FileOfferResponse = {
          type: FILE_OFFER_RESPONSE,
          fileId: offer.fileId,
          accepted: false,
          reason: error.message,
        };
        writable.push(this.#encodeMessage(response));
      }
      throw error;
    } finally {
      // Clear chunk timeout if still active
      if (chunkTimeout) {
        clearTimeout(chunkTimeout);
      }

      // Clean up pending acceptance if exists
      if (offer) {
        this.pendingFileAcceptances.delete(offer.fileId);
      }

      writable.end();
      await sinkPromise;
    }
  }

  async #loadFileMetadata(filePath: string): Promise<FileMetadata> {
    const fileStats = await stat(filePath);
    const buffer = await readFile(filePath);
    const filename = basename(filePath);
    const checksum = blake3(buffer).toString('hex');
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';

    return {
      buffer,
      filename,
      mimeType,
      size: fileStats.size,
      checksum,
      totalChunks,
    };
  }

  #createEncryptedChunks(
    buffer: Buffer,
    fileId: string,
    session: ConversationSession
  ): FileChunk[] {
    const chunks: FileChunk[] = [];
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, buffer.length);
      const chunkData = buffer.subarray(start, end);

      // Verification
      const hash = blake3(chunkData).toString('hex');

      const nonce = randomBytes(24);
      const cipher = xchacha20poly1305(session.sendingKey, nonce);
      const encrypted = cipher.encrypt(chunkData);

      chunks.push({
        type: 'file_chunk',
        fileId,
        index: i,
        nonce: Buffer.from(nonce).toString('base64'),
        data: Buffer.from(encrypted).toString('base64'),
        hash,
      });
    }

    return chunks;
  }

  // Length-prefixed message: [4 bytes length][JSON data]
  #encodeMessage(message: FileTransferMessage): Uint8Array {
    const json = JSON.stringify(message);
    const jsonBytes = new TextEncoder().encode(json);
    const result = new Uint8Array(4 + jsonBytes.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, jsonBytes.length, false); // big-endian
    result.set(jsonBytes, 4);
    return result;
  }

  #decodeMessage(data: Uint8Array): { message: FileTransferMessage; bytesRead: number } | null {
    if (data.length < 4) return null;
    const view = new DataView(data.buffer, data.byteOffset);
    const length = view.getUint32(0, false);
    if (data.length < 4 + length) return null;
    const jsonBytes = data.slice(4, 4 + length);
    const json = new TextDecoder().decode(jsonBytes);
    return { message: JSON.parse(json) as FileTransferMessage, bytesRead: 4 + length };
  }

  async sendFile(targetUsername: string, filePath: string): Promise<void> {
    let chat: any = null;
    let fileId: string = '';
    try {
      const { session, peerId: targetPeerId } = await this.messageHandler.ensureUserSession(targetUsername, '', true);
      chat = this.database.getChatByPeerId(targetPeerId.toString());
      if (chat?.type !== 'direct' || !chat.id) throw new Error('Chat not found');

      // Validate file size before loading metadata
      const fileStats = await stat(filePath);
      const maxFileSize = this.getMaxFileSize();
      if (fileStats.size > maxFileSize) {
        throw new Error(`File too large (${fileStats.size} bytes, max ${maxFileSize} bytes)`);
      }
      if (fileStats.size <= 0) {
        throw new Error('File is empty');
      }

      const metadata = await this.#loadFileMetadata(filePath);
      fileId = randomUUID();

      console.log(`Sending ${metadata.filename} (${metadata.size} bytes, ${metadata.totalChunks} chunks)`);

      const stream = await this.node.dialProtocol(targetPeerId, FILE_TRANSFER_PROTOCOL);

      const writable = pushable();
      const sinkPromise = pipe(writable, stream.sink);

      try {
        await this.database.createMessage({
          id: fileId,
          chat_id: chat.id,
          sender_peer_id: this.node.peerId.toString(),
          content: `${metadata.filename} (${metadata.size} bytes)`,
          message_type: 'file',
          file_name: metadata.filename,
          file_size: metadata.size,
          transfer_status: 'pending',
          transfer_progress: 0,
          timestamp: new Date(),
        });

        const offer: FileOffer = {
          type: FILE_OFFER,
          fileId,
          filename: metadata.filename,
          mimeType: metadata.mimeType,
          size: metadata.size,
          checksum: metadata.checksum,
          totalChunks: metadata.totalChunks,
        };
        writable.push(this.#encodeMessage(offer));
        console.log(`Sent file offer, waiting for response...`);

        let buffer = new Uint8Array(0);
        let response: FileOfferResponse | null = null;

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => { reject(new Error('Timeout waiting for file acceptance')); }, FILE_ACCEPTANCE_TIMEOUT)
        );

        const readResponse = async (): Promise<FileOfferResponse> => {
          for await (const chunk of stream.source) {
            const chunkData = (chunk as unknown as Uint8Array).subarray();
            const newBuffer = new Uint8Array(buffer.length + chunkData.length);
            newBuffer.set(buffer);
            newBuffer.set(chunkData, buffer.length);
            buffer = newBuffer;

            const decoded = this.#decodeMessage(buffer);
            if (decoded) {
              buffer = buffer.slice(decoded.bytesRead);
              return decoded.message as FileOfferResponse;
            }
          }
          throw new Error('Stream closed before response');
        };

        response = await Promise.race([readResponse(), timeoutPromise]);

        if (!response.accepted) {
          const reason = response.reason || 'Rejected';
          console.log(`File rejected by ${targetUsername}${response.reason ? `: ${response.reason}` : ''}`);
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'rejected',
            transfer_progress: 0,
            transfer_error: `Offer rejected: ${reason}`
          });
          throw new Error(`File rejected: ${reason}`);
        }
        console.log(`File accepted, sending chunks...`);

        // Send chunks sequentially
        const chunks = this.#createEncryptedChunks(metadata.buffer, fileId, session);
        let lastEmittedPercentage = 0;
        for (const chunk of chunks) {
          writable.push(this.#encodeMessage(chunk));
          console.log(`Sent chunk ${chunk.index + 1}/${chunks.length}`);

          // Emit progress event (throttled: first 5 chunks, then every 10%)
          if (this.onFileTransferProgress) {
            const { shouldEmit, newPercentage } = this.#shouldEmitProgress(
              chunk.index + 1,
              chunks.length,
              lastEmittedPercentage
            );
            if (shouldEmit) {
              lastEmittedPercentage = newPercentage;
              this.onFileTransferProgress({
                chatId: chat.id,
                messageId: fileId,
                current: chunk.index + 1,
                total: chunks.length,
                filename: metadata.filename,
                size: metadata.size
              });
            }
          }
        }

        console.log(`All chunks sent`);
        const messageId = fileId;
        this.database.updateMessageTransfer(messageId, {
          file_name: metadata.filename,
          file_size: metadata.size,
          file_path: filePath,
          transfer_status: 'completed',
          transfer_progress: 100
        });


        // Emit completion event
        if (this.onFileTransferComplete) {
          this.onFileTransferComplete({
            chatId: chat.id,
            messageId: messageId,
            filePath: filePath // For sender, filePath is the source file
          });
        }
      } finally {
        writable.end();
        await sinkPromise;
      }
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : 'Unknown error';
      if (fileId) {
        if (errorText.toLowerCase().includes('timeout waiting for file acceptance')) {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'expired',
            transfer_progress: 0,
            transfer_error: 'Offer expired'
          });
        } else if (errorText.toLowerCase().includes('file rejected')) {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'rejected',
            transfer_progress: 0,
            transfer_error: errorText
          });
        } else {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'failed',
            transfer_progress: 0,
            transfer_error: errorText
          });
        }
      }
      if (this.onFileTransferFailed && chat) {
        this.onFileTransferFailed({
          chatId: chat.id,
          messageId: fileId,
          error: errorText
        });
      }

      generalErrorHandler(error);
      throw error;
    }
  }
}
