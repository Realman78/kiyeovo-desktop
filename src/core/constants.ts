import type { CommandConstants, ErrorConstants } from './types.js';

/**
 * Protocol and network constants
 */
export const PROTOCOL_NAME = '/kiyeovo/1.0.0';
export const CHAT_PROTOCOL = `${PROTOCOL_NAME}/chat`;
export const BOOTSTRAP_PROTOCOL = `${PROTOCOL_NAME}/bootstrap`;
export const FILE_TRANSFER_PROTOCOL = `${PROTOCOL_NAME}/file-transfer`;

/**
 * Network configuration
 */
export const DEFAULT_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/0';
export const BOOTSTRAP_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/9000';
export const DEFAULT_LISTEN_PORT = 0; // Random port
export const BOOTSTRAP_PORT = 9000;

/**
 * DHT settings
 */
export const DHT_PROTOCOL = '/kiyeovo/1.0.0/dht';
export const USERNAME_RECORD_PREFIX = 'kiyeovo-user-';
export const K_BUCKET_SIZE = 20;
export const PREFIX_LENGTH = 6;
export const MDNS_SERVICE_TAG = 'kiyeovo.local';

/**
 * Timing configuration
 */
export const REREGISTRATION_INTERVAL = 5 * 60 * 1000;  // 5 minutes
export const PEER_DISCOVERY_INTERVAL = 60 * 1000;      // 1 minute
export const GREETING_DELAY = 1000;                    // 1 second
export const NETWORK_CHECK_DELAY = 3000;               // 3 seconds
export const MESSAGE_TIMEOUT = 10000;                  // 10 seconds
export const MAX_KEY_EXCHANGE_AGE = 5 * 60 * 1000;     // 5 minutes
export const ROTATION_COOLDOWN = 30 * 1000;            // 30 seconds - min time between rotations
export const RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW = 5 * 60 * 1000; // 5 minutes
export const OFFLINE_CHECK_CACHE_TTL = 20 * 1000; // 20 seconds
/**
 * Other
 */
export const KEY_EXCHANGE_RATE_LIMIT_DEFAULT = 10;
/**
 * UI constants
 */
export const PROMPT_DEFAULT = '> ';
export const COMMANDS: CommandConstants = {
  // Core commands
  PEERS: 'peers',
  REGISTER: 'register',
  AUTO_REGISTER: 'auto-register',
  SEND: 'send',
  SEND_FILE: 'send-file',
  WHOAMI: 'whoami',
  PING: 'ping',
  STATUS: 'status',
  HELP: 'help',
  HISTORY: 'history',
  OFFLINE: 'offline',
  // Backup commands
  BACKUP: 'backup',
  RESTORE: 'restore',
  BACKUPS: 'backups',
  // Group commands
  CREATE_GROUP: 'create-group',
  SEND_GROUP: 'send-group',
  GROUP_HISTORY: 'group-history',
  NOTIFICATIONS: 'notifications',
  ACCEPT: 'accept',
  REJECT: 'reject',
  CHECK_ROTATIONS: 'check-rotations',
  // Contact authorization commands
  SET_CONTACT_MODE: 'set-contact-mode',
  ACCEPT_USER: 'accept-user',
  REJECT_USER: 'reject-user',
  PENDING_CONTACTS: 'pending-contacts',
  CONTACT_LOG: 'contact-log',
  BLOCK_USER: 'block-user',
  UNBLOCK_USER: 'unblock-user',
  BLOCKED_USERS: 'blocked-users',
  // File transfer commands
  ACCEPT_FILE: 'accept-file',
  REJECT_FILE: 'reject-file',
  PENDING_FILES: 'pending-files',
  // User settings commands
  SET_KEY_EXCHANGE_RATE_LIMIT: 'set-key-exchange-rate-limit',
  // Profile export/import commands
  EXPORT_PROFILE: 'export-profile',
  TRUST_USER: 'trust-user',
} as const;

/**
 * Error messages
 */
export const ERRORS: ErrorConstants = {
  USERNAME_TAKEN: 'Username already taken',
  USERNAME_NOT_FOUND: 'Username not found',
  MESSAGE_TIMEOUT: 'Message timeout',
  CONNECTION_FAILED: 'Connection failed',
  NO_PEERS_FOUND: 'No peers found'
} as const;

/**
 * Static peer ID files
 */
export const BOOTSTRAP_PEER_ID_FILE = './bootstrap-peer-id.bin';

/**
 * Tor configuration constants
 *
 * Bundled Tor uses ports 9550/9551 to avoid conflicts with:
 * - System Tor (9050/9051)
 * - Tor Browser (9150/9151)
 */
export const TOR_CONFIG = {
  // Bundled Tor ports (used when we run our own Tor instance)
  BUNDLED_SOCKS_PORT: 9550,
  BUNDLED_CONTROL_PORT: 9551,

  // Default ports (fallback, or for system Tor)
  DEFAULT_SOCKS_HOST: '127.0.0.1',
  DEFAULT_SOCKS_PORT: 9550, // Changed to bundled port
  DEFAULT_CONNECTION_TIMEOUT: 30000, // 30 seconds
  DEFAULT_CIRCUIT_TIMEOUT: 60000,    // 60 seconds
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_HEALTH_CHECK_INTERVAL: 60000, // 60 seconds
  DNS_RESOLUTION_TOR: 'tor',
  DNS_RESOLUTION_SYSTEM: 'system'
} as const;

/**
 * Environment variable helpers for Tor configuration
 */
export const getTorConfig = (): {
  enabled: boolean;
  socksHost: string;
  socksPort: number;
  connectionTimeout: number;
  circuitTimeout: number;
  maxRetries: number;
  healthCheckInterval: number;
  dnsResolution: 'tor' | 'system';
} => ({
  enabled: process.env.TOR_ENABLED === 'true',
  socksHost: process.env.TOR_SOCKS_HOST ?? TOR_CONFIG.DEFAULT_SOCKS_HOST,
  socksPort: parseInt(process.env.TOR_SOCKS_PORT ?? TOR_CONFIG.DEFAULT_SOCKS_PORT.toString(), 10),
  connectionTimeout: parseInt(process.env.TOR_CONNECTION_TIMEOUT ?? TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT.toString(), 10),
  circuitTimeout: parseInt(process.env.TOR_CIRCUIT_TIMEOUT ?? TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT.toString(), 10),
  maxRetries: parseInt(process.env.TOR_MAX_RETRIES ?? TOR_CONFIG.DEFAULT_MAX_RETRIES.toString(), 10),
  healthCheckInterval: parseInt(process.env.TOR_HEALTH_CHECK_INTERVAL ?? TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL.toString(), 10),
  dnsResolution: (process.env.TOR_DNS_RESOLUTION as 'tor' | 'system' | undefined) ?? TOR_CONFIG.DNS_RESOLUTION_TOR
});

export const GROUP_DEADLINE = 1000 * 60 * 60 * 6; // 6 hours
export const KEY_ROTATION_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
export const SESSION_MANAGER_CLEANUP_INTERVAL = 60 * 1000; // 1 minute
export const KEEP_ALIVE_INTERVAL = 90000; // 90 seconds
export const OFFLINE_MESSAGE_LIMIT = 100; // 100 messages
export const OFFLINE_MESSAGE_CHECK_INTERVAL = 300 * 1000; // 5 minutes
export const KEY_ROTATION_TIMEOUT = 30 * 1000; // 30 seconds
export const PENDING_KEY_EXCHANGE_EXPIRATION = 5 * 60 * 1000; // 5 minutes
export const FILE_ACCEPTANCE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
export const DATABASE_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
export const MAX_MESSAGES_PER_STORE = 20;
export const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000;
export const DECRYPTION_TIMEOUT = 60 * 1000; // 60 seconds
/**
 * Other
 */
export const FILE_OFFER = 'file_offer';
export const FILE_OFFER_RESPONSE = 'file_offer_response';
export const CHUNK_SIZE = 32 * 1024; // 32KB
export const DOWNLOADS_DIR = '.kiyeovo/downloads';
export const MAX_FILE_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB for JSON overhead
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file size
export const MAX_COPY_ATTEMPTS = 10; // Max number of duplicate filename attempts
export const CHUNK_RECEIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutes to receive all chunks (legacy, kept for total timeout fallback)
export const CHUNK_IDLE_TIMEOUT = 60 * 1000; // 60 seconds - if no chunk received for this long, transfer is stalled
export const FILE_OFFER_RATE_LIMIT = 5; // Max file offers per peer in time window
export const FILE_OFFER_RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
export const MAX_PENDING_FILES_PER_PEER = 5; // Max unanswered file offers per peer
export const MAX_PENDING_FILES_TOTAL = 10; // Max unanswered file offers globally
export const FILE_REJECTION_COUNTER_RESET_INTERVAL = 10 * 60 * 1000; // Reset rejection counters every 10 minutes
export const SILENT_REJECTION_THRESHOLD_GLOBAL = 20; // After N global rejections, stop responding (bandwidth optimization)
export const SILENT_REJECTION_THRESHOLD_PER_PEER = 5; // After N rejections to same peer, stop responding (bandwidth optimization)
export const CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES = 10;