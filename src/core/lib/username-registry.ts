import { ChatDatabase, User } from './db/database.js';
import * as readline from 'readline';
import type { ChatNode, UserRegistration } from '../types.js';
import { ERRORS, REREGISTRATION_INTERVAL } from '../constants.js';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import { QueryEvent } from '@libp2p/kad-dht';

export class UsernameRegistry {
  private static readonly USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
  private static readonly TEXT_ENCODER = new TextEncoder();
  private static readonly TEXT_DECODER = new TextDecoder();
  private static readonly MAX_REGISTRATION_AGE = REREGISTRATION_INTERVAL * 2;

  private node: ChatNode;
  private currentUsername: string | null = null;
  private userIdentity: EncryptedUserIdentity | null = null;
  public reregistrationInterval: NodeJS.Timeout | null = null;
  private database: ChatDatabase;

  constructor(node: ChatNode, database: ChatDatabase) {
    this.node = node;
    this.database = database;
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
      console.log(`Auto-registering as '${lastUsername}'...`);
      try {
        await this.tryRestoreLastUsername(userDb, onRestoreUsername);
      } catch (error: unknown) {
        generalErrorHandler(error);
      }
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
    const usernameKey = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(username));
    const peerIdKey = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(myPeerId));

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
            existingRegistration = JSON.parse(rawData) as UserRegistration;
          } catch (e) {
            // Invalid JSON means we can't verify ownership, treat as garbage/available
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
      const isExpectedError = errMsg.includes('not found') || errMsg.includes('No peers found');
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

    let errorCount = 0;
    let hadSuccess = false;
    // Store username -> user data record (for username lookups)
    for await (const event of this.node.services.dht.put(usernameKey, valueBytes) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') errorCount++;
      else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
    }

    if (errorCount > 0 && !hadSuccess) {
      console.log(`Failed to register username: All ${errorCount} peers unreachable`);
        // If new username registration fails, restart old re-registration
        if (oldUsername) {
          this.currentUsername = oldUsername;
          this.startReregistration();
        }
        return false;
    }

    errorCount = 0;
    hadSuccess = false;

    // Store peerID -> user data record (contains all info)
    for await (const event of this.node.services.dht.put(peerIdKey, valueBytes) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') errorCount++;
      else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
    }

    if (errorCount > 0 && !hadSuccess) {
      console.log(`Failed to register peer ID: All ${errorCount} peers unreachable`);
        // If peer ID record fails, restart old re-registration
        if (oldUsername) {
          this.currentUsername = oldUsername;
          this.startReregistration();
        }
        return false;
    }

    console.log(`Stored records: username:${username} → peerID:${myPeerId} → full user data`);

    // Clear old username from DHT if this is a username change
    if (oldUsername && oldUsername !== username) {
      const oldUsernameKey = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(oldUsername));
      try {
        for await (const event of this.node.services.dht.put(
          oldUsernameKey, 
          UsernameRegistry.TEXT_ENCODER.encode('')
        ) as AsyncIterable<QueryEvent>) {
          if (event.name === 'QUERY_ERROR') {
            console.warn(`Failed to clear old username '${oldUsername}' from DHT (non-fatal). Reason: ${event.error.message}`);
          }
        }
        console.log(`Cleared old username '${oldUsername}' from DHT`);
      } catch (err: unknown) {
        console.warn(`Failed to clear old username from DHT: ${err instanceof Error ? err.message : String(err)}`);
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

  // Use this when you want to go offline or stop using a username temporarily
  async unregister(username: string): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    const result = {
      usernameUnregistered: false,
      peerIdUnregistered: false,
    }

    // Clear username from DHT
    const usernameKey = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(username));
    const peerIdKey = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(this.node.peerId.toString()));

    let errorCount = 0;
    let hadSuccess = false;
    for await (const event of this.node.services.dht.put(
      usernameKey, 
      UsernameRegistry.TEXT_ENCODER.encode('')
    ) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') errorCount++;
      else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
    }

    if (errorCount > 0 && !hadSuccess) {
      console.log(`Failed to unregister username: All ${errorCount} peers unreachable`);
      result.usernameUnregistered = false;
    }

    // Stop re-registration and clear in-memory username
    this.currentUsername = null;
    result.usernameUnregistered = true;
    
    errorCount = 0;
    hadSuccess = false;
    for await (const event of this.node.services.dht.put(
      peerIdKey, 
      UsernameRegistry.TEXT_ENCODER.encode('')
    ) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') errorCount++;
      else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
    }
    if (errorCount > 0 && !hadSuccess) {
      console.log(`Failed to unregister peer ID: All ${errorCount} peers unreachable`);
      result.peerIdUnregistered = false;
    }
    result.peerIdUnregistered = true;

    this.stopReregistration();
    return result;
  }

  async lookup(username: string): Promise<UserRegistration> {
    return this.#lookupByKey(username, ERRORS.USERNAME_NOT_FOUND, (reg) => reg.username === username);
  }

  async lookupByPeerId(peerId: string): Promise<UserRegistration> {
    return this.#lookupByKey(peerId, 'Peer ID not found in DHT');
  }

  /**
   * Looks up a key in the DHT and gets full user data
   * @param key - The key to look up
   * @returns The complete user registration data
   * @throws {Error} If username or peer ID not found or signature invalid
   */
  async #lookupByKey(
    keyString: string,
    notFoundError: string,
    extraValidation?: (reg: UserRegistration) => boolean
  ): Promise<UserRegistration> {
    const key = UsernameRegistry.TEXT_ENCODER.encode(hashUsingSha256(keyString));
    const currentTime = Date.now();

    try {
      for await (const event of this.node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
        if (event.name === 'VALUE' && event.value) {
          try {
            const rawData = UsernameRegistry.TEXT_DECODER.decode(event.value).trim();
            
            // Skip empty or tombstone records
            if (!rawData || rawData === '{}') continue;

            const registration = JSON.parse(rawData) as unknown;
            if (!this.isValidUserRegistration(registration)) continue;

            // Check if registration is too old (replay attack prevention)
            const age = currentTime - registration.timestamp;
            if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
              console.log(`Discarding old registration for ${keyString} (age: ${Math.round(age / 1000)}s)`);
              continue;
            }

            if (extraValidation && !extraValidation(registration)) {
              continue;
            }

            const { signature, ...dataToVerify } = registration;
            if (!EncryptedUserIdentity.verifyKeyExchangeSignature(
              signature, dataToVerify, registration.signingPublicKey
            )) {
              throw new Error(`Invalid signature for registration`);
            }

            return registration;
          } catch (parseErr: unknown) {
            generalErrorHandler(parseErr, `Failed to parse DHT value for ${keyString}`);
          }
        }
      }
    } catch (dhtErr: unknown) {
      console.log(`DHT get failed for ${keyString}:`, dhtErr instanceof Error ? dhtErr.message : String(dhtErr));
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

    const registrationData = {
      peerID: this.node.peerId.toString(),
      username,
      signingPublicKey: Buffer.from(this.userIdentity.signingPublicKey).toString('base64'),
      offlinePublicKey: Buffer.from(this.userIdentity.offlinePublicKey).toString('base64'),
      timestamp: Date.now(),
    };

    const dataToSign = JSON.stringify(registrationData);
    const signature = this.userIdentity.sign(dataToSign);

    return {
      ...registrationData,
      signature: Buffer.from(signature).toString('base64')
    } as UserRegistration;
  }

  async #promptRegistration(username: string): Promise<'yes' | 'no' | 'always' | 'never'> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(`Register as '${username}'? (y/n/always/never): `, (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        if (normalized === 'y' || normalized === 'yes') {
          resolve('yes');
        } else if (normalized === 'always') {
          resolve('always');
        } else if (normalized === 'never') {
          resolve('never');
        } else {
          resolve('no');
        }
      });
    });
  }

  private isValidUserRegistration(registration: unknown): registration is UserRegistration {
    return typeof registration === 'object' && 
    registration !== null && 
    'peerID' in registration && 
    typeof registration.peerID === 'string' && 
    'username' in registration && 
    typeof registration.username === 'string' && 
    'signingPublicKey' in registration && typeof registration.signingPublicKey === 'string' && 'offlinePublicKey' in registration && typeof registration.offlinePublicKey === 'string' && 'timestamp' in registration && typeof registration.timestamp === 'number' && 'signature' in registration && typeof registration.signature === 'string';
  }

  // Note: DHT records will expire naturally over time
  // If unregistration is needed in the future, we can implement it
  // by overwriting records with empty data or using a different approach
}

// podsjetnik za potpisivanje
// signature = PrivateKeySign(hash(data)) // signature je 64 bajta nečitljivog contenta
// kada se radi verifikacija, onda vec imas data i signature -> napravis hash(data) i 
// sa javnim kljucem dekriptiras signature i usporedis sa hash(data) -> ako su isti, potpis je validan