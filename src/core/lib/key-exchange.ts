import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { Stream } from '@libp2p/interface';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import type { ChatNode, ConversationSession, AuthenticatedEncryptedMessage, MessageToVerify, PendingAcceptance, UserRegistration } from '../types.js';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { SessionManager } from './session-manager.js';
import { CHAT_PROTOCOL, KEY_EXCHANGE_RATE_LIMIT_DEFAULT, KEY_ROTATION_TIMEOUT, MAX_KEY_EXCHANGE_AGE, PENDING_KEY_EXCHANGE_EXPIRATION, RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW, ROTATION_COOLDOWN } from '../constants.js';
import { Chat, ChatDatabase, User } from './db/database.js';
import { toBase64Url } from './base64url.js';
import { UsernameRegistry } from './username-registry.js';
import { StreamHandler } from './stream-handler.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { OFFLINE_BUCKET_PREFIX } from './offline-message-validator.js';

/**
 * Handles authenticated key exchange protocol
 */
export class KeyExchange {
  private node: ChatNode;
  private usernameRegistry: UsernameRegistry;
  private sessionManager: SessionManager;
  private readonly KEY_ROTATION_THRESHOLD = 15; // Rotate keys every 15 messages
  private rotationPromises = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void }>();
  private rotationTimeouts = new Map<string, NodeJS.Timeout>();
  private database: ChatDatabase;
  private pendingAcceptances = new Map<string, PendingAcceptance>();

  constructor(
    node: ChatNode,
    usernameRegistry: UsernameRegistry,
    sessionManager: SessionManager,
    database: ChatDatabase,
  ) {
    this.node = node;
    this.usernameRegistry = usernameRegistry;
    this.sessionManager = sessionManager;
    this.database = database;
  }

  acceptPendingContact(senderPeerId: string): void {
    const promise = this.pendingAcceptances.get(senderPeerId);
    if (promise) {
      promise.resolve(true);
      this.pendingAcceptances.delete(senderPeerId);
    }
  }

  rejectPendingContact(senderPeerId: string): void {
    const promise = this.pendingAcceptances.get(senderPeerId);
    if (promise) {
      promise.resolve(false);
      this.pendingAcceptances.delete(senderPeerId);
    }
  }

  private rejectRotationPromise(remoteId: string, error: Error): void {
    const promise = this.rotationPromises.get(remoteId);
    if (promise) {
      promise.reject(error);
      this.rotationPromises.delete(remoteId);
    }

    // Clear associated timeout to prevent session clearing after successful rotation
    const timeoutId = this.rotationTimeouts.get(remoteId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.rotationTimeouts.delete(remoteId);
    }
  }

  private resolveRotationPromise(remoteId: string, success: boolean): void {
    const promise = this.rotationPromises.get(remoteId);
    if (promise) {
      promise.resolve(success);
      this.rotationPromises.delete(remoteId);
    }

    const timeoutId = this.rotationTimeouts.get(remoteId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.rotationTimeouts.delete(remoteId);
    }
  }

  /**
   * Verify signature with DB data first, DHT fallback on failure.
   */
  private async verifySignatureWithFallback(
    signature: string,
    message: MessageToVerify,
    username: string,
    peerId: string
  ): Promise<{ valid: boolean; signingPublicKey: string | null }> {
    const dbUser = this.database.getUserByPeerId(peerId);
    if (dbUser?.signing_public_key) {
      const valid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature, message, dbUser.signing_public_key
      );

      if (valid) {
        return { valid: true, signingPublicKey: dbUser.signing_public_key };
      }
    }

    // DB verification failed or no DB key -> DHT fallback
    try {
      const userRegistration = await this.usernameRegistry.lookup(username);
      if (userRegistration.peerID !== peerId) {
        return { valid: false, signingPublicKey: null };
      }

      const valid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature, message, userRegistration.signingPublicKey
      );

      if (dbUser) {
        this.database.updateUserKeys({
          peer_id: peerId,
          signing_public_key: userRegistration.signingPublicKey,
          offline_public_key: userRegistration.offlinePublicKey,
          signature: userRegistration.signature
        });
      } else {
        await this.database.createUser({
          peer_id: peerId,
          username: username,
          signing_public_key: userRegistration.signingPublicKey,
          offline_public_key: userRegistration.offlinePublicKey,
          signature: userRegistration.signature
        });
      }

      return { valid, signingPublicKey: userRegistration.signingPublicKey };
    } catch (error: unknown) {
      generalErrorHandler(error);
      return { valid: false, signingPublicKey: null };
    }
  }

  // Derive directional send/receive keys from ECDH shared secret using HKDF-SHA256
  private deriveDirectionalKeys(
    localEphemeralPublicKey: Uint8Array,
    localEphemeralPrivateKey: Uint8Array,
    remoteEphemeralPublicKey: string,
    role: 'initiator' | 'responder'
  ): { sendingKey: Uint8Array; receivingKey: Uint8Array; sharedSecret: Uint8Array } {

    const remoteEphemeralKey = Buffer.from(remoteEphemeralPublicKey, 'base64');
    const sharedSecret = x25519.getSharedSecret(localEphemeralPrivateKey, remoteEphemeralKey);
    // Stable salt based on both public keys (sorted lexicographically)
    const a = Buffer.from(localEphemeralPublicKey);
    const b = remoteEphemeralKey;
    const [first, second] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    const salt = sha256(new Uint8Array(Buffer.concat([first, second])));

    // Use constant info so both peers derive identical OKM; use role only for mapping
    const infoStr = 'kiyeovo-hkdf-v1';
    const info = new TextEncoder().encode(infoStr);

    const okm = hkdf(sha256, sharedSecret, salt, info, 64);
    const k1 = okm.slice(0, 32);
    const k2 = okm.slice(32, 64);
    if (role === 'initiator') {
      return { sendingKey: k1, receivingKey: k2, sharedSecret };
    } else {
      return { sendingKey: k2, receivingKey: k1, sharedSecret };
    }
  }

  private deriveOfflineBucketSecret(
    sharedSecret: Uint8Array,
    myPeerId: string,
    remotePeerId: string,
  ): string {
    const [first, second] = Buffer.compare(
      Buffer.from(myPeerId),
      Buffer.from(remotePeerId)) <= 0 ?
      [Buffer.from(myPeerId), Buffer.from(remotePeerId)] :
      [Buffer.from(remotePeerId), Buffer.from(myPeerId)];
    const salt = sha256(new Uint8Array(Buffer.concat([first, second])));

    // Use constant info so both peers derive identical OKM
    const infoStr = 'kiyeovo-hkdf-offline';
    const info = new TextEncoder().encode(infoStr);

    const secretBytes = hkdf(sha256, sharedSecret, salt, info, 32);
    return toBase64Url(secretBytes);
  }

  public constructWriteBucketKey(offlineBucketSecret: string): string {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }
    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    return `${OFFLINE_BUCKET_PREFIX}/${offlineBucketSecret}/${ourPubKeyBase64url}`;
  }

  public constructReadBucketKey(offlineBucketSecret: string, peerSigningPubKeyBase64: string): string {
    const peerPubKeyBytes = Buffer.from(peerSigningPubKeyBase64, 'base64');
    const peerPubKeyBase64url = toBase64Url(peerPubKeyBytes);
    return `${OFFLINE_BUCKET_PREFIX}/${offlineBucketSecret}/${peerPubKeyBase64url}`;
  }

  private deriveNotificationsBucketKey(
    sharedSecret: Uint8Array,
    myPeerId: string,
    remotePeerId: string,
  ): Uint8Array {
    const [first, second] = Buffer.compare(
      Buffer.from(myPeerId),
      Buffer.from(remotePeerId)) <= 0 ? [Buffer.from(myPeerId), Buffer.from(remotePeerId)] :
      [Buffer.from(remotePeerId), Buffer.from(myPeerId)];
    const salt = sha256(new Uint8Array(Buffer.concat([second, first])));

    // Use constant info so both peers derive identical OKM; use role only for mapping
    const infoStr = 'kiyeovo-hkdf-notifications';
    const info = new TextEncoder().encode(infoStr);

    const bucketKey = hkdf(sha256, sharedSecret, salt, info, 32);
    return bucketKey;
  }

  //Initiate a key exchange with a target peer
  async initiateKeyExchange(targetPeerId: PeerId, targetUsername: string): Promise<User | null> {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('No user identity available');
    }

    const currentUsername = this.usernameRegistry.getCurrentUsername();
    if (!currentUsername) {
      throw new Error('No current username available');
    }

    // Check for recent failed attempts (sender-side rate limiting)
    const recentFailure = this.database.getRecentFailedKeyExchange(targetPeerId.toString(), 5);
    if (recentFailure || this.sessionManager.getPendingKeyExchange(targetPeerId.toString())) {
      throw new Error(`Rate limit: You must wait before contacting ${targetUsername} again`);
    }

    const ephemeralPrivateKey = x25519.utils.randomSecretKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

    const timestamp = Date.now();
    const signFields = {
      type: 'key_exchange' as const,
      content: 'key_exchange_init' as const,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      senderUsername: currentUsername,
      timestamp: timestamp,
    };
    const stringifiedSignFields = JSON.stringify(signFields);

    const signature = userIdentity.sign(stringifiedSignFields);
    const signatureBase64 = Buffer.from(signature).toString('base64');

    const keyExchangeMessage: AuthenticatedEncryptedMessage = {
      signature: signatureBase64,
      ...signFields
    };

    const stream = await this.node.dialProtocol(targetPeerId, CHAT_PROTOCOL);
    const messageJson = JSON.stringify(keyExchangeMessage);

    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(messageJson)]);

    this.sessionManager.storePendingKeyExchange(targetPeerId.toString(), {
      timestamp: timestamp,
      ephemeralPrivateKey,
      ephemeralPublicKey
    });

    // Wait for response (2 minutes for user to accept)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => { reject(new Error('Key exchange timeout')); }, PENDING_KEY_EXCHANGE_EXPIRATION)
    );

    try {
      const user = await Promise.race([
        this.waitForKeyExchangeResponse(targetPeerId.toString(), stream),
        timeoutPromise.then(() => null)
      ]);
      if (!user) {
        throw new Error('Key exchange timed out or failed');
      }
      console.log(`Authenticated key exchange completed with ${targetPeerId.toString().slice(0, 8)}`);
      return user;
    } catch (error: unknown) {
      generalErrorHandler(error);
      this.sessionManager.removePendingKeyExchange(targetPeerId.toString());

      if (error instanceof Error && !error.message.includes('Rate limit')) {
        this.database.logFailedKeyExchange(targetPeerId.toString(), targetUsername, error.message);
      }

      throw error;
    }
  }

  /**
   * Handle incoming key exchange messages
   */
  async handleKeyExchange(remoteId: string, message: AuthenticatedEncryptedMessage, stream: Stream): Promise<void> {
    if (!message.ephemeralPublicKey) {
      console.error('Key exchange message missing ephemeral public key');
      return;
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      console.error('No user identity available for key exchange');
      return;
    }

    const currentUsername = this.usernameRegistry.getCurrentUsername();
    if (!currentUsername) {
      console.error('No current username available');
      return;
    }

    try {
      if (message.content === 'key_exchange_init') {
        await this.handleKeyExchangeInit(remoteId, message, stream, userIdentity, currentUsername);
      } else if (message.content === 'key_rotation') {
        await this.handleKeyRotation(remoteId, message, userIdentity, currentUsername);
      } else if (message.content === 'key_rotation_response') {
        await this.handleKeyRotationResponse(remoteId, message);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to handle key exchange message');
    }
  }

  //Validate key exchange init message fields and freshness
  private validateKeyExchangeInit(message: AuthenticatedEncryptedMessage): void {
    if (!message.signature || !message.senderUsername) {
      throw new Error('Key exchange init missing signature or sender username');
    }

    if (!message.ephemeralPublicKey) {
      throw new Error('Key exchange init missing ephemeral public key');
    }

    if (message.type !== 'key_exchange') {
      throw new Error('Key exchange init message has invalid type');
    }

    // Replay attack prevention
    const messageAge = Date.now() - message.timestamp;
    if (messageAge > MAX_KEY_EXCHANGE_AGE || messageAge < 0) {
      throw new Error('Key exchange message too old or future-dated');
    }
  }

  //Authorize contact request based on contact mode and existing relationship
  private async authorizeContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
  ): Promise<UserRegistration | User | null> {
    const senderUsername = message.senderUsername;

    // Check if sender is blocked (silent rejection - no error message)
    const isBlocked = this.database.isBlocked(remoteId);
    if (isBlocked) {
      console.log(`Blocked key exchange from ${senderUsername}`);
      return null;
    }

    // Check if we already have a chat with this person (auto-accept existing contacts)
    const existingChat = this.database.getChatByPeerId(remoteId);
    if (existingChat) {
      console.log(`Existing contact ${senderUsername} - auto-accepting key exchange`);
      const sender = this.database.getUserByPeerId(remoteId);
      if (!sender) {
        throw new Error('Sender not found in database.');
      }
      return sender;
    }

    // New contact - check contact mode
    const contactMode = this.database.getContactMode();

    if (contactMode === 'block') {
      console.log(`Contact mode is 'block' - ignoring request from ${senderUsername}`);
      return null;
    }

    // Check for duplicate pending requests
    const pendingKeyExchange = this.getPendingAcceptanceByPeerId(remoteId);
    if (pendingKeyExchange) {
      console.log(`Sender already has a pending key exchange`);
      return null;
    }

    // Check if user has contacted me recently
    if (this.didUserContactMeRecently(remoteId)) {
      console.log(`User has contacted me recently - rejecting contact request from ${senderUsername}`);
      return null;
    }

    // Rate limiting check
    if (this.isKeyExchangeRateLimitExceeded()) {
      console.log(`Rate limit exceeded - rejecting contact request from ${senderUsername}`);
      return null;
    }

    // Silent mode - just log the attempt
    const contactAttemptId = this.database.logContactAttempt({
      sender_peer_id: remoteId,
      sender_username: senderUsername,
      message: `Contact request (key exchange init)`,
      timestamp: Date.now()
    });
    if (contactMode === 'silent') {
      console.log(`Logged contact attempt from ${senderUsername} (silent mode)`);
      return null;
    }

    // Active mode
    return await this.handleActiveContactRequest(remoteId, message, contactAttemptId);
  }

  // Handle contact request in active mode (with user prompt and timeout)
  private async handleActiveContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    contactAttemptId: number,
  ): Promise<UserRegistration | User> {
    const senderUsername = message.senderUsername;

    if (!message.ephemeralPublicKey || !message.signature) {
      throw new Error('Key exchange missing signature or ephemeral public key - this should never happen');
    }

    // Show prompt to user
    console.log(`\n Contact Request from ${senderUsername}`);
    console.log(`   Message: "${message.content || 'wants to contact you'}"`);
    console.log(`   Expires in 2 minutes`);
    console.log(`   To accept: accept-user ${senderUsername}`);
    console.log(`   To reject: reject-user ${senderUsername} [block]\n`);

    // Wait for user decision with timeout
    const acceptancePromise = new Promise<boolean>((resolve, reject) => {
      this.pendingAcceptances.set(remoteId, { resolve, reject, timestamp: Date.now(), username: senderUsername });
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        this.pendingAcceptances.delete(remoteId);
        resolve(null);
      }, PENDING_KEY_EXCHANGE_EXPIRATION);
    });

    const result = await Promise.race([acceptancePromise, timeoutPromise]);

    this.pendingAcceptances.delete(remoteId);
    this.database.deleteContactAttempt(contactAttemptId);
    if (result === null) {
      console.log(`Contact request from ${senderUsername} expired`);
      throw new Error('REJECTION_TIMEOUT');
    }

    if (!result) {
      console.log(`Contact request from ${senderUsername} rejected`);
      // Signal that rejection response needs to be sent
      throw new Error('REJECTION_NEEDED');
    }

    // User accepted - get sender info (prefer DB, fallback to DHT)
    const existingAcceptedUser = this.database.getUserByPeerId(remoteId);
    if (
      existingAcceptedUser?.signing_public_key &&
      existingAcceptedUser.offline_public_key &&
      existingAcceptedUser.signature
    ) {
      console.log(
        `Accepted contact request from ${senderUsername} (using cached DB keys)`
      );
      return existingAcceptedUser;
    }

    // Need to fetch from DHT
    try {
      const sender = await this.usernameRegistry.lookup(senderUsername);
      if (sender.peerID !== remoteId) {
        throw new Error(`Username/peer mismatch for ${senderUsername}`);
      }
      console.log(`Accepted contact request from ${senderUsername} (verified via DHT)`);
      return sender;
    } catch (error: unknown) {
      throw new Error(`Sender not in DHT: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  //Verify signature for key exchange init message with DHT refresh fallback
  private async verifyKeyExchangeInitSignature(
    message: AuthenticatedEncryptedMessage,
    sender: UserRegistration | User,
    remoteId: string
  ): Promise<{ valid: boolean; keys: { signingPublicKey: string; offlinePublicKey: string; signature: string } }> {
    const messageToVerify: MessageToVerify = {
      type: 'key_exchange',
      content: 'key_exchange_init',
      // disabling because it is validated in validateKeyExchangeInit
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ephemeralPublicKey: message.ephemeralPublicKey!,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };

    let signingPublicKey = '';
    let offlinePublicKey = '';
    let signature = '';

    // Extract keys from sender object (handles both UserRegistration and User types)
    if ('signingPublicKey' in sender) {
      signingPublicKey = sender.signingPublicKey;
      offlinePublicKey = sender.offlinePublicKey;
      signature = sender.signature;
    } else {
      signingPublicKey = sender.signing_public_key;
      offlinePublicKey = sender.offline_public_key;
      signature = sender.signature;
    }

    let signatureValid = false;
    if (signingPublicKey) {
      signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        message.signature!,
        messageToVerify,
        signingPublicKey
      );
    }

    // If signature verification fails, refresh keys from DHT and retry
    if (!signatureValid) {
      try {
        const refreshed = await this.usernameRegistry.lookup(message.senderUsername);
        if (refreshed.peerID === remoteId) {
          signingPublicKey = refreshed.signingPublicKey;
          offlinePublicKey = refreshed.offlinePublicKey;
          signature = refreshed.signature;
          signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            message.signature!,
            messageToVerify,
            signingPublicKey
          );
        }
      } catch {
        // DHT refresh failed, signature remains invalid
      }
    }

    return {
      valid: signatureValid,
      keys: { signingPublicKey, offlinePublicKey, signature }
    };
  }

  //Ensure user exists in database with proper keys
  private async ensureUserExistsWithKeys(
    remoteId: string,
    username: string,
    signingPublicKey: string,
    offlinePublicKey: string,
    signature: string
  ): Promise<void> {
    const existingUser = this.database.getUserByPeerId(remoteId);

    if (!existingUser) {
      await this.database.createUser({
        peer_id: remoteId,
        username: username,
        signing_public_key: signingPublicKey,
        offline_public_key: offlinePublicKey,
        signature: signature
      });
    } else if (!existingUser.signing_public_key ||
      existingUser.signing_public_key !== signingPublicKey ||
      existingUser.offline_public_key !== offlinePublicKey) {
      // Update placeholder/missing keys after successful verification
      this.database.updateUserKeys({
        peer_id: remoteId,
        signing_public_key: signingPublicKey,
        offline_public_key: offlinePublicKey,
        signature: signature
      });
    }
  }

  // Create responder session with ephemeral keys and derive encryption keys
  private createResponderSession(
    remoteId: string,
    remoteEphemeralPublicKey: string
  ): {
    session: ConversationSession;
    ephemeralPublicKey: Uint8Array;
    offlineBucketSecret: string;
    notificationsBucketKey: Uint8Array;
  } {
    const ephemeralPrivateKey = x25519.utils.randomSecretKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

    const { sendingKey, receivingKey, sharedSecret } = this.deriveDirectionalKeys(
      ephemeralPublicKey,
      ephemeralPrivateKey,
      remoteEphemeralPublicKey,
      'responder'
    );

    const offlineBucketSecret = this.deriveOfflineBucketSecret(
      sharedSecret,
      this.node.peerId.toString(),
      remoteId
    );
    const notificationsBucketKey = this.deriveNotificationsBucketKey(
      sharedSecret,
      this.node.peerId.toString(),
      remoteId
    );

    const session: ConversationSession = {
      peerId: remoteId,
      ephemeralPrivateKey,
      ephemeralPublicKey,
      sendingKey,
      receivingKey,
      messageCount: 0,
      lastUsed: Date.now()
    };

    return { session, ephemeralPublicKey, offlineBucketSecret, notificationsBucketKey };
  }

  // Send key exchange response to initiator
  private async sendKeyExchangeResponse(
    stream: Stream,
    ephemeralPublicKey: Uint8Array,
    currentUsername: string,
    userIdentity: EncryptedUserIdentity,
    remoteId: string
  ): Promise<void> {
    const responseTimestamp = Date.now();

    const responseMessageToSign = {
      type: 'key_exchange' as const,
      content: 'key_exchange_response' as const,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      senderUsername: currentUsername,
      timestamp: responseTimestamp,
    };

    const responseSignature = userIdentity.sign(JSON.stringify(responseMessageToSign));
    const responseSignatureBase64 = Buffer.from(responseSignature).toString('base64');

    const responseMessage: AuthenticatedEncryptedMessage = {
      signature: responseSignatureBase64,
      ...responseMessageToSign
    };

    try {
      const responseJson = JSON.stringify(responseMessage);
      const encoder = new TextEncoder();
      await stream.sink([encoder.encode(responseJson)]);
      console.log('Response sent successfully!');
    } catch (sendError: unknown) {
      generalErrorHandler(sendError);
      if (sendError instanceof Error && sendError.message.includes("Cannot push value onto an ended pushable")) {
        console.log("The sender went offline. Sender needs to be online to finish key exchange");
        try {
          this.database.deleteUserByPeerId(remoteId);
          this.deletePendingAcceptanceByPeerId(remoteId);
        } catch {
          console.log('Pending key exchange deletion failed');
        }
      }
      throw sendError;
    }
  }

  // Send rejection response to initiator
  private async sendRejectionResponse(
    stream: Stream,
    currentUsername: string,
    senderUsername: string,
    userIdentity: EncryptedUserIdentity,
    initiatorEphemeralPublicKey: string
  ): Promise<void> {
    const timestamp = Date.now();
    const messageToSign = {
      type: 'key_exchange' as const,
      content: 'key_exchange_rejected' as const,
      ephemeralPublicKey: initiatorEphemeralPublicKey,
      senderUsername: currentUsername,
      timestamp: timestamp,
    };

    const signature = userIdentity.sign(JSON.stringify(messageToSign));
    const rejectionMessage: AuthenticatedEncryptedMessage = {
      signature: Buffer.from(signature).toString('base64'),
      ...messageToSign
    };

    try {
      const responseJson = JSON.stringify(rejectionMessage);
      const encoder = new TextEncoder();
      await stream.sink([encoder.encode(responseJson)]);
      console.log(`Sent rejection response to ${senderUsername}`);
    } catch (sendError: unknown) {
      generalErrorHandler(sendError);
    }
  }

  //Handle key exchange init message (responder side)
  private async handleKeyExchangeInit(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    stream: Stream,
    userIdentity: EncryptedUserIdentity,
    currentUsername: string
  ): Promise<void> {
    try {
      const ourPendingKeyExchange = this.sessionManager.getPendingKeyExchange(remoteId);
      if (ourPendingKeyExchange) {
        console.log(`Cleaning up our pending key exchange with ${remoteId.slice(0, 8)}... - they initiated a new one`);
        this.sessionManager.removePendingKeyExchange(remoteId);
      }

      // Validate input and check if sender is blocked
      this.validateKeyExchangeInit(message);

      // Authorize contact request
      const authResult = await this.authorizeContactRequest(remoteId, message);

      if (!authResult) {
        return;
      }

      const sender = authResult;
      const { valid, keys } = await this.verifyKeyExchangeInitSignature(message, sender, remoteId);

      if (!valid) {
        console.error('Key exchange init signature verification failed');
        return;
      }

      // Ensure user exists in database with proper cryptographic keys
      await this.ensureUserExistsWithKeys(
        remoteId,
        message.senderUsername,
        keys.signingPublicKey,
        keys.offlinePublicKey,
        keys.signature
      );

      // Create session with ephemeral keys and derive encryption keys
      const { session, ephemeralPublicKey, offlineBucketSecret, notificationsBucketKey } =
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.createResponderSession(remoteId, message.ephemeralPublicKey!);

      this.sessionManager.storeSession(remoteId, session);

      // Send signed response to initiator
      await this.sendKeyExchangeResponse(
        stream,
        ephemeralPublicKey,
        currentUsername,
        userIdentity,
        remoteId
      );

      // Create chat record in database
      await this._createUserAndChat(
        remoteId,
        message.senderUsername,
        offlineBucketSecret,
        notificationsBucketKey,
        keys.signingPublicKey,
        keys.offlinePublicKey,
        keys.signature
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'REJECTION_NEEDED') {
        await this.sendRejectionResponse(
          stream,
          currentUsername,
          message.senderUsername,
          userIdentity,
          message.ephemeralPublicKey ?? ''
        );
        return;
      }

      generalErrorHandler(error);
      throw error;
    }
  }

  private async waitForKeyExchangeResponse(peerId: string, stream: Stream): Promise<User | null> {
    let message: AuthenticatedEncryptedMessage;

    try {
      message = await StreamHandler.readMessageFromStream<AuthenticatedEncryptedMessage>(stream);
    } catch (streamError: unknown) {
      // Stream died - cleanup and propagate error
      this.sessionManager.removePendingKeyExchange(peerId);
      const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
      throw new Error(`Connection lost during key exchange: ${errorMsg}`);
    }

    try {

      if (message.type === 'key_exchange' && message.content === 'key_exchange_rejected') {
        // Verify rejection signature - if invalid, ignore and let timeout handle it
        if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
          throw new Error('Rejection message missing signature, sender username or ephemeral public key');
        }

        const messageToVerify: MessageToVerify = {
          type: 'key_exchange',
          content: 'key_exchange_rejected',
          ephemeralPublicKey: message.ephemeralPublicKey,
          senderUsername: message.senderUsername,
          timestamp: message.timestamp,
        };

        const { valid } = await this.verifySignatureWithFallback(
          message.signature,
          messageToVerify,
          message.senderUsername,
          peerId
        );

        if (!valid) {
          console.log('Rejection signature verification failed.');
          console.log('User may be compromised.');
          console.log('If you want to block them, run `block-user <username> [reason]`');
        }

        throw new Error(`Contact request rejected by ${message.senderUsername}`);
      }

      if (message.type !== 'key_exchange' || message.content !== 'key_exchange_response') {
        throw new Error('Unexpected message type during key exchange');
      }

      if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
        throw new Error('Key exchange response missing signature, sender username or ephemeral public key');
      }

      const messageToVerify: MessageToVerify = {
        type: 'key_exchange',
        content: 'key_exchange_response',
        ephemeralPublicKey: message.ephemeralPublicKey,
        senderUsername: message.senderUsername,
        timestamp: message.timestamp,
      };

      const { valid } = await this.verifySignatureWithFallback(
        message.signature,
        messageToVerify,
        message.senderUsername,
        peerId
      );

      if (!valid) {
        throw new Error('Key exchange response signature verification failed');
      }

      const pending = this.sessionManager.getPendingKeyExchange(peerId);
      if (!pending) {
        throw new Error('No pending key exchange found');
      }

      const { sendingKey, receivingKey, sharedSecret } = this.deriveDirectionalKeys(
        pending.ephemeralPublicKey,
        pending.ephemeralPrivateKey,
        message.ephemeralPublicKey,
        'initiator'
      );

      const session: ConversationSession = {
        peerId: peerId,
        ephemeralPrivateKey: pending.ephemeralPrivateKey,
        ephemeralPublicKey: pending.ephemeralPublicKey,
        sendingKey,
        receivingKey,
        messageCount: 0,
        lastUsed: Date.now()
      };

      this.sessionManager.storeSession(peerId, session);
      this.sessionManager.removePendingKeyExchange(peerId);

      const myPeerId = this.node.peerId.toString();
      const offlineBucketSecret = this.deriveOfflineBucketSecret(sharedSecret, myPeerId, peerId);
      const notificationsBucketKey = this.deriveNotificationsBucketKey(sharedSecret, myPeerId, peerId);

      const userFromDb = this.database.getUserByPeerId(peerId);
      await this._createUserAndChat(
        peerId,
        message.senderUsername,
        offlineBucketSecret,
        notificationsBucketKey,
        userFromDb?.signing_public_key,
        userFromDb?.offline_public_key,
        userFromDb?.signature
      );

      // Return the user object we just created/updated
      return this.database.getUserByPeerId(peerId);
    } catch (error: unknown) {
      generalErrorHandler(error);
      return null;
    }
  }

  /**
   * Handle key rotation message (receiver side)
   */
  private async handleKeyRotation(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    userIdentity: EncryptedUserIdentity,
    currentUsername: string
  ): Promise<void> {
    console.log(`Received key rotation from ${remoteId.slice(0, 8)}...`);

    const session = this.sessionManager.getSession(remoteId);
    if (!session) {
      console.error('No existing session for key rotation');
      return;
    }

    if (!message.ephemeralPublicKey || !message.signature || !message.senderUsername) {
      console.error('Key rotation missing required fields');
      return;
    }

    // Timestamp freshness check (replay attack prevention)
    const messageAge = Date.now() - (message.timestamp || 0);
    if (messageAge > MAX_KEY_EXCHANGE_AGE || messageAge < 0) {
      console.error('Key rotation message too old or future-dated');
      return;
    }

    // Why do I have this cooldown??
    // Rate limit rotations (max 1 per 30 seconds per peer)
    const lastRotation = session.lastRotated ?? 0;
    if (Date.now() - lastRotation < ROTATION_COOLDOWN) {
      console.log(`Key rotation from ${message.senderUsername} too frequent - rate limited`);
      this.sessionManager.clearSession(remoteId);
      console.log(`Cleared session for ${remoteId.slice(0, 8)}... due to rate-limited rotation`);
      return;
    }

    // Check for simultaneous rotation (both peers trying to rotate at same time)
    const ourPendingRotation = this.sessionManager.getPendingKeyExchange(remoteId);
    if (ourPendingRotation) {
      // Tie-breaking: lexicographic comparison of peer IDs
      const weWin = this.node.peerId.toString() < remoteId;

      if (weWin) {
        // We initiated first - ignore remote's rotation request, wait for our response
        console.log(`Simultaneous rotation detected with ${remoteId.slice(0, 8)}... - we initiated first, ignoring remote request`);
        return; // Stop processing remote's rotation
      }

      // Remote wins - cancel OUR rotation and process THEIRS instead
      console.log(`Simultaneous rotation detected with ${remoteId.slice(0, 8)}... - remote initiated first, canceling ours`);
      this.sessionManager.removePendingKeyExchange(remoteId);
      this.rejectRotationPromise(remoteId, new Error('Simultaneous rotation - remote wins'));
    }

    const messageToVerify: MessageToVerify = {
      type: 'key_exchange',
      content: 'key_rotation',
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };

    const { valid } = await this.verifySignatureWithFallback(
      message.signature ?? '',
      messageToVerify,
      message.senderUsername,
      remoteId
    );

    if (!valid) {
      console.log('Key rotation signature verification failed');
      this.sessionManager.clearSession(remoteId);
      console.log(`Cleared session for ${remoteId.slice(0, 8)}... due to signature verification failure`);
      return;
    }

    console.log(`Verified authentic key rotation from ${message.senderUsername}`);

    // Generate new ephemeral key pair
    const newEphemeralPrivateKey = x25519.utils.randomSecretKey();
    const newEphemeralPublicKey = x25519.getPublicKey(newEphemeralPrivateKey);

    const { sendingKey, receivingKey } = this.deriveDirectionalKeys(
      newEphemeralPublicKey,
      newEphemeralPrivateKey,
      message.ephemeralPublicKey,
      'responder'
    );

    // Create and sign the key rotation response
    const responseTimestamp = Date.now();
    const responseMessageToSign = {
      type: 'key_exchange' as const,
      content: 'key_rotation_response' as const,
      ephemeralPublicKey: Buffer.from(newEphemeralPublicKey).toString('base64'),
      senderUsername: currentUsername,
      timestamp: responseTimestamp,
    };

    const responseSignature = userIdentity.sign(JSON.stringify(responseMessageToSign));

    const rotationResponse: AuthenticatedEncryptedMessage = {
      signature: Buffer.from(responseSignature).toString('base64'),
      ...responseMessageToSign
    };

    try {
      const targetPeerId = peerIdFromString(remoteId);
      const responseStream = await this.node.dialProtocol(targetPeerId, CHAT_PROTOCOL);
      const responseJson = JSON.stringify(rotationResponse);
      const encoder = new TextEncoder();
      await responseStream.sink([encoder.encode(responseJson)]);
      console.log(`Key rotation response sent to ${remoteId.slice(0, 8)}...`);

      session.ephemeralPrivateKey = newEphemeralPrivateKey;
      session.ephemeralPublicKey = newEphemeralPublicKey;
      session.sendingKey = sendingKey;
      session.receivingKey = receivingKey;
      session.messageCount = 0;
      session.lastUsed = Date.now();
      session.lastRotated = Date.now();

      console.log(`Key rotation completed with ${remoteId.slice(0, 8)}...`);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to send key rotation response');
      // Clear session to force re-key exchange on next message
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to rotation response send failure`);
    }
  }

  // Handle key rotation response message (initiator side)
  private async handleKeyRotationResponse(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    console.log(`Received key rotation response from ${remoteId.slice(0, 8)}...`);

    const session = this.sessionManager.getSession(remoteId);
    if (!session) {
      console.error('No existing session for key rotation response');
      this.rejectRotationPromise(remoteId, new Error('No existing session for key rotation response'));
      return;
    }

    if (!message.ephemeralPublicKey || !message.signature || !message.senderUsername) {
      console.error('Key rotation response missing required fields');
      this.rejectRotationPromise(remoteId, new Error('Key rotation response missing required fields'));
      return;
    }

    // Timestamp freshness check (replay attack prevention)
    const responseAge = Date.now() - (message.timestamp || 0);
    if (responseAge > MAX_KEY_EXCHANGE_AGE || responseAge < 0) {
      console.error('Key rotation response too old or future-dated');
      this.rejectRotationPromise(remoteId, new Error('Key rotation response timestamp invalid'));
      return;
    }

    const messageToVerify: MessageToVerify = {
      type: 'key_exchange',
      content: 'key_rotation_response',
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };

    const { valid } = await this.verifySignatureWithFallback(
      message.signature,
      messageToVerify,
      message.senderUsername,
      remoteId
    );

    if (!valid) {
      console.error('Key rotation response signature verification failed');
      // Clear session since receiver may have already rotated keys
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to signature verification failure`);
      this.rejectRotationPromise(remoteId, new Error('Key rotation response signature verification failed'));
      return;
    }

    const pendingRotation = this.sessionManager.getPendingKeyExchange(remoteId);
    if (!pendingRotation) {
      console.error('No pending key rotation found - likely timeout already occurred');
      // Stale response: timeout already cleared the pending exchange
      // Clear session to force fresh key exchange since we're likely desynchronized
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to stale rotation response`);
      this.rejectRotationPromise(remoteId, new Error('No pending key rotation found'));
      return;
    }

    try {
      const { sendingKey, receivingKey } = this.deriveDirectionalKeys(
        pendingRotation.ephemeralPublicKey,
        pendingRotation.ephemeralPrivateKey,
        message.ephemeralPublicKey,
        'initiator'
      );

      // Update session with new keys and shared secret
      session.ephemeralPrivateKey = pendingRotation.ephemeralPrivateKey;
      session.ephemeralPublicKey = pendingRotation.ephemeralPublicKey;
      session.sendingKey = sendingKey;
      session.receivingKey = receivingKey;
      session.messageCount = 0;
      session.lastUsed = Date.now();
      session.lastRotated = Date.now();

      // Clean up pending rotation
      this.sessionManager.removePendingKeyExchange(remoteId);

      console.log(`Key rotation completed with ${remoteId.slice(0, 8)}...`);

      // Resolve the promise
      this.resolveRotationPromise(remoteId, true);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Error completing key rotation');
      // Reject the promise
      this.rejectRotationPromise(remoteId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async rotateSessionKeys(targetPeerId: PeerId): Promise<boolean> {
    const peerIdStr = targetPeerId.toString();

    if (this.sessionManager.getPendingKeyExchange(peerIdStr)) {
      console.warn(`Key rotation already in progress for ${peerIdStr.slice(0, 8)}...`);
      return false;
    }

    const session = this.sessionManager.getSession(peerIdStr);
    if (!session) {
      throw new Error('No existing session for key rotation');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    const currentUsername = this.usernameRegistry.getCurrentUsername();

    if (!userIdentity || !currentUsername) {
      throw new Error('User identity or username not available');
    }

    const newEphemeralPrivateKey = x25519.utils.randomSecretKey();
    const newEphemeralPublicKey = x25519.getPublicKey(newEphemeralPrivateKey);
    const timestamp = Date.now();

    this.sessionManager.storePendingKeyExchange(peerIdStr, {
      timestamp: timestamp,
      ephemeralPrivateKey: newEphemeralPrivateKey,
      ephemeralPublicKey: newEphemeralPublicKey
    });

    const rotationPromise = new Promise<boolean>((resolve) => {
      this.rotationPromises.set(peerIdStr,
        { resolve: () => { resolve(true); }, reject: (_error: Error) => { resolve(false); } }
      );
    });

    const messageToSign = {
      type: 'key_exchange' as const,
      content: 'key_rotation' as const,
      ephemeralPublicKey: Buffer.from(newEphemeralPublicKey).toString('base64'),
      senderUsername: currentUsername,
      timestamp,
    };

    const signature = userIdentity.sign(JSON.stringify(messageToSign));

    const rotationMessage: AuthenticatedEncryptedMessage = {
      signature: Buffer.from(signature).toString('base64'),
      ...messageToSign
    };

    try {
      const stream = await this.node.dialProtocol(targetPeerId, CHAT_PROTOCOL);
      const messageJson = JSON.stringify(rotationMessage);
      const encoder = new TextEncoder();
      await stream.sink([encoder.encode(messageJson)]);
      console.log(`Key rotation message sent to ${peerIdStr.slice(0, 8)}...`);
    } catch (sendError: unknown) {
      // Send failed - clean up state immediately
      generalErrorHandler(sendError, 'Failed to send key rotation message');
      this.sessionManager.removePendingKeyExchange(peerIdStr);
      this.rotationPromises.delete(peerIdStr);
      return false;
    }

    const timeoutPromise = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.rotationPromises.delete(peerIdStr);
        this.rotationTimeouts.delete(peerIdStr);
        this.sessionManager.removePendingKeyExchange(peerIdStr);
        this.sessionManager.clearSession(peerIdStr);
        console.warn(`Key rotation timeout for ${peerIdStr.slice(0, 8)}... - cleared session`);
        resolve(false);
      }, KEY_ROTATION_TIMEOUT);
      this.rotationTimeouts.set(peerIdStr, timeoutId);
    });

    try {
      const result = await Promise.race([rotationPromise, timeoutPromise]);
      return result;
    } catch (error: unknown) {
      generalErrorHandler(error);
      this.sessionManager.removePendingKeyExchange(peerIdStr);
      this.rotationPromises.delete(peerIdStr);

      const timeoutId = this.rotationTimeouts.get(peerIdStr);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.rotationTimeouts.delete(peerIdStr);
      }

      return false;
    }
  }


  private async _createUserAndChat(
    remoteId: string,
    username: string,
    offlineBucketSecret: string,
    notificationsBucketKey: Uint8Array,
    signing_public_key?: string,
    offline_public_key?: string,
    signature?: string
  ): Promise<void> {
    const otherUser = this.database.getUserByPeerId(remoteId);
    if (!otherUser) {
      // User doesn't exist - create with keys from DHT
      const peerId = await this.database.createUser({
        peer_id: remoteId,
        username: username,
        signing_public_key: signing_public_key ?? '',
        offline_public_key: offline_public_key ?? '',
        signature: signature ?? ''
      });
      if (peerId !== remoteId) {
        throw new Error('Peer ID mismatch - Something went horribly wrong');
      }
    } else if (signing_public_key || offline_public_key) {
      // User exists - update keys if we have DHT data and they're missing
      if (!otherUser.signing_public_key || !otherUser.offline_public_key) {
        console.log(`Updating missing keys for existing user ${username}`);
        this.database.updateUserKeys({
          peer_id: remoteId,
          signing_public_key: signing_public_key ?? otherUser.signing_public_key,
          offline_public_key: offline_public_key ?? otherUser.offline_public_key,
          signature: signature ?? otherUser.signature
        });
      }
    }
    const chat = this.database.getChatByPeerId(remoteId);
    if (!chat) {
      const chatId = await this.database.createChat({
        type: 'direct',
        created_by: this.node.peerId.toString(),
        participants: [this.node.peerId.toString(), remoteId],
        offline_bucket_secret: offlineBucketSecret,
        notifications_bucket_key: toBase64Url(notificationsBucketKey),
        offline_last_read_timestamp: 0,
        offline_last_ack_sent: 0,
        trusted_out_of_band: false,
        status: 'active',
        created_at: new Date()
      } as Omit<Chat, 'id' | 'updated_at'> & { participants: string[] });
      if (!chatId) {
        throw new Error('Failed to create chat');
      }
    } else if (chat.trusted_out_of_band) {
      // Upgrade from out-of-band trust to full ECDH-derived keys
      console.log(`Upgrading chat ${chat.id} from out-of-band trust to ECDH-derived keys`);
      this.database.updateChatEncryptionKeys(chat.id, {
        offline_bucket_secret: offlineBucketSecret,
        notifications_bucket_key: toBase64Url(notificationsBucketKey),
        trusted_out_of_band: false
      });
    }
  }

  private isKeyExchangeRateLimitExceeded(): boolean {
    let keyExchangeRateLimit = this.database.getSetting('key_exchange_rate_limit') ?? KEY_EXCHANGE_RATE_LIMIT_DEFAULT;
    if (isNaN(Number(keyExchangeRateLimit)) || Number(keyExchangeRateLimit) < 1 || Number(keyExchangeRateLimit) > 100) {
      console.log(`Invalid key exchange rate limit value. Must be between 1 and 100. Using default value of ${KEY_EXCHANGE_RATE_LIMIT_DEFAULT}`);
      keyExchangeRateLimit = KEY_EXCHANGE_RATE_LIMIT_DEFAULT;
    }
    const recentAttemptsToMe = this.getRecentKeyExchangeAttempts();
    return recentAttemptsToMe >= Number(keyExchangeRateLimit);
  }

  private didUserContactMeRecently(peerId: string): boolean {
    const attempts = Array.from(this.pendingAcceptances.entries())
      .filter(([attemptPeerId, { timestamp }]) =>
        attemptPeerId === peerId && timestamp > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW
      );
    const contactAttempts = this.database.getContactAttemptsByPeerId(peerId)
      .filter((attempt) => attempt.timestamp > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW)
      .map((attempt) => attempt.sender_username);
    return attempts.length + contactAttempts.length > 0;
  }

  getKeyRotationThreshold(): number {
    return this.KEY_ROTATION_THRESHOLD;
  }

  getPendingAcceptanceByPeerId(peerId: string): PendingAcceptance | null {
    return this.pendingAcceptances.get(peerId) ?? null;
  }

  getPendingAcceptanceByUsername(username: string): (PendingAcceptance & { peerId: string }) | null {
    for (const [peerId, data] of this.pendingAcceptances.entries()) {
      if (data.username === username) {
        return { peerId, ...data };
      }
    }
    return null;
  }

  getPendingAcceptances(): PendingAcceptance[] {
    return Array.from(this.pendingAcceptances.entries())
      .map(([peerId, { resolve, reject, timestamp, username }]) =>
        ({ peerId, resolve, reject, timestamp, username })
      );
  }

  deletePendingAcceptanceByPeerId(peerId: string): void {
    this.pendingAcceptances.delete(peerId);
  }

  // get all contact attempts in the last 5 minutes
  getRecentKeyExchangeAttempts(): number {
    const attempts = Array.from(this.pendingAcceptances.values())
      .filter(({ timestamp }) => timestamp > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW);
    return attempts.length;
  }
} 