import { ChatDatabase, User } from './db/database.js';
import type { ChatNode, UserRegistration } from '../types.js';
import { ERRORS, REREGISTRATION_INTERVAL, getNetworkModeRuntime } from '../constants.js';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import { QueryEvent } from '@libp2p/kad-dht';
import {
  isUsernameRegistrationRecord,
  signUsernameRegistrationPayload,
  verifyUsernameRegistrationSignature,
} from './username-record.js';

export class UsernameRegistry {
  private static readonly USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
  private static readonly TEXT_ENCODER = new TextEncoder();
  private static readonly TEXT_DECODER = new TextDecoder();
  private static readonly MAX_REGISTRATION_AGE = REREGISTRATION_INTERVAL * 2;
  private static readonly LOOKUP_RETRYABLE_ERRORS = [
    'Could not send correction',
    'No peers found',
    'all peers errored',
    'query timed out',
    'DHT is not started',
  ];

  private node: ChatNode;
  private currentUsername: string | null = null;
  private userIdentity: EncryptedUserIdentity | null = null;
  public reregistrationInterval: NodeJS.Timeout | null = null;
  private database: ChatDatabase;
  private readonly usernameDhtPrefix: string;

  constructor(node: ChatNode, database: ChatDatabase) {
    this.node = node;
    this.database = database;
    this.usernameDhtPrefix = getNetworkModeRuntime(database.getSessionNetworkMode()).config.dhtNamespaces.username;
  }

  async initialize(userIdentity: EncryptedUserIdentity, onRestoreUsername: (username: string) => void): Promise<void> {
    this.userIdentity = userIdentity;

    const autoRegister = this.database.getSetting('auto_register');

    if (autoRegister === 'never') {
      console.log('Auto-registration is disabled. Use "register <username>" to register a username.');
      return;
    }
    const userDb = this.database.getUserByPeerId(this.node.peerId.toString());
    const lastUsername = this.database.getLastUsername(this.node.peerId.toString());

    if (lastUsername && userDb && autoRegister === 'true') {
      console.log(`Auto-registering as '${lastUsername}' in background...`);
      void this.tryRestoreLastUsername(userDb, onRestoreUsername).catch((error: unknown) => {
        generalErrorHandler(error);
      });
    }
  }

  async register(username: string, isRenewal: boolean = false, rememberMe: boolean = false): Promise<boolean> {
    console.log(`Registering username: ${username} with rememberMe: ${rememberMe}`);
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    if (username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }

    if (username.length > 32) {
      throw new Error('Username must be less than 32 characters');
    }

    if (!UsernameRegistry.USERNAME_REGEX.test(username)) {
      throw new Error('Username can only contain alphanumerics and underscores');
    }

    if (this.currentUsername === username && !isRenewal) {
      console.log(`Username ${username} is already registered`);
      return true;
    }

    const myPeerId = this.node.peerId.toString();
    const usernameKey = this.buildUsernameByNameKey(username);
    const peerIdKey = this.buildUsernameByPeerIdKey(myPeerId);
    const userRegistration = this.#createUserRegistrationObject(username);
    const userRegistrationJson = JSON.stringify(userRegistration);
    const valueBytes = UsernameRegistry.TEXT_ENCODER.encode(userRegistrationJson);

    // Check if username is already taken by someone else
    try {
      for await (const event of this.node.services.dht.get(usernameKey) as AsyncIterable<QueryEvent>) {
        if (event.name === 'VALUE' && event.value) {
          const rawData = UsernameRegistry.TEXT_DECODER.decode(event.value).trim();
          
          // If data is empty or invalid, skip it (username is available)
          if (!rawData || rawData === '{}') continue;

          let existingRegistration: UserRegistration | null = null;
          try {
            const parsed = JSON.parse(rawData) as unknown;
            if (!isUsernameRegistrationRecord(parsed) || !verifyUsernameRegistrationSignature(parsed)) {
              continue;
            }
            existingRegistration = parsed;
          } catch (e) {
            // Invalid JSON means we can't verify ownership, treat as garbage/available
            continue;
          }
          if (!existingRegistration) {
            continue;
          }
          if ((existingRegistration.kind ?? 'active') === 'released') {
            // Username was explicitly released; allow claim.
            continue;
          }
          const age = Date.now() - existingRegistration.timestamp;
          if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
            // Stale record can be reclaimed.
            continue;
          }
          if (existingRegistration && existingRegistration.peerID && existingRegistration.peerID !== myPeerId) {
            throw new Error(ERRORS.USERNAME_TAKEN);
          }
          break;
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '';
      const isExpectedError = errMsg.includes('not found')
        || errMsg.includes('No peers found')
        || errMsg.includes('Could not send correction');
      if (!isExpectedError) {
        generalErrorHandler(err, 'Failed to register username');
        throw err;
      }
    }

    // If changing username, stop re-registration first to prevent race conditions
    const oldUsername = this.currentUsername;
    if (oldUsername) {
      console.log(`Changing username from ${oldUsername} to ${username}`);
      this.stopReregistration();
    }

    // Store username -> user data record (for username lookups)
    const usernamePublish = await this.publishRecord(usernameKey, valueBytes);
    if (usernamePublish.acceptedCount === 0 && usernamePublish.rejectedCount > 0) {
      if (oldUsername) {
        this.currentUsername = oldUsername;
        this.startReregistration();
      }
      throw new Error(`Username registration rejected by DHT validators (${usernamePublish.rejectedCount} peer(s) rejected)`);
    }

    if (usernamePublish.errorCount > 0 && usernamePublish.acceptedCount === 0) {
      if (oldUsername) {
        this.currentUsername = oldUsername;
        this.startReregistration();
      }
      throw new Error(`Username registration failed: all ${usernamePublish.errorCount} peers unreachable`);
    }

    const rollbackUsernameOnPeerWriteFailure = async (): Promise<void> => {
      try {
        const released = await this.releaseUsernameByName(username);
        if (!released) {
          console.warn(`Peer ID write failed and rollback release for '${username}' did not fully propagate.`);
        }
      } catch (rollbackError: unknown) {
        generalErrorHandler(rollbackError, `Failed rollback release for partially committed username '${username}'`);
      }
    };

    // Store peerID -> user data record (contains all info)
    const peerPublish = await this.publishRecord(peerIdKey, valueBytes);
    if (peerPublish.acceptedCount === 0 && peerPublish.rejectedCount > 0) {
      await rollbackUsernameOnPeerWriteFailure();
      if (oldUsername) {
        this.currentUsername = oldUsername;
        this.startReregistration();
      }
      throw new Error(`Peer ID registration rejected by DHT validators (${peerPublish.rejectedCount} peer(s) rejected)`);
    }

    if (peerPublish.errorCount > 0 && peerPublish.acceptedCount === 0) {
      await rollbackUsernameOnPeerWriteFailure();
      if (oldUsername) {
        this.currentUsername = oldUsername;
        this.startReregistration();
      }
      throw new Error(`Peer ID registration failed: all ${peerPublish.errorCount} peers unreachable`);
    }

    console.log(`Stored records: username:${username} → peerID:${myPeerId} → full user data`);

    // After new username is committed, release the old username explicitly.
    if (oldUsername && oldUsername !== username) {
      const released = await this.releaseUsernameByName(oldUsername);
      if (!released) {
        console.warn(`Failed to release old username '${oldUsername}'. It may remain reserved until stale.`);
      }
    }

    // Update in-memory username
    this.currentUsername = username;

    // Update or create user in database
    try {
      const existingUser = this.database.getUserByPeerId(myPeerId);
      if (existingUser) {
        console.log(`User already exists in database with ID: ${existingUser.peer_id}`);
        if (existingUser.username !== username) {
          this.database.updateUsername(myPeerId, username);
          console.log(`Updated username in database: ${username}`);
        }
      } else {
        const peerId = await this.database.createUser({
          peer_id: myPeerId,
          username,
          signing_public_key: this.userIdentity.signingPublicKey.toString(),
          offline_public_key: Buffer.from(this.userIdentity.offlinePublicKey).toString('base64'),
          signature: this.userIdentity.sign(userRegistrationJson).toString()
        });
        console.log(peerId ? `User registered in database with peerId: ${peerId}` : `User may already exist in database`);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to save user to database');
      // Don't fail the registration if database save fails
      // The DHT registration is the primary storage
    }

    if (rememberMe) {
      this.database.setSetting('auto_register', 'true');
      console.log(`Registered username: ${username} and will auto-register on startup`);
    }

    // Start re-registration with new username
    this.startReregistration();

    return true;
  }

  async attemptAutoRegister(): Promise<string | null> {
    const autoRegister = this.database.getSetting('auto_register');
    if (autoRegister !== 'true') {
      return null;
    }

    const userDb = this.database.getUserByPeerId(this.node.peerId.toString());
    const lastUsername = this.database.getLastUsername(this.node.peerId.toString());

    if (!lastUsername || !userDb) {
      return null;
    }

    if (this.currentUsername === lastUsername) {
      return lastUsername;
    }

    const peers = this.node.getConnections();
    if (peers.length === 0) {
      return null;
    }

    const success = await this.register(lastUsername, true);
    return success ? lastUsername : null;
  }

  // Use this when you want to release your current username and stop being reachable by it.
  async unregister(): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    const result = {
      usernameUnregistered: false,
      peerIdUnregistered: false,
    }

    this.database.setSetting('auto_register', 'never');

    const targetUsername = this.currentUsername?.trim();
    if (!targetUsername) {
      this.stopReregistration();
      this.currentUsername = null;
      return result;
    }

    const myPeerId = this.node.peerId.toString();
    const releaseRecord = this.#createReleasedRegistrationObject(targetUsername);
    const valueBytes = UsernameRegistry.TEXT_ENCODER.encode(JSON.stringify(releaseRecord));

    const publishReleaseRecord = async (key: Uint8Array): Promise<boolean> => {
      const publish = await this.publishRecord(key, valueBytes);
      if (publish.acceptedCount === 0 && publish.rejectedCount > 0) return false;
      if (publish.errorCount > 0 && publish.acceptedCount === 0) return false;
      return publish.acceptedCount > 0;
    };

    try {
      const [usernameRelease, peerRelease] = await Promise.allSettled([
        publishReleaseRecord(this.buildUsernameByNameKey(targetUsername)),
        publishReleaseRecord(this.buildUsernameByPeerIdKey(myPeerId)),
      ]);

      result.usernameUnregistered = usernameRelease.status === 'fulfilled' ? usernameRelease.value : false;
      result.peerIdUnregistered = peerRelease.status === 'fulfilled' ? peerRelease.value : false;
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to publish username release record');
    }

    this.currentUsername = null;
    this.stopReregistration();
    return result;
  }

  async lookup(username: string): Promise<UserRegistration> {
    return this.#lookupByKey(
      this.buildUsernameByNameKey(username),
      username,
      ERRORS.USERNAME_NOT_FOUND,
      (reg) => reg.username === username,
    );
  }

  async lookupByPeerId(peerId: string): Promise<UserRegistration> {
    return this.#lookupByKey(
      this.buildUsernameByPeerIdKey(peerId),
      peerId,
      'Peer ID not found in DHT',
      undefined,
    );
  }

  /**
   * Looks up a key in the DHT and gets full user data
   * @param key - The key to look up
   * @returns The complete user registration data
   * @throws {Error} If username or peer ID not found or signature invalid
   */
  async #lookupByKey(
    key: Uint8Array,
    keyLabel: string,
    notFoundError: string,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): Promise<UserRegistration> {
    const currentTime = Date.now();
    const result = await this.readRegistrationForKey(key, keyLabel, currentTime, extraValidation);
    if (result) {
      return result;
    }

    throw new Error(notFoundError);
  }

  /**
   * Get the current username
   */
  getCurrentUsername(): string | null {
    return this.currentUsername;
  }

  /**
   * Get the user identity
   */
  getUserIdentity(): EncryptedUserIdentity | null {
    return this.userIdentity;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
      this.reregistrationInterval = null;
    }
  }

  private async tryRestoreLastUsername(userDb?: User, onRestoreUsername?: (username: string) => void): Promise<void> {
    if (!userDb?.username || !userDb.peer_id || userDb.peer_id !== this.node.peerId.toString()) {
      return;
    }

    const { username } = userDb;
    console.log(`Attempting to restore username: ${username}`);

    // Check if we have any peers before attempting registration
    const peers = this.node.getConnections();
    if (peers.length === 0) {
      console.log(`Skipping auto-registration for '${username}' - no DHT peers connected`);
      console.log(`Registration will be available once connected to the network`);
      return;
    }

    try {
      await this.register(username, true);
      console.log(`Successfully restored username: ${username}`);
      onRestoreUsername?.(username);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already taken')) {
        console.log(`Username '${username}' is now taken by someone else`);
      } else {
        generalErrorHandler(err, "Failed to restore username");
      }
    }
  }

  private startReregistration(): void {
    if (!this.currentUsername) {
      return;
    }
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
    }

    const reregister = async (): Promise<void> => {
      try {
        console.log(`Re-registering username: ${this.currentUsername}`);
    
        if (!this.currentUsername) {
          console.error('Current username not set');
          return;
        }
    
        await this.register(this.currentUsername, true);
      } catch (err: unknown) {
        generalErrorHandler(err, 'Failed to re-register username');
      }
    };
    
    this.reregistrationInterval = setInterval(() => {
      void reregister();
    }, REREGISTRATION_INTERVAL);    
  }

  private stopReregistration(): void {
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
      this.reregistrationInterval = null;
    }
  }

  #createUserRegistrationObject(username: string): UserRegistration {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }
    const identity = this.userIdentity;

    const registrationData: Omit<UserRegistration, 'signature'> = {
      peerID: this.node.peerId.toString(),
      username,
      kind: 'active',
      signingPublicKey: Buffer.from(identity.signingPublicKey).toString('base64'),
      offlinePublicKey: Buffer.from(identity.offlinePublicKey).toString('base64'),
      timestamp: Date.now(),
    };

    const signature = signUsernameRegistrationPayload(registrationData, (payload) =>
      identity.sign(payload),
    );

    return {
      ...registrationData,
      signature,
    } as UserRegistration;
  }

  #createReleasedRegistrationObject(username: string): UserRegistration {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }
    const identity = this.userIdentity;

    const registrationData: Omit<UserRegistration, 'signature'> = {
      peerID: this.node.peerId.toString(),
      username,
      kind: 'released',
      signingPublicKey: Buffer.from(identity.signingPublicKey).toString('base64'),
      offlinePublicKey: Buffer.from(identity.offlinePublicKey).toString('base64'),
      timestamp: Date.now(),
    };

    const signature = signUsernameRegistrationPayload(registrationData, (payload) =>
      identity.sign(payload),
    );

    return {
      ...registrationData,
      signature,
    } as UserRegistration;
  }


  private isValidUserRegistration(registration: unknown): registration is UserRegistration {
    return isUsernameRegistrationRecord(registration);
  }

  private async readRegistrationForKey(
    key: Uint8Array,
    keyLabel: string,
    currentTime: number,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): Promise<UserRegistration | null> {
    let newestRecord: UserRegistration | null = null;

    try {
      for await (const event of this.node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || !event.value) continue;
        try {
          const rawData = UsernameRegistry.TEXT_DECODER.decode(event.value).trim();

          // Skip empty garbage records
          if (!rawData || rawData === '{}') continue;

          const registration = JSON.parse(rawData) as unknown;
          if (!this.isValidUserRegistration(registration)) continue;
          if (!verifyUsernameRegistrationSignature(registration)) {
            continue;
          }

          // Check if registration is too old (replay attack prevention)
          const age = currentTime - registration.timestamp;
          if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
            console.log(`Discarding old registration for ${keyLabel} (age: ${Math.round(age / 1000)}s)`);
            continue;
          }

          if (extraValidation && !extraValidation(registration)) {
            continue;
          }

          if (newestRecord == null || registration.timestamp > newestRecord.timestamp) {
            newestRecord = registration;
            continue;
          }

          // Deterministic tie-break: prefer active over released on same timestamp.
          if (
            newestRecord.timestamp === registration.timestamp &&
            (newestRecord.kind ?? 'active') === 'released' &&
            (registration.kind ?? 'active') !== 'released'
          ) {
            newestRecord = registration;
          }
        } catch (parseErr: unknown) {
          generalErrorHandler(parseErr, `Failed to parse DHT value for ${keyLabel}`);
        }
      }
    } catch (dhtErr: unknown) {
      console.log(`DHT get failed for ${keyLabel}:`, dhtErr instanceof Error ? dhtErr.message : String(dhtErr));
      const dhtErrMessage = dhtErr instanceof Error ? dhtErr.message : String(dhtErr);
      if (this.isRetryableLookupFailure(dhtErrMessage)) {
        throw new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
      }
      throw dhtErr instanceof Error
        ? dhtErr
        : new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
    }

    if (!newestRecord) {
      return null;
    }

    if ((newestRecord.kind ?? 'active') === 'released') {
      return null;
    }

    return newestRecord;
  }

  private isRetryableLookupFailure(message: string): boolean {
    return UsernameRegistry.LOOKUP_RETRYABLE_ERRORS.some((needle) =>
      message.toLowerCase().includes(needle.toLowerCase()),
    );
  }

  private async publishRecord(
    key: Uint8Array,
    valueBytes: Uint8Array,
  ): Promise<{ errorCount: number; acceptedCount: number; rejectedCount: number }> {
    let errorCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    for await (const event of this.node.services.dht.put(key, valueBytes) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') {
        errorCount++;
      } else if (event.name === 'PEER_RESPONSE') {
        const accepted = event.record != null
          && Buffer.from(event.record.value).equals(Buffer.from(valueBytes));
        if (accepted) acceptedCount++;
        else rejectedCount++;
      }
    }

    return { errorCount, acceptedCount, rejectedCount };
  }

  private async releaseUsernameByName(username: string): Promise<boolean> {
    const releaseRecord = this.#createReleasedRegistrationObject(username);
    const valueBytes = UsernameRegistry.TEXT_ENCODER.encode(JSON.stringify(releaseRecord));
    const publish = await this.publishRecord(this.buildUsernameByNameKey(username), valueBytes);
    if (publish.acceptedCount === 0 && publish.rejectedCount > 0) return false;
    if (publish.errorCount > 0 && publish.acceptedCount === 0) return false;
    return publish.acceptedCount > 0;
  }

  private buildUsernameByNameKey(username: string): Uint8Array {
    const hashed = hashUsingSha256(username);
    return UsernameRegistry.TEXT_ENCODER.encode(`${this.usernameDhtPrefix}/by-name/${hashed}`);
  }

  private buildUsernameByPeerIdKey(peerId: string): Uint8Array {
    const hashed = hashUsingSha256(peerId);
    return UsernameRegistry.TEXT_ENCODER.encode(`${this.usernameDhtPrefix}/by-peer/${hashed}`);
  }

}

// podsjetnik za potpisivanje
// signature = PrivateKeySign(hash(data)) // signature je 64 bajta nečitljivog contenta
// kada se radi verifikacija, onda vec imas data i signature -> napravis hash(data) i 
// sa javnim kljucem dekriptiras signature i usporedis sa hash(data) -> ako su isti, potpis je validan
