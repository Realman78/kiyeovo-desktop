import { ChatDatabase, User } from './db/database.js';
import type { ChatNode, UserRegistration } from '../types.js';
import { ERRORS, NETWORK_MODES, REREGISTRATION_INTERVAL, getNetworkModeRuntime } from '../constants.js';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import { QueryEvent } from '@libp2p/kad-dht';
import {
  isUsernameRegistrationRecord,
  signUsernameRegistrationPayload,
  verifyUsernameRegistrationSignature,
} from './username-record.js';

type UsernamePublishResult = {
  errorCount: number;
  acceptedCount: number;
  rejectedCount: number;
};

type UsernameRegistrationContext = {
  username: string;
  myPeerId: string;
  usernameKey: Uint8Array;
  peerIdKey: Uint8Array;
  registrationJson: string;
  valueBytes: Uint8Array;
  previousUsername: string | null;
};

type StoredUsernameState = {
  autoRegister: string | null;
  userDb: User | null;
  lastUsername: string | null;
};

export class UsernameRegistry {
  private static readonly USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
  private static readonly TEXT_ENCODER = new TextEncoder();
  private static readonly TEXT_DECODER = new TextDecoder();
  private static readonly MAX_REGISTRATION_AGE = REREGISTRATION_INTERVAL * 2;
  private static readonly FAST_PUBLISH_EARLY_RETURN_MS = 10_000;
  private static readonly FAST_PUBLISH_POLL_MS = 1000;
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
  private readonly autoRegisterSettingKey: string;
  private readonly isFastMode: boolean;
  private registerInFlight: Promise<boolean> | null = null;

  constructor(node: ChatNode, database: ChatDatabase) {
    this.node = node;
    this.database = database;
    const mode = database.getSessionNetworkMode();
    this.usernameDhtPrefix = getNetworkModeRuntime(mode).config.dhtNamespaces.username;
    this.autoRegisterSettingKey = `auto_register_${mode}`;
    this.isFastMode = mode === NETWORK_MODES.FAST;
  }

  async initialize(userIdentity: EncryptedUserIdentity, onRestoreUsername: (username: string) => void): Promise<void> {
    this.userIdentity = userIdentity;
    const autoRegister = this.database.getSetting(this.autoRegisterSettingKey);

    if (autoRegister === 'never') {
      console.log('Auto-registration is disabled. Use "register <username>" to register a username.');
      return;
    }

    const storedUsernameState = this.readStoredUsernameState(autoRegister);

    if (storedUsernameState.autoRegister === 'true'
      && storedUsernameState.lastUsername
      && storedUsernameState.userDb) {
      console.log(`Auto-registering as '${storedUsernameState.lastUsername}' in background...`);
      void this.restoreStoredUsername(storedUsernameState.userDb, onRestoreUsername).catch((error: unknown) => {
        generalErrorHandler(error);
      });
    }
  }

  async register(username: string, isRenewal: boolean = false, rememberMe: boolean = false): Promise<boolean> {
    if (this.registerInFlight) {
      return this.registerInFlight;
    }

    const registerPromise = this.registerInternal(username, isRenewal, rememberMe);
    this.registerInFlight = registerPromise;
    try {
      return await registerPromise;
    } finally {
      if (this.registerInFlight === registerPromise) {
        this.registerInFlight = null;
      }
    }
  }

  private async registerInternal(username: string, isRenewal: boolean = false, rememberMe: boolean = false): Promise<boolean> {
    console.log(`Registering username: ${username} with rememberMe: ${rememberMe}`);
    if (!this.proceedWithRegistration(username, isRenewal)) {
      return true;
    }

    const registrationContext = this.createRegistrationContext(username);

    await this.ensureUsernameAvailableForRegistration(
      registrationContext.usernameKey,
      registrationContext.myPeerId,
    );

    this.pausePreviousRegistration(registrationContext.previousUsername, username);
    try {
      await this.publishRegistrationPair(registrationContext);
    } catch (error: unknown) {
      this.restorePreviousRegistrationState(registrationContext.previousUsername);
      throw error;
    }

    await this.finalizeRegistration(registrationContext, rememberMe);
    return true;
  }

  async attemptAutoRegister(): Promise<string | null> {
    const storedUsernameState = this.readStoredUsernameState();
    if (storedUsernameState.autoRegister !== 'true') {
      return null;
    }

    if (!storedUsernameState.lastUsername || !storedUsernameState.userDb) {
      return null;
    }

    if (this.currentUsername === storedUsernameState.lastUsername) {
      return storedUsernameState.lastUsername;
    }

    if (!this.hasConnectedPeersForRegistration()) {
      return null;
    }

    const success = await this.renewUsername(storedUsernameState.lastUsername);
    return success ? storedUsernameState.lastUsername : null;
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

    this.database.setSetting(this.autoRegisterSettingKey, 'never');

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

  private readStoredUsernameState(autoRegister: string | null = this.database.getSetting(this.autoRegisterSettingKey)): StoredUsernameState {
    return {
      autoRegister,
      userDb: this.database.getUserByPeerId(this.node.peerId.toString()),
      lastUsername: this.database.getLastUsername(this.node.peerId.toString()),
    };
  }

  private hasConnectedPeersForRegistration(): boolean {
    return this.node.getConnections().length > 0;
  }

  private async renewUsername(username: string): Promise<boolean> {
    return this.register(username, true);
  }

  private async restoreStoredUsername(userDb?: User, onRestoreUsername?: (username: string) => void): Promise<void> {
    if (!userDb?.username || !userDb.peer_id || userDb.peer_id !== this.node.peerId.toString()) {
      return;
    }

    const { username } = userDb;
    console.log(`Attempting to restore username: ${username}`);

    if (!this.hasConnectedPeersForRegistration()) {
      console.log(`Skipping auto-registration for '${username}' - no DHT peers connected`);
      console.log(`Registration will be available once connected to the network`);
      return;
    }

    try {
      await this.renewUsername(username);
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

  private async reregisterCurrentUsername(): Promise<void> {
    try {
      console.log(`Re-registering username: ${this.currentUsername}`);

      if (!this.currentUsername) {
        console.error('Current username not set');
        return;
      }

      await this.renewUsername(this.currentUsername);
    } catch (err: unknown) {
      generalErrorHandler(err, 'Failed to re-register username');
    }
  }

  private startReregistration(): void {
    if (!this.currentUsername) {
      return;
    }
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
    }
    
    this.reregistrationInterval = setInterval(() => {
      void this.reregisterCurrentUsername();
    }, REREGISTRATION_INTERVAL);    
  }

  private stopReregistration(): void {
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
      this.reregistrationInterval = null;
    }
  }

  private proceedWithRegistration(username: string, isRenewal: boolean): boolean {
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
      return false;
    }

    return true;
  }

  private createRegistrationContext(username: string): UsernameRegistrationContext {
    const myPeerId = this.node.peerId.toString();
    const registration = this.#createRegistrationObject(username, 'active');
    const registrationJson = JSON.stringify(registration);

    return {
      username,
      myPeerId,
      usernameKey: this.buildUsernameByNameKey(username),
      peerIdKey: this.buildUsernameByPeerIdKey(myPeerId),
      registrationJson,
      valueBytes: UsernameRegistry.TEXT_ENCODER.encode(registrationJson),
      previousUsername: this.currentUsername,
    };
  }

  private async ensureUsernameAvailableForRegistration(usernameKey: Uint8Array, myPeerId: string): Promise<void> {
    try {
      for await (const event of this.node.services.dht.get(usernameKey) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || !event.value) {
          continue;
        }

        const rawData = UsernameRegistry.TEXT_DECODER.decode(event.value).trim();
        if (!rawData || rawData === '{}') {
          continue;
        }

        let existingRegistration: UserRegistration | null = null;
        try {
          const parsed = JSON.parse(rawData) as unknown;
          if (!isUsernameRegistrationRecord(parsed) || !verifyUsernameRegistrationSignature(parsed)) {
            continue;
          }
          existingRegistration = parsed;
        } catch {
          continue;
        }

        if (!existingRegistration) {
          continue;
        }

        if ((existingRegistration.kind ?? 'active') === 'released') {
          continue;
        }

        const age = Date.now() - existingRegistration.timestamp;
        if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
          continue;
        }

        if (existingRegistration.peerID && existingRegistration.peerID !== myPeerId) {
          throw new Error(ERRORS.USERNAME_TAKEN);
        }

        return;
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
  }

  private pausePreviousRegistration(previousUsername: string | null, nextUsername: string): void {
    if (!previousUsername) return;

    console.log(`Changing username from ${previousUsername} to ${nextUsername}`);
    this.stopReregistration();
  }

  private restorePreviousRegistrationState(previousUsername: string | null): void {
    if (!previousUsername) return;

    this.currentUsername = previousUsername;
    this.startReregistration();
  }

  private getPublishFailureError(publish: UsernamePublishResult, label: string): Error | null {
    if (publish.acceptedCount === 0 && publish.rejectedCount > 0) {
      return new Error(`${label} rejected by DHT validators (${publish.rejectedCount} peer(s) rejected)`);
    }

    if (publish.errorCount > 0 && publish.acceptedCount === 0) {
      return new Error(`${label} failed: all ${publish.errorCount} peers unreachable`);
    }

    return null;
  }

  private async rollbackPartiallyPublishedUsername(username: string): Promise<void> {
    try {
      const released = await this.releaseUsernameByName(username);
      if (!released) {
        console.warn(`Peer ID write failed and rollback release for '${username}' did not fully propagate.`);
      }
    } catch (rollbackError: unknown) {
      generalErrorHandler(rollbackError, `Failed rollback release for partially committed username '${username}'`);
    }
  }

  private async publishRegistrationPair(context: UsernameRegistrationContext): Promise<void> {
    const usernamePublish = await this.publishRecord(context.usernameKey, context.valueBytes);
    const usernamePublishError = this.getPublishFailureError(usernamePublish, 'Username registration');
    if (usernamePublishError) {
      throw usernamePublishError;
    }

    const peerPublish = await this.publishRecord(context.peerIdKey, context.valueBytes);
    const peerPublishError = this.getPublishFailureError(peerPublish, 'Peer ID registration');
    if (peerPublishError) {
      await this.rollbackPartiallyPublishedUsername(context.username);
      throw peerPublishError;
    }

    console.log(`Stored records: username:${context.username} → peerID:${context.myPeerId} → full user data`);
  }

  private async finalizeRegistration(
    context: UsernameRegistrationContext,
    rememberMe: boolean,
  ): Promise<void> {
    if (context.previousUsername && context.previousUsername !== context.username) {
      const released = await this.releaseUsernameByName(context.previousUsername);
      if (!released) {
        console.warn(`Failed to release old username '${context.previousUsername}'. It may remain reserved until stale.`);
      }
    }

    this.currentUsername = context.username;
    await this.persistRegisteredUser(context);

    if (rememberMe) {
      this.database.setSetting(this.autoRegisterSettingKey, 'true');
      console.log(`Registered username: ${context.username} and will auto-register on startup`);
    }

    this.startReregistration();
  }

  private async persistRegisteredUser(context: UsernameRegistrationContext): Promise<void> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    try {
      const existingUser = this.database.getUserByPeerId(context.myPeerId);
      if (existingUser) {
        console.log(`User already exists in database with ID: ${existingUser.peer_id}`);
        if (existingUser.username !== context.username) {
          this.database.updateUsername(context.myPeerId, context.username);
          console.log(`Updated username in database: ${context.username}`);
        }
        return;
      }

      const peerId = await this.database.createUser({
        peer_id: context.myPeerId,
        username: context.username,
        signing_public_key: this.userIdentity.signingPublicKey.toString(),
        offline_public_key: Buffer.from(this.userIdentity.offlinePublicKey).toString('base64'),
        signature: this.userIdentity.sign(context.registrationJson).toString(),
      });
      console.log(peerId ? `User registered in database with peerId: ${peerId}` : 'User may already exist in database');
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to save user to database');
      // Don't fail the registration if database save fails
      // The DHT registration is the primary storage
    }
  }

  #createRegistrationObject(username: string, kind: 'active' | 'released'): UserRegistration {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }
    const identity = this.userIdentity;

    const registrationData: Omit<UserRegistration, 'signature'> = {
      peerID: this.node.peerId.toString(),
      username,
      kind,
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
    return this.#createRegistrationObject(username, 'released');
  }


  private isValidUserRegistration(registration: unknown): registration is UserRegistration {
    return isUsernameRegistrationRecord(registration);
  }

  private readLookupCandidate(
    value: Uint8Array,
    keyLabel: string,
    currentTime: number,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): UserRegistration | null {
    const rawData = UsernameRegistry.TEXT_DECODER.decode(value).trim();

    // Skip empty garbage records
    if (!rawData || rawData === '{}') return null;

    const registration = JSON.parse(rawData) as unknown;
    if (!this.isValidUserRegistration(registration)) return null;
    if (!verifyUsernameRegistrationSignature(registration)) return null;

    // Check if registration is too old (replay attack prevention)
    const age = currentTime - registration.timestamp;
    if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
      console.log(`Discarding old registration for ${keyLabel} (age: ${Math.round(age / 1000)}s)`);
      return null;
    }

    if (extraValidation && !extraValidation(registration)) return null;

    return registration;
  }

  private choosePreferredLookupRegistration(
    current: UserRegistration | null,
    candidate: UserRegistration,
  ): UserRegistration {
    if (current == null || candidate.timestamp > current.timestamp) {
      return candidate;
    }

    // Deterministic tie-break: prefer active over released on same timestamp.
    if (
      current.timestamp === candidate.timestamp &&
      (current.kind ?? 'active') === 'released' &&
      (candidate.kind ?? 'active') !== 'released'
    ) {
      return candidate;
    }

    return current;
  }

  private throwLookupReadFailure(keyLabel: string, dhtErr: unknown): never {
    console.log(`DHT get failed for ${keyLabel}:`, dhtErr instanceof Error ? dhtErr.message : String(dhtErr));
    const dhtErrMessage = dhtErr instanceof Error ? dhtErr.message : String(dhtErr);
    if (this.isRetryableLookupFailure(dhtErrMessage)) {
      throw new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
    }
    throw dhtErr instanceof Error
      ? dhtErr
      : new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
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
          const lookupCandidate = this.readLookupCandidate(
            event.value,
            keyLabel,
            currentTime,
            extraValidation,
          );
          if (!lookupCandidate) {
            continue;
          }

          newestRecord = this.choosePreferredLookupRegistration(newestRecord, lookupCandidate);
        } catch (parseErr: unknown) {
          generalErrorHandler(parseErr, `Failed to parse DHT value for ${keyLabel}`);
        }
      }
    } catch (dhtErr: unknown) {
      this.throwLookupReadFailure(keyLabel, dhtErr);
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
  ): Promise<UsernamePublishResult> {
    const startedAt = Date.now();
    let errorCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;

    const consumePut = async (): Promise<void> => {
      for await (const event of this.node.services.dht.put(key, valueBytes) as AsyncIterable<QueryEvent>) {
        if (event.name === 'QUERY_ERROR') {
          errorCount++;
          continue;
        }

        if (event.name === 'PEER_RESPONSE') {
          const accepted = event.record != null
            && Buffer.from(event.record.value).equals(Buffer.from(valueBytes));
          if (accepted) acceptedCount++;
          else rejectedCount++;
        }
      }
    };

    let finished = false;
    let consumeError: unknown = null;
    const consumePromise = consumePut()
      .catch((error: unknown) => {
        consumeError = error;
      })
      .finally(() => {
        finished = true;
      });

    if (this.isFastMode) {
      const deadline = startedAt + UsernameRegistry.FAST_PUBLISH_EARLY_RETURN_MS;
      while (!finished) {
        if (Date.now() >= deadline && acceptedCount >= 1) {
          void consumePromise;
          return { errorCount, acceptedCount, rejectedCount };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          setTimeout(resolve, UsernameRegistry.FAST_PUBLISH_POLL_MS);
        });
      }
    }

    await consumePromise;
    if (consumeError) {
      throw consumeError;
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
