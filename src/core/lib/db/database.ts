/* eslint-disable @typescript-eslint/no-explicit-any */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { generalErrorHandler } from '../../utils/general-error.js';
import type { ContactMode, OfflineMessage } from '../../types.js';
import { DEFAULT_BOOTSTRAP_NODES } from '../../default-bootstrap-nodes.js';
import { PENDING_KEY_EXCHANGE_EXPIRATION } from '../../constants.js';

export interface User {
    peer_id: string
    signing_public_key: string
    offline_public_key: string
    signature: string
    username: string
    created_at: Date
    updated_at: Date
}

export interface Notification {
    id: string
    notification_type: 'group_invitation' // TODO: since we have only one type of notification, maybe a simplification is needed
    notification_data: string // JSON string
    bucket_key: string
    status?: 'pending' | 'accepted' | 'rejected' | 'expired' // Only for group_invitation
    created_at: Date
}

export interface Chat {
    id: number
    type: 'direct' | 'group'
    name: string
    created_by: string
    offline_bucket_secret: string // Shared secret part of bucket key (full key constructed with peer pubkey)
    notifications_bucket_key: string
    group_id?: string // UUID for group chats
    group_key?: string
    permanent_key?: string
    status: 'active' | 'pending'
    offline_last_read_timestamp: number // Last read timestamp for offline messages (prevents re-reading)
    offline_last_ack_sent: number // Last ACK timestamp we sent to this peer (to avoid sending redundant ACKs)
    trusted_out_of_band: boolean // Whether chat was established via out-of-band profile import (uses default inbox)
    created_at: Date
    updated_at: Date
}

export interface ChatParticipant {
    chat_id: number
    peer_id: string
    role: 'admin' | 'member'
    joined_at: Date
}

export interface Message {
    id: string // UUID for deduplication
    chat_id: number
    sender_peer_id: string
    content: string // Encrypted
    message_type: 'text' | 'file' | 'image' | 'system'
    timestamp: Date
    created_at: Date
}

export interface EncryptedUserIdentityDb {
    id: number
    peer_id: string
    encrypted_data: Buffer  // The encrypted JSON blob (stored as BLOB)
    salt: Buffer            // Scrypt salt (stored as BLOB)
    nonce: Buffer           // AES-GCM nonce (stored as BLOB)
    created_at: Date
}

export interface ContactAttempt {
    id: number
    sender_peer_id: string
    sender_username: string // TODO:do we really need to save both username and peer_id?
    message: string
    message_body: string
    timestamp: number
    created_at: Date
}

export interface BlockedPeer {
    peer_id: string
    username: string | null // do we really need to save both username and peer_id?
    blocked_at: Date
    reason: string | null
}

export interface FailedKeyExchange {
    id: number
    target_peer_id: string
    target_username: string // do we really need to save both username and peer_id?
    timestamp: number
    content: string
    reason: string
    created_at: Date
}

export interface OfflineSentMessages {
    bucket_key: string
    messages: OfflineMessage[]
    version: number
    updated_at: Date
}

export interface LoginAttempt {
    id: number
    peer_id: string
    attempt_count: number
    last_attempt_at: Date
    cooldown_until: Date | null
    created_at: Date
}

export interface BootstrapNode {
    id: number
    address: string
    connected: boolean
    created_at: Date
    updated_at: Date
}

export class ChatDatabase {
    private db: Database.Database;
    private dbPath: string;

    constructor(dbPath: string) {
        this.dbPath = dbPath;

        try {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new Database(dbPath);

            // Configure database
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = 10000');
            this.db.pragma('temp_store = memory');
            this.db.pragma('mmap_size = 268435456'); // 256MB
            this.db.pragma('busy_timeout = 5000'); // 5 second timeout
            this.db.pragma('foreign_keys = ON');

            this.initializeTables();
            this.createIndexes();

            // Check database integrity on startup
            this.checkIntegrity();
        } catch (error) {
            generalErrorHandler(error);
            throw error;
        }
    }

    private mapChatRow(row: any): Chat {
        return {
            ...row,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
            trusted_out_of_band: Boolean(row.trusted_out_of_band)
        };
    }

    private initializeTables(): void {
        // Enable WAL mode for better concurrent access
        this.db.pragma('journal_mode = WAL');

        // Users table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                peer_id TEXT PRIMARY KEY NOT NULL,
                signing_public_key TEXT NOT NULL,
                offline_public_key TEXT NOT NULL DEFAULT '',
                signature TEXT NOT NULL,
                username TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Chats table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('direct','group')),
                created_by TEXT NOT NULL,
                offline_bucket_secret TEXT NOT NULL,
                notifications_bucket_key TEXT NOT NULL,
                group_id TEXT,
                group_key TEXT,
                permanent_key TEXT,
                status TEXT NOT NULL CHECK(status IN ('active', 'pending')),
                offline_last_read_timestamp INTEGER DEFAULT 0,
                offline_last_ack_sent INTEGER DEFAULT 0,
                trusted_out_of_band INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (peer_id)
            )
        `);


        // Messages table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY NOT NULL,
                chat_id INTEGER NOT NULL,
                sender_peer_id TEXT NOT NULL,
                content TEXT NOT NULL, -- Decrypted content stored in plaintext (relies on OS disk encryption for at-rest protection)
                message_type TEXT NOT NULL CHECK(message_type IN ('text', 'file', 'image', 'system')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE,
                FOREIGN KEY (sender_peer_id) REFERENCES users (peer_id)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS encrypted_user_identities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_id TEXT UNIQUE NOT NULL,
                encrypted_data BLOB NOT NULL,
                salt BLOB NOT NULL,
                nonce BLOB NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER NOT NULL,
                peer_id TEXT NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (chat_id, peer_id),
                FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE,
                FOREIGN KEY (peer_id) REFERENCES users (peer_id)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY NOT NULL,
                notification_type TEXT NOT NULL CHECK(notification_type IN ('group_invitation')),
                notification_data TEXT NOT NULL, -- JSON string
                bucket_key TEXT NOT NULL,
                status TEXT CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')), -- Only for group invitations
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read BOOLEAN DEFAULT FALSE
            )
        `);

        // Contact attempts log table (for silent mode)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS contact_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_peer_id TEXT NOT NULL,
                sender_username TEXT NOT NULL,
                message TEXT NOT NULL,
                message_body TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Blocked peers table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blocked_peers (
                peer_id TEXT PRIMARY KEY NOT NULL,
                username TEXT,
                blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                reason TEXT
            )
        `);

        // Failed key exchanges table (for sender-side rate limiting)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS failed_key_exchanges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_peer_id TEXT NOT NULL,
                target_username TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                content TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Settings table (for local preferences like contact_mode)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Initialize default contact_mode setting if not exists
        const contactModeSetting = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('contact_mode');
        if (!contactModeSetting) {
            this.db.prepare(`INSERT INTO settings (key, value) VALUES ('contact_mode', 'active')`).run();
        }

        // Offline sent messages table (local cache of messages we've sent to DHT)
        // This eliminates the need to query DHT before writing
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS offline_sent_messages (
                bucket_key TEXT PRIMARY KEY NOT NULL,
                messages TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Login attempts table (for progressive cooldown on failed password attempts)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_id TEXT UNIQUE NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                cooldown_until DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Bootstrap nodes table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bootstrap_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT NOT NULL,
                connected INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Initialize default bootstrap nodes (only once, even if user deletes them later)
        const bootstrapInitialized = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('bootstrap_nodes_initialized');
        if (!bootstrapInitialized) {
            for (const node of DEFAULT_BOOTSTRAP_NODES) {
                this.db.prepare('INSERT INTO bootstrap_nodes (address, connected) VALUES (?, ?)').run(node, 0);
            }
            this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('bootstrap_nodes_initialized', 'true');
        }
    }

    private createIndexes(): void {
        // Indexes for better query performance
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_peer_id ON messages (sender_peer_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
      CREATE INDEX IF NOT EXISTS idx_users_peer_id ON users (peer_id);
      CREATE INDEX IF NOT EXISTS idx_participants_peer ON chat_participants(peer_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

      -- Indexes for cleanup queries
      CREATE INDEX IF NOT EXISTS idx_failed_key_exchanges_timestamp ON failed_key_exchanges(timestamp);
      CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications(status, created_at);
    `);
    }

    // Helper method to retry database operations
    private async retryOperation<T>(operation: () => T, maxRetries: number = 3, delay: number = 100): Promise<T> {
        let lastError: any;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return operation();
            } catch (error: any) {
                lastError = error;
                // If it's a database locked error, wait and retry
                if (error.code === 'SQLITE_BUSY' || error.message.includes('database is locked')) {
                    console.log(`Database locked, retrying... (attempt ${attempt}/${maxRetries})`);
                    // Try to reconnect on the second attempt
                    if (attempt === 2) {
                        try {
                            this.reconnect();
                        } catch (reconnectError) {
                            console.error('Failed to reconnect:', reconnectError);
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                    continue;
                }
                // For other errors, don't retry
                throw error;
            }
        }
        throw lastError;
    }

    // Encrypted user identity operations
    createEncryptedUserIdentity(
        encryptedUserIdentity: Omit<EncryptedUserIdentityDb, 'id' | 'created_at'>
    ): void {
        try {
            const stmt = this.db.prepare(
                'INSERT INTO encrypted_user_identities (peer_id, encrypted_data, salt, nonce) VALUES (?, ?, ?, ?)'
            );
            stmt.run(
                encryptedUserIdentity.peer_id,
                encryptedUserIdentity.encrypted_data,
                encryptedUserIdentity.salt,
                encryptedUserIdentity.nonce
            );
        } catch (error) {
            generalErrorHandler(error);
        }
    }

    getEncryptedUserIdentity(): EncryptedUserIdentityDb | null {
        // TODO if recovery phrase is used, we need to append "-recovery" to the peer_id
        const stmt = this.db.prepare(`SELECT * FROM encrypted_user_identities WHERE peer_id NOT LIKE ? ORDER BY created_at DESC LIMIT 1`);
        const row = stmt.get('%-recovery') as any;
        return row ? {
            id: row.id,
            peer_id: row.peer_id,
            encrypted_data: row.encrypted_data,
            salt: row.salt,
            nonce: row.nonce,
            created_at: new Date(row.created_at)
        } : null;
    }

    getEncryptedUserIdentityByPeerId(peerId: string): EncryptedUserIdentityDb | null {
        const stmt = this.db.prepare('SELECT * FROM encrypted_user_identities WHERE peer_id = ?');
        const row = stmt.get(peerId) as any;
        return row ? {
            id: row.id,
            peer_id: row.peer_id,
            encrypted_data: row.encrypted_data,
            salt: row.salt,
            nonce: row.nonce,
            created_at: new Date(row.created_at)
        } : null;
    }

    // User operations
    async createUser(user: Omit<User, 'created_at' | 'updated_at'>): Promise<string> {
        return this.retryOperation(() => {
            const stmt = this.db.prepare(`
                INSERT INTO users (peer_id, signing_public_key, offline_public_key, signature, username)
                VALUES (?, ?, ?, ?, ?)
            `);

            try {
                stmt.run(user.peer_id, user.signing_public_key, user.offline_public_key, user.signature, user.username);
                return user.peer_id; // Return the peer_id since it's the primary key
            } catch (error: any) {
                console.error('Error creating user:', error);
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    return user.peer_id; // Return the peer_id even if user already exists
                }
                throw error;
            }
        });
    }

    updateUserKeys(user: Omit<User, 'username' | 'created_at' | 'updated_at'>): void {
        const stmt = this.db.prepare('UPDATE users SET signing_public_key = ?, offline_public_key = ?, signature = ? WHERE peer_id = ?');
        stmt.run(user.signing_public_key, user.offline_public_key, user.signature, user.peer_id);
        console.log(`Updated user keys for ${user.peer_id}`);
    }

    updateUsername(peerId: string, username: string): void {
        const stmt = this.db.prepare('UPDATE users SET username = ? WHERE peer_id = ?');
        stmt.run(username, peerId);
        console.log(`Updated username for ${peerId} to ${username}`);
    }

    getUserByUsername(username: string): User | null {
        const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
        const row = stmt.get(username) as any;

        if (!row) return null;

        return {
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerId(peerId: string): User | null {
        const stmt = this.db.prepare('SELECT * FROM users WHERE peer_id = ?');
        const row = stmt.get(peerId) as any;

        if (!row) return null;

        return {
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerIdOrUsername(peerIdOrUsername: string): User | null {
        const stmt = this.db.prepare('SELECT * FROM users WHERE peer_id = ? OR username = ?');
        const row = stmt.get(peerIdOrUsername, peerIdOrUsername) as any;

        if (!row) return null;

        return {
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerIdThenUsername(peerIdOrUsername: string): User | null {
        const stmt = this.db.prepare('SELECT * FROM users WHERE peer_id = ?');
        let row = stmt.get(peerIdOrUsername) as any;
        if (!row) {
            row = this.getUserByUsername(peerIdOrUsername) as any;
        }

        if (!row) return null;

        return {
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getLastUsername(peerId: string): string | null {
        const stmt = this.db.prepare('SELECT username FROM users WHERE peer_id = ? AND username IS NOT NULL');
        const row = stmt.get(peerId) as { username: string } | undefined;
        return row?.username ?? null;
    }

    getUsersPeerIds(usernamesOrPeerIds: string[]): string[] {
        const placeholders = usernamesOrPeerIds.map(() => '?').join(',');
        const stmt = this.db.prepare(
            `SELECT DISTINCT peer_id FROM users WHERE username IN (${placeholders}) OR peer_id IN (${placeholders})`
        );
        const rows = stmt.all(...usernamesOrPeerIds, ...usernamesOrPeerIds) as { peer_id: string }[];
        return rows.map((row: { peer_id: string }) => row.peer_id);
    }

    getUsernamesForPeerIds(peerIds: string[]): Map<string, string> {
        if (peerIds.length === 0) return new Map();
        const placeholders = peerIds.map(() => '?').join(',');
        const stmt = this.db.prepare(`SELECT peer_id, username FROM users WHERE peer_id IN (${placeholders})`);
        const rows = stmt.all(...peerIds) as { peer_id: string, username: string }[];
        return new Map(rows.map(row => [row.peer_id, row.username]));
    }

    deleteUserByPeerId(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM users WHERE peer_id = ?');
        stmt.run(peerId);
    }

    // Generic settings operations
    setSetting(key: string, value: string): void {
        const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
        stmt.run(key, value);
    }

    getSetting(key: string): string | null {
        const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
        const row = stmt.get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    // Contact mode operations
    setContactMode(mode: ContactMode): void {
        this.setSetting('contact_mode', mode);
    }

    getContactMode(): 'active' | 'silent' | 'block' {
        const value = this.getSetting('contact_mode');
        return (value as 'active' | 'silent' | 'block') || 'active';
    }

    // Contact attempt operations (silent mode logging)
    logContactAttempt(attempt: Omit<ContactAttempt, 'id' | 'created_at'>): number {
        const stmt = this.db.prepare(`
            INSERT INTO contact_attempts (sender_peer_id, sender_username, message, message_body, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            attempt.sender_peer_id,
            attempt.sender_username,
            attempt.message,
            attempt.message_body,
            attempt.timestamp
        );

        // FIFO cap at 1000 entries - delete oldest if limit exceeded
        const deleteOldStmt = this.db.prepare(`
            DELETE FROM contact_attempts
            WHERE id IN (
                SELECT id FROM contact_attempts
                ORDER BY timestamp DESC
                LIMIT -1 OFFSET 1000
            )
        `);
        deleteOldStmt.run();

        return result.lastInsertRowid as number;
    }

    getActiveContactAttempts(): ContactAttempt[] {
        // Active are the ones who are not older than PENDING_KEY_EXCHANGE_EXPIRATION (2 minutes)
        return this.getContactAttempts().filter(attempt => attempt.timestamp > Date.now() - PENDING_KEY_EXCHANGE_EXPIRATION);
    }

    getContactAttempts(limit: number = 50, page: number = 1): ContactAttempt[] {
        const stmt = this.db.prepare('SELECT * FROM contact_attempts ORDER BY created_at DESC LIMIT ? OFFSET ?');
        const rows = stmt.all(limit, (page - 1) * limit) as any[];
        return rows.map(row => ({
            id: row.id,
            sender_peer_id: row.sender_peer_id,
            sender_username: row.sender_username,
            message: row.message,
            message_body: row.message_body,
            timestamp: row.timestamp,
            created_at: new Date(row.created_at)
        }));
    }

    getContactAttemptsByPeerId(peerId: string): ContactAttempt[] {
        const stmt = this.db.prepare('SELECT * FROM contact_attempts WHERE sender_peer_id = ?');
        const rows = stmt.all(peerId) as any[];
        return rows.map(row => ({
            id: row.id,
            sender_peer_id: row.sender_peer_id,
            sender_username: row.sender_username,
            message: row.message,
            message_body: row.message_body,
            timestamp: row.timestamp,
            created_at: new Date(row.created_at)
        }));
    }

    deleteContactAttempt(id: number): void {
        const stmt = this.db.prepare('DELETE FROM contact_attempts WHERE id = ?');
        stmt.run(id);
    }

    // Blocked peer operations
    blockPeer(peerId: string, username: string | null = null, reason: string | null = null): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO blocked_peers (peer_id, username, reason)
            VALUES (?, ?, ?)
        `);
        stmt.run(peerId, username, reason);
    }

    unblockPeer(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM blocked_peers WHERE peer_id = ?');
        stmt.run(peerId);
    }

    isBlocked(peerId: string): boolean {
        const stmt = this.db.prepare('SELECT 1 FROM blocked_peers WHERE peer_id = ?');
        const row = stmt.get(peerId);
        return row !== undefined;
    }

    getBlockedPeers(limit: number = 1000): BlockedPeer[] {
        const stmt = this.db.prepare('SELECT * FROM blocked_peers ORDER BY blocked_at DESC LIMIT ?');
        const rows = stmt.all(limit) as any[];
        return rows.map(row => ({
            peer_id: row.peer_id,
            username: row.username,
            blocked_at: new Date(row.blocked_at),
            reason: row.reason
        }));
    }

    // Failed key exchange operations (sender-side rate limiting)
    logFailedKeyExchange(targetPeerId: string, targetUsername: string, content: string, reason: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO failed_key_exchanges (target_peer_id, target_username, timestamp, content, reason)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(targetPeerId, targetUsername, Date.now(), content, reason);
    }

    getRecentFailedKeyExchange(targetPeerId: string, withinMinutes: number = 5): FailedKeyExchange | null {
        const cutoffTime = Date.now() - (withinMinutes * 60 * 1000);
        const stmt = this.db.prepare(`
            SELECT * FROM failed_key_exchanges
            WHERE target_peer_id = ? AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(targetPeerId, cutoffTime) as FailedKeyExchange;
        if (!row) return null;
        return {
            id: row.id,
            target_peer_id: row.target_peer_id,
            target_username: row.target_username,
            timestamp: row.timestamp,
            content: row.content,
            reason: row.reason,
            created_at: new Date(row.created_at)
        };
    }

    cleanupOldFailedKeyExchanges(olderThanMinutes: number = 60): void {
        const cutoffTime = Date.now() - (olderThanMinutes * 60 * 1000);
        const stmt = this.db.prepare('DELETE FROM failed_key_exchanges WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`[CLEANUP] Removed ${result.changes} old failed key exchange records`);
        }
    }

    cleanupExpiredNotifications(olderThanDays: number = 30): void {
        const cutoffTime = new Date(Date.now() - (olderThanDays * 24 * 60 * 60 * 1000)).toISOString();
        const stmt = this.db.prepare(`DELETE FROM notifications WHERE status IN ('accepted', 'rejected', 'expired') AND created_at < ?`);
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`[CLEANUP] Removed ${result.changes} old notification records`);
        }
    }

    runCleanupTasks(): void {
        this.cleanupOldFailedKeyExchanges(60); // Remove failed attempts older than 1 hour
        this.cleanupExpiredNotifications(30); // Remove old processed notifications after 30 days
    }

    // Chat operations
    async createChat(chat: Omit<Chat, 'id' | 'updated_at'> & { participants: string[] }): Promise<number> {
        return this.retryOperation(() => {
            console.log(`Creating chat: created_by=${chat.created_by}, participants=${chat.participants}`);
            const createdByUser = this.db.prepare('SELECT peer_id FROM users WHERE peer_id = ?').get(chat.created_by);
            if (!createdByUser) {
                throw new Error(`User with peer_id '${chat.created_by}' not found in database`);
            }

            this.db.exec('BEGIN TRANSACTION');
            const stmt = this.db.prepare(`
                INSERT INTO chats (created_by, type, name, offline_bucket_secret, notifications_bucket_key, status, group_id, group_key, permanent_key, trusted_out_of_band, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                chat.created_by,
                chat.type,
                chat.type === 'group' ? chat.name : chat.created_by,
                chat.offline_bucket_secret,
                chat.notifications_bucket_key,
                chat.type === 'group' ? 'pending' : 'active',
                chat.type === 'group' && chat?.group_id ? chat.group_id : null,
                chat.type === 'group' && chat?.group_key ? chat.group_key : null,
                chat.type === 'group' && chat?.permanent_key ? chat.permanent_key : null,
                chat.trusted_out_of_band ? 1 : 0,
                chat.created_at instanceof Date ? chat.created_at.toISOString() : chat.created_at
            );
            const chatId = result.lastInsertRowid as number;

            // add participants to chat_participants table
            for (const participant of chat.participants) {
                const stmt = this.db.prepare('INSERT INTO chat_participants (chat_id, peer_id, role) VALUES (?, ?, ?)');
                stmt.run(chatId, participant, chat.created_by === participant ? 'admin' : 'member');
            }

            // commit transaction
            this.db.exec('COMMIT');

            console.log(`Created chat with ID: ${chatId}`);
            return chatId;
        });
    }

    getAllChats(): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            ORDER BY updated_at DESC
        `);
        const rows = stmt.all() as any[];

        if (!rows) return [];
        return rows.map(row => this.mapChatRow(row));
    }

    getAllChatsWithUsernames(myPeerId: string): Array<Chat & { username?: string }> {
        const stmt = this.db.prepare(`
            SELECT
                c.*,
                u.username
            FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct'
            LEFT JOIN users u ON cp.peer_id = u.peer_id AND cp.peer_id != ?
            ORDER BY c.updated_at DESC
        `);
        const rows = stmt.all(myPeerId) as any[];

        if (!rows) return [];
        return rows.map(row => ({
            ...this.mapChatRow(row),
            username: row.username || undefined
        }));
    }

    getAllChatsWithUsernameAndLastMsg(myPeerId: string): Array<Chat & { 
        username?: string | undefined;
        other_peer_id?: string | undefined;
        last_message_content?: string | undefined;
        last_message_timestamp?: Date | undefined;
        last_message_sender?: string | undefined;
    }> {
        const stmt = this.db.prepare(`
            SELECT
                c.*,
                u.username,
                cp.peer_id as other_peer_id,
                last_msg.content as last_message_content,
                last_msg.timestamp as last_message_timestamp,
                last_msg.sender_peer_id as last_message_sender
            FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct' AND cp.peer_id != ?
            LEFT JOIN users u ON cp.peer_id = u.peer_id
            LEFT JOIN messages last_msg ON last_msg.id = (
                SELECT id FROM messages 
                WHERE chat_id = c.id 
                ORDER BY timestamp DESC 
                LIMIT 1
            )
            ORDER BY c.updated_at DESC
        `);
        const rows = stmt.all(myPeerId) as any[];

        if (!rows) return [];
        return rows.map(row => ({
            ...this.mapChatRow(row),
            username: row.username || undefined,
            other_peer_id: row.other_peer_id || undefined,
            last_message_content: row.last_message_content || undefined,
            last_message_timestamp: row.last_message_timestamp ? new Date(row.last_message_timestamp) : undefined,
            last_message_sender: row.last_message_sender || undefined
        }));
    }

    getChats(chatIds: number[]): Chat[] {
        if (chatIds.length === 0) return [];
        const stmt = this.db.prepare(`SELECT * FROM chats WHERE id IN (${chatIds.map(() => '?').join(',')})`);
        const rows = stmt.all(...chatIds) as any[];

        if (!rows) return [];
        return rows.map(row => this.mapChatRow(row));
    }

    getChatByName(name: string, type: 'direct' | 'group' = 'group'): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chats WHERE name = ? AND type = ?');
        const row = stmt.get(name, type) as any;

        if (!row) return null;

        return this.mapChatRow(row);
    }

    getChatByGroupId(groupId: string): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chats WHERE group_id = ?');
        const row = stmt.get(groupId) as any;

        if (!row) return null;

        return this.mapChatRow(row);
    }

    // TODO implement this
    deleteChatById(chatId: number): void {
        const stmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
        stmt.run(chatId);
    }

    deleteChatByGroupId(groupId: string): void {
        const stmt = this.db.prepare('DELETE FROM chats WHERE group_id = ?');
        stmt.run(groupId);
    }

    getAllGroupChats(limit: number = 1000): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE type = 'group'
            ORDER BY updated_at DESC
            LIMIT ?
        `);
        const rows = stmt.all(limit) as any[];

        if (!rows) return [];

        return rows.map(row => this.mapChatRow(row));
    }

    getAllPendingGroupChatsCreatedByMe(myPeerId: string, limit: number = 100): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE type = 'group' AND status = 'pending' AND created_by = ?
            ORDER BY created_at DESC
            LIMIT ?
        `);
        const rows = stmt.all(myPeerId, limit) as any[];

        if (!rows) return [];

        return rows.map(row => this.mapChatRow(row));
    }

    /**
     * Update group permanent key and participants after key rotation
     * Also updates status to 'active'
     */
    updateGroupPermanentKey(chatId: number, permanentKey: string, participants: string[], adminPeerId: string): void {
        const updateChatStmt = this.db.prepare(`
            UPDATE chats
            SET permanent_key = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        updateChatStmt.run(permanentKey, chatId);

        // Delete existing participants
        const deleteParticipantsStmt = this.db.prepare('DELETE FROM chat_participants WHERE chat_id = ?');
        deleteParticipantsStmt.run(chatId);

        // Insert new participants
        for (const peerId of participants) {
            const role = peerId === adminPeerId ? 'admin' : 'member';
            const insertParticipantStmt = this.db.prepare(`
                INSERT INTO chat_participants (chat_id, peer_id, role, joined_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `);
            insertParticipantStmt.run(chatId, peerId, role);
        }

        console.log(`Updated group permanent key and ${participants.length} participants for chat ${chatId}`);
    }

    getChatParticipants(chatId: number): ChatParticipant[] {
        const stmt = this.db.prepare('SELECT * FROM chat_participants WHERE chat_id = ?');
        const rows = stmt.all(chatId) as ChatParticipant[];
        return rows;
    }

    getCountOfChatParticipants(chatId: number): number {
        const stmt = this.db.prepare('SELECT COUNT(*) FROM chat_participants WHERE chat_id = ?');
        const row = stmt.get(chatId) as { count: number };
        return row.count;
    }

    // get chat by peer id - for single direct chat
    getChatByPeerId(otherPeerId: string): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chat_participants WHERE peer_id = ?');
        const rows = stmt.all(otherPeerId) as ChatParticipant[];
        const chatIds = rows.map((row: ChatParticipant) => row.chat_id);

        const chats = this.getChats(chatIds);
        const singleChat = chats.find((chat: Chat) => chat.type === 'direct');
        return singleChat ? {
            id: singleChat.id,
            type: singleChat.type,
            name: singleChat.name,
            created_by: singleChat.created_by,
            offline_bucket_secret: singleChat.offline_bucket_secret,
            notifications_bucket_key: singleChat.notifications_bucket_key,
            status: singleChat.status,
            offline_last_read_timestamp: singleChat.offline_last_read_timestamp,
            offline_last_ack_sent: singleChat.offline_last_ack_sent,
            trusted_out_of_band: singleChat.trusted_out_of_band,
            created_at: new Date(singleChat.created_at),
            updated_at: new Date(singleChat.updated_at)
        } : null;
    }

    getAllOfflineBucketSecrets(includeGroupChats: boolean = true, limit: number = 25): string[] {
        let query = 'SELECT offline_bucket_secret FROM chats';
        if (!includeGroupChats) {
            query += " WHERE type = 'direct'";
        }
        query += ' ORDER BY updated_at DESC LIMIT ?';

        const stmt = this.db.prepare(query);
        const rows = stmt.all(limit) as { offline_bucket_secret: string }[];
        return rows.map(row => row.offline_bucket_secret);
    }

    getOfflineReadBucketInfo(limit: number = 25): Array<{
        offline_bucket_secret: string;
        peer_id: string;
        signing_public_key: string;
        offline_last_read_timestamp: number;
    }> {
        const query = `
            SELECT c.offline_bucket_secret, cp.peer_id, u.signing_public_key, c.offline_last_read_timestamp
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            JOIN users u ON cp.peer_id = u.peer_id
            WHERE c.type = 'direct'
            AND cp.peer_id != c.created_by
            AND cp.peer_id NOT IN (SELECT peer_id FROM blocked_peers)
            ORDER BY c.updated_at DESC
            LIMIT ?
        `;
        const stmt = this.db.prepare(query);
        return stmt.all(limit) as Array<{
            offline_bucket_secret: string;
            peer_id: string;
            signing_public_key: string;
            offline_last_read_timestamp: number;
        }>;
    }

    getOfflineReadBucketInfoForChats(chatIds: number[]): Array<{
        chat_id: number;
        offline_bucket_secret: string;
        peer_id: string;
        signing_public_key: string;
        offline_last_read_timestamp: number;
    }> {
        if (chatIds.length === 0) return [];

        const placeholders = chatIds.map(() => '?').join(',');
        const query = `
            SELECT c.id as chat_id, c.offline_bucket_secret, cp.peer_id, u.signing_public_key, c.offline_last_read_timestamp
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            JOIN users u ON cp.peer_id = u.peer_id
            WHERE c.id IN (${placeholders})
            AND c.type = 'direct'
            AND cp.peer_id != c.created_by
            AND cp.peer_id NOT IN (SELECT peer_id FROM blocked_peers)
        `;
        const stmt = this.db.prepare(query);
        return stmt.all(...chatIds) as Array<{
            chat_id: number;
            offline_bucket_secret: string;
            peer_id: string;
            signing_public_key: string;
            offline_last_read_timestamp: number;
        }>;
    }

    getAllNotificationsBucketKeys(): string[] {
        const stmt = this.db.prepare('SELECT notifications_bucket_key FROM chats');
        const rows = stmt.all() as Chat[];
        return rows.map(row => row.notifications_bucket_key);
    }

    getGroupNotificationBuckerKeysNotCreatedBy(ownerPeerId: string): string[] {
        const stmt = this.db.prepare(`SELECT notifications_bucket_key FROM chats WHERE type = 'group' AND created_by != ?`);
        const rows = stmt.all(ownerPeerId) as Chat[];
        return rows.map(row => row.notifications_bucket_key);
    }


    getNotificationsBucketKeysByPeerIds(peerIds: string[]): string[] {
        const placeholders = peerIds.map(() => '?').join(',');
        // get all notifications bucket keys for the given peer ids (in chats that are only direct chats)
        const stmt = this.db.prepare(`
            SELECT DISTINCT c.notifications_bucket_key 
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE c.type = 'direct' AND cp.peer_id IN (${placeholders})
        `);
        const rows = stmt.all(...peerIds) as { notifications_bucket_key: string }[];
        return rows.map((row: { notifications_bucket_key: string }) => row.notifications_bucket_key);
    }

    getOfflineBucketSecretByPeerId(otherPeerId: string): string | null {
        const chat = this.getChatByPeerId(otherPeerId);
        if (!chat) return null;
        return chat.offline_bucket_secret;
    }

    // Offline message last read timestamp operations
    getOfflineLastReadTimestamp(chatId: number): number {
        const stmt = this.db.prepare('SELECT offline_last_read_timestamp FROM chats WHERE id = ?');
        const row = stmt.get(chatId) as { offline_last_read_timestamp: number };
        return row.offline_last_read_timestamp;
    }

    updateOfflineLastReadTimestamp(chatId: number, timestamp: number): void {
        const stmt = this.db.prepare('UPDATE chats SET offline_last_read_timestamp = ? WHERE id = ?');
        stmt.run(timestamp, chatId);
    }

    getOfflineLastReadTimestampByPeerId(peerId: string): number {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return 0;
        return chat.offline_last_read_timestamp;
    }

    updateOfflineLastReadTimestampByPeerId(peerId: string, timestamp: number): void {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return;
        this.updateOfflineLastReadTimestamp(chat.id, timestamp);
    }

    // Offline ACK sent tracking (to avoid sending redundant ACKs)
    getOfflineLastAckSentByPeerId(peerId: string): number {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return 0;
        return chat.offline_last_ack_sent;
    }

    updateOfflineLastAckSentByPeerId(peerId: string, timestamp: number): void {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return;
        const stmt = this.db.prepare('UPDATE chats SET offline_last_ack_sent = ? WHERE id = ?');
        stmt.run(timestamp, chat.id);
    }

    // Used when upgrading from out-of-band trust
    updateChatEncryptionKeys(chatId: number, keys: {
        offline_bucket_secret: string;
        notifications_bucket_key: string;
        trusted_out_of_band: boolean;
    }): void {
        const stmt = this.db.prepare(`
            UPDATE chats 
            SET offline_bucket_secret = ?, 
                notifications_bucket_key = ?, 
                trusted_out_of_band = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(
            keys.offline_bucket_secret,
            keys.notifications_bucket_key,
            keys.trusted_out_of_band ? 1 : 0,
            chatId
        );
    }

    // Offline sent messages operations (local cache to avoid DHT reads before writes)
    getOfflineSentMessages(bucketKey: string): { messages: OfflineMessage[]; version: number } {
        const stmt = this.db.prepare('SELECT messages, version FROM offline_sent_messages WHERE bucket_key = ?');
        const row = stmt.get(bucketKey) as { messages: string; version: number } | undefined;
        if (!row) {
            return { messages: [], version: 0 };
        }
        return {
            messages: JSON.parse(row.messages) as OfflineMessage[],
            version: row.version
        };
    }

    saveOfflineSentMessages(bucketKey: string, messages: OfflineMessage[], version: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO offline_sent_messages (bucket_key, messages, version, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(bucket_key) DO UPDATE SET
                messages = excluded.messages,
                version = excluded.version,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(bucketKey, JSON.stringify(messages), version);
    }

    deleteOfflineSentMessages(bucketKey: string): void {
        const stmt = this.db.prepare('DELETE FROM offline_sent_messages WHERE bucket_key = ?');
        stmt.run(bucketKey);
    }

    // Message operations
    messageExists(messageId: string): boolean {
        const stmt = this.db.prepare(`SELECT id FROM messages WHERE id = ?`);
        const row = stmt.get(messageId);
        return !!row;
    }

    async createMessage(message: Omit<Message, 'created_at'>): Promise<string> {
        return this.retryOperation(() => {
            const stmt = this.db.prepare(`
                INSERT INTO messages (id, chat_id, sender_peer_id, content, message_type, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                message.id,
                message.chat_id,
                message.sender_peer_id,
                message.content,
                message.message_type,
                message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp
            );

            // Update the chat's updated_at to match the message timestamp
            const updateChatStmt = this.db.prepare(`
                UPDATE chats SET updated_at = ? WHERE id = ?
            `);
            updateChatStmt.run(
                message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp,
                message.chat_id
            );

            return message.id;
        });
    }

    getMessagesByChatId(chatId: number, limit: number = 50, offset: number = 0): Array<Message & { sender_username?: string | undefined }> {
        const stmt = this.db.prepare(`
            SELECT * FROM (
                SELECT
                    m.*,
                    u.username as sender_username
                FROM messages m
                LEFT JOIN users u ON m.sender_peer_id = u.peer_id
                WHERE m.chat_id = ?
                ORDER BY m.timestamp DESC
                LIMIT ? OFFSET ?
            ) AS recent_messages
            ORDER BY timestamp ASC
        `);

        const rows = stmt.all(chatId, limit, offset) as any[];

        return rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp),
            created_at: new Date(row.created_at),
            sender_username: row.sender_username || undefined
        }));
    }

    // TODO implement this for UI
    getLatestMessageForChat(chatId: number): Message | null {
        const stmt = this.db.prepare(`
            SELECT * FROM messages 
            WHERE chat_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 1
        `);

        const row = stmt.get(chatId) as any;

        if (!row) return null;

        return {
            ...row,
            timestamp: new Date(row.timestamp),
            created_at: new Date(row.created_at)
        };
    }

    searchMessages(query: string, chatId?: number): Message[] {
        let stmt: Database.Statement;
        let params: any[];

        if (chatId) {
            stmt = this.db.prepare(`
                SELECT * FROM messages 
                WHERE chat_id = ? AND content LIKE ?
                ORDER BY timestamp DESC 
                LIMIT 100
            `);
            params = [chatId, `%${query}%`];
        } else {
            stmt = this.db.prepare(`
                SELECT * FROM messages 
                WHERE content LIKE ?
                ORDER BY timestamp DESC 
                LIMIT 100
            `);
            params = [`%${query}%`];
        }

        const rows = stmt.all(...params) as any[];
        return rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp),
            created_at: new Date(row.created_at)
        }));
    }

    // Utility methods
    deleteMessage(messageId: number): void {
        const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
        stmt.run(messageId);
    }

    deleteChat(chatId: number): void {
        // Messages will be deleted automatically due to CASCADE
        const stmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
        stmt.run(chatId);
    }

    getMessageCount(chatId: number): number {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
        const result = stmt.get(chatId) as { count: number };
        return result.count;
    }

    // Notification operations
    createNotification(notification: Omit<Notification, 'created_at'>): string {
        const stmt = this.db.prepare('INSERT INTO notifications (id, notification_type, notification_data, bucket_key, status) VALUES (?, ?, ?, ?, ?)');
        stmt.run(notification.id, notification.notification_type, notification.notification_data, notification.bucket_key, notification.status || 'pending');
        return notification.id;
    }

    updateNotificationStatus(notificationId: string, status: 'pending' | 'accepted' | 'rejected' | 'expired'): void {
        const stmt = this.db.prepare('UPDATE notifications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        stmt.run(status, notificationId);
    }

    getNotificationById(notificationId: string): Notification | null {
        const stmt = this.db.prepare('SELECT * FROM notifications WHERE id = ?');
        const row = stmt.get(notificationId) as any;
        if (!row) return null;
        return row as Notification;
    }

    getNotificationsByBucketKey(bucketKey: string): Notification[] {
        const stmt = this.db.prepare('SELECT * FROM notifications WHERE bucket_key = ?');
        const rows = stmt.all(bucketKey) as any[];
        return rows.map(row => ({
            ...row,
            created_at: new Date(row.created_at)
        }));
    }

    getAllNotifications(): Notification[] {
        const stmt = this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC');
        const rows = stmt.all() as any[];
        return rows.map(row => ({
            ...row,
            created_at: new Date(row.created_at)
        }));
    }

    // Bootstrap nodes operations
    getBootstrapNodes(): { address: string; connected: boolean }[] {
        const stmt = this.db.prepare('SELECT address, connected FROM bootstrap_nodes');
        const rows = stmt.all() as { address: string; connected: number }[];
        return rows.map(row => ({ address: row.address, connected: Boolean(row.connected) }));
    }

    updateBootstrapNodeStatus(address: string, connected: boolean): void {
        const stmt = this.db.prepare('UPDATE bootstrap_nodes SET connected = ?, updated_at = CURRENT_TIMESTAMP WHERE address = ?');
        stmt.run(connected ? 1 : 0, address);
    }

    clearAllBootstrapNodeStatus(): void {
        const stmt = this.db.prepare('UPDATE bootstrap_nodes SET connected = 0, updated_at = CURRENT_TIMESTAMP');
        stmt.run();
    }

    removeBootstrapNode(address: string): void {
        const stmt = this.db.prepare('DELETE FROM bootstrap_nodes WHERE address = ?');
        stmt.run(address);
    }

    addBootstrapNode(address: string): void {
        const stmt = this.db.prepare('INSERT INTO bootstrap_nodes (address, connected) VALUES (?, 0)');
        stmt.run(address);
    }

    // Check if database is healthy
    isHealthy(): boolean {
        try {
            // Try a simple query to check if database is accessible
            this.db.prepare('SELECT 1').get();
            return true;
        } catch (error) {
            console.error('Database health check failed:', error);
            return false;
        }
    }

    checkIntegrity(): { ok: boolean; errors: string[] } {
        try {
            const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;

            // integrity_check returns array with single "ok" if healthy, or array of error messages
            const isOk = result.length === 1 && result[0]?.integrity_check === 'ok';
            const errors = isOk ? [] : result.map(r => r.integrity_check);

            if (!isOk) {
                const errorMsg = `Database corruption detected: ${errors.join(', ')}`;
                console.error(`[DATABASE] ${errorMsg}`);
            } else {
                console.log('[DATABASE] Integrity check passed');
            }

            return { ok: isOk, errors };
        } catch (error) {
            const errorMsg = `Database integrity check failed: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`[DATABASE] ${errorMsg}`);
            return { ok: false, errors: [errorMsg] };
        }
    }

    // Reconnect to database if needed
    private reconnect(): void {
        try {
            this.db.close();
        } catch (error) {
            // Ignore close errors
        }
        try {
            this.db = new Database(this.dbPath);
            // Reconfigure database
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = 10000');
            this.db.pragma('temp_store = memory');
            this.db.pragma('mmap_size = 268435456'); // 256MB
            console.log('Database reconnected successfully');
        } catch (error) {
            console.error('Failed to reconnect to database:', error);
            throw error;
        }
    }

    // Login attempts methods
    getLoginAttempt(peerId: string): LoginAttempt | undefined {
        const stmt = this.db.prepare('SELECT * FROM login_attempts WHERE peer_id = ?');
        const row = stmt.get(peerId) as any;
        if (!row) return undefined;

        return {
            ...row,
            last_attempt_at: new Date(row.last_attempt_at),
            cooldown_until: row.cooldown_until ? new Date(row.cooldown_until) : null,
            created_at: new Date(row.created_at)
        };
    }

    recordFailedLoginAttempt(peerId: string): void {
        const existing = this.getLoginAttempt(peerId);
        const now = new Date();

        if (existing) {
            const newCount = existing.attempt_count + 1;
            const cooldownMinutes = this.calculateCooldown(newCount);

            // Only apply cooldown if we've reached 5 or more attempts
            const cooldownUntil = cooldownMinutes > 0
                ? new Date(now.getTime() + cooldownMinutes * 60000)
                : null;

            const stmt = this.db.prepare(`
                UPDATE login_attempts
                SET attempt_count = ?,
                    last_attempt_at = ?,
                    cooldown_until = ?
                WHERE peer_id = ?
            `);
            stmt.run(newCount, now.toISOString(), cooldownUntil?.toISOString() || null, peerId);
        } else {
            // First attempt - no cooldown
            const stmt = this.db.prepare(`
                INSERT INTO login_attempts (peer_id, attempt_count, last_attempt_at, cooldown_until)
                VALUES (?, ?, ?, ?)
            `);
            stmt.run(peerId, 1, now.toISOString(), null);
        }
    }

    clearLoginAttempts(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM login_attempts WHERE peer_id = ?');
        stmt.run(peerId);
    }

    private calculateCooldown(attemptCount: number): number {
        if (attemptCount <= 4) return 0; // No cooldown for first 4 attempts
        if (attemptCount === 5) return 5;
        if (attemptCount === 6) return 10;
        if (attemptCount === 7) return 20;
        if (attemptCount === 8) return 30;
        return 60; // 9+ attempts = 60 minutes
    }

    checkLoginCooldown(peerId: string): { isLocked: boolean; remainingSeconds: number } {
        const attempt = this.getLoginAttempt(peerId);
        if (!attempt || !attempt.cooldown_until) {
            return { isLocked: false, remainingSeconds: 0 };
        }

        const now = new Date();
        const remainingMs = attempt.cooldown_until.getTime() - now.getTime();

        if (remainingMs <= 0) {
            // Cooldown expired
            return { isLocked: false, remainingSeconds: 0 };
        }

        return {
            isLocked: true,
            remainingSeconds: Math.ceil(remainingMs / 1000)
        };
    }

    // Close database connection
    close(): void {
        try {
            console.log('[DATABASE] Shutting down database...');

            // Checkpoint WAL to ensure all data is persisted
            // TRUNCATE mode: checkpoint and truncate WAL file
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            console.log('[DATABASE] WAL checkpoint completed');

            this.db.close();
            console.log('[DATABASE] Database connection closed successfully');
        } catch (error) {
            console.error('[DATABASE] Error during shutdown:', error);
            throw error;
        }
    }

    // Backup methods
    async backup(backupPath: string): Promise<void> {
        await this.db.backup(backupPath);
    }

    // Restore database from backup
    async restore(backupPath: string): Promise<void> {
        // Close current connection
        this.close();

        // Copy backup file to database location
        const fs = await import('fs/promises');
        await fs.copyFile(backupPath, this.dbPath);

        // Reopen database
        this.db = new Database(this.dbPath);

        // Reconfigure database
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = 10000');
        this.db.pragma('temp_store = memory');
        this.db.pragma('mmap_size = 268435456'); // 256MB
        this.db.pragma('busy_timeout = 30000'); // 30 second timeout
        this.db.pragma('foreign_keys = ON');

        console.log('Database restored from backup');
    }
}