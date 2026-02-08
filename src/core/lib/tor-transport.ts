import { tcp } from '@libp2p/tcp';
import { SocksClient } from 'socks';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Transport, CreateListenerOptions, Listener, DialTransportOptions, MultiaddrConnection, Logger, ComponentLogger, PeerId, Upgrader, Metrics } from '@libp2p/interface';
import { TOR_CONFIG } from '../constants.js';
import { createHash } from 'crypto';
import { transportSymbol } from '@libp2p/interface';
import type { Connection } from '@libp2p/interface';

import { source } from 'stream-to-it';


/**
 * Checks if an IP address is in a private range
 */
function isPrivate(addr: string): boolean {
  return /^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
    /^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
    /^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
    /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
    /^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
    /^f[cd][0-9a-f]{2}:/i.test(addr) ||
    /^fe80:/i.test(addr) ||
    /^::1$/.test(addr);
}

/**
 * Validates an onion v3 address
 * Onion v3 addresses must be exactly 56 characters of base32 (a-z, 2-7)
 */
function isValidOnionV3Address(address: string): boolean {
  return /^[a-z2-7]{56}$/i.test(address);
}

// Generate a 16-character identifier for Tor circuit isolation
// Same peer = same circuit (performance), different peers = different circuits (privacy)
function generateCircuitIdentifier(targetHost: string): string {
  return createHash('sha256')
    .update(targetHost.toLowerCase())
    .digest('hex')
    .slice(0, 16); 
}

/**
 * Wrapper class to make a SOCKS socket compatible with MultiaddrConnection interface
 */
class SocksMultiaddrConnection implements MultiaddrConnection {
  public socket: any;
  public remoteAddr: Multiaddr;
  public localAddr: Multiaddr | undefined;
  public timeline: { open: number; close?: number };
  public log: Logger;
  public source: any;
  public sink: any;

  constructor(socket: any, remoteAddr: Multiaddr) {
    this.socket = socket;
    this.remoteAddr = remoteAddr;
    this.timeline = { open: Date.now() };

    // Populate localAddr from underlying socket if available
    try {
      const la = this.socket?.localAddress;
      const lp = this.socket?.localPort;
      if (la && lp) {
        if (la.includes(':')) {
          this.localAddr = multiaddr(`/ip6/${la}/tcp/${lp}`);
        } else {
          this.localAddr = multiaddr(`/ip4/${la}/tcp/${lp}`);
        }
      }
    } catch {}

    // Convert Node.js stream to async iterable/sink using stream-to-it
    this.source = source(this.socket);
    // Custom sink that converts Uint8ArrayList to Uint8Array before writing to Node socket
    this.sink = async (src: AsyncIterable<any>) => {
      for await (const chunk of src) {
        let buf: Uint8Array;
        if (chunk instanceof Uint8Array) {
          buf = chunk;
        } else if (chunk != null && typeof chunk.subarray === 'function') {
          // Uint8ArrayList supports subarray() -> Uint8Array
          try { buf = chunk.subarray(); } catch { buf = new Uint8Array(0); }
        } else {
          try { buf = Uint8Array.from(chunk); } catch { buf = new Uint8Array(0); }
        }
        await new Promise<void>((resolve, reject) => {
          if (!this.socket || this.socket.destroyed || this.socket.writable !== true) { resolve(); return; }
          this.socket.write(buf, (err: any) => { err ? reject(err) : resolve(); });
        });
      }
    };

    const debug = false; //process.env.DEBUG?.includes('tor') ?? false
    this.log = this.createLogger('[TorTransport:Conn]', debug);

    // Socket lifecycle logging to diagnose premature closes
    try {
      this.socket.on('close', (hadError: boolean) => {
        this.timeline.close = Date.now();
        if (debug) console.log(`[TorTransport] Socket closed, hadError=${hadError}`);
      });
      this.socket.on('error', (err: any) => {
        if (debug) console.error('[TorTransport] SOCKS socket error:', err);
      });
    } catch {}
  }

  /**
   * Create a logger that satisfies the libp2p Logger interface
   */
  private createLogger(prefix: string, debug: boolean): Logger {
    const logFn = debug
      ? (formatter: string, ...args: any[]) => { console.log(`${prefix}`, formatter, ...args); }
      : () => {};

    (logFn as any).enabled = debug;
    (logFn as any).trace = debug
      ? (formatter: string, ...args: any[]) => { console.trace(`${prefix}`, formatter, ...args); }
      : () => {};
    (logFn as any).error = debug
      ? (formatter: string, ...args: any[]) => { console.error(`${prefix}`, formatter, ...args); }
      : () => {};

    // Add newScope method that libp2p's upgrader expects
    (logFn as any).newScope = (scope: string) => {
      return this.createLogger(`${prefix}:${scope}`, debug);
    };

    return logFn as unknown as Logger;
  }

  async close(): Promise<void> {
    this.timeline.close = Date.now();
    if (this.socket && typeof this.socket.destroy === 'function') {
      this.socket.destroy();
    }
  }

  abort(err: Error): void {
    this.timeline.close = Date.now();
    if (this.socket && typeof this.socket.destroy === 'function') {
      this.socket.destroy(err);
    }
  }
}

/**
 * Configuration options for Tor transport
 */
export interface TorTransportOptions {
  socksProxy: {
    host: string
    port: number
  }
  connectionTimeout: number
  maxRetries: number
}

/**
 * Components required for transport initialization
 */
export interface TorTransportComponents {
  peerId: PeerId
  upgrader: Upgrader
  logger: ComponentLogger
  metrics?: Metrics
}

type BootstrapTarget = { host: string, port: number };

/**
 * Tor transport wrapper that routes all connections through SOCKS5 proxy
 * This transport wraps the TCP transport and routes all dial operations through Tor
 */
export class TorTransport implements Transport {
  private tcpTransportFactory: (components: any) => Transport;
  private tcpTransport?: Transport;
  private options: TorTransportOptions;
  private components?: TorTransportComponents;
  private log: Logger;

  constructor(options: TorTransportOptions) {
    this.options = options;
    this.tcpTransportFactory = tcp();

    // Set to true for verbose logging, or use DEBUG=tor environment variable
    const debug = process.env.DEBUG?.includes('tor') ?? false;
    this.log = this.createLogger('[TorTransport]', debug);
  }

  /**
   * Create a logger that satisfies the libp2p Logger interface
   */
  private createLogger(prefix: string, debug: boolean): Logger {
    const self = this;
    const logFn = debug
      ? (formatter: string, ...args: any[]) => { console.log(`${prefix}`, formatter, ...args); }
      : () => {};

    (logFn as any).enabled = debug;
    (logFn as any).trace = debug
      ? (formatter: string, ...args: any[]) => { console.trace(`${prefix}`, formatter, ...args); }
      : () => {};
    (logFn as any).error = debug
      ? (formatter: string, ...args: any[]) => { console.error(`${prefix}`, formatter, ...args); }
      : () => {};

    // Add newScope method that libp2p's upgrader expects
    (logFn as any).newScope = (scope: string) => {
      return self.createLogger(`${prefix}:${scope}`, debug);
    };

    return logFn as unknown as Logger;
  }

  /**
   * Initialize the transport with components
   */
  init(components: TorTransportComponents): void {
    this.components = components;
    this.tcpTransport = this.tcpTransportFactory(components);
  }

  /**
   * Get the transport symbol
   */
  get [transportSymbol](): true {
    return true;
  }

  /**
   * Get the transport protocols supported
   */
  get [Symbol.toStringTag](): string {
    return 'TorTransport';
  }

  /**
   * Filter multiaddrs for dialing
   */
  get dialFilter(): (multiaddrs: Multiaddr[]) => Multiaddr[] {
    return (multiaddrs: Multiaddr[]) => this.filter(multiaddrs);
  }

  /**
   * Filter multiaddrs for listening
   */
  get listenFilter(): (multiaddrs: Multiaddr[]) => Multiaddr[] {
    // This transport is for dialing only, it does not create listeners.
    return () => [];
  }

  /**
   * Dial a peer through the Tor SOCKS5 proxy
   */
  async dial(ma: Multiaddr, options: DialTransportOptions): Promise<Connection> {
    if (!this.tcpTransport) {
      throw new Error('Tor transport not initialized: Transport must be initialized with components before use');
    }

    let host: string;
    let port: number;
    const protoCodes = ma.getComponents().map(c => c.code);

    if (protoCodes.includes(4) || protoCodes.includes(41)) { // IPv4 or IPv6
      const nodeAddress = ma.nodeAddress();
      host = nodeAddress.address;
      port = nodeAddress.port;

      // If the address is private, use TCP transport directly
      if (isPrivate(host)) {
        this.log(`Bypassing Tor for private address: ${host}`);
        return this.tcpTransport.dial(ma, options);
      }
    } else if (protoCodes.includes(445)) { // onion3
      const onionTuple = ma.getComponents().find(c => c.code === 445);
      if (onionTuple?.value == null) {
        throw new Error('Invalid onion address');
      }
      const [onionHost, onionPort] = onionTuple.value.split(':');
      if (onionHost == null || onionPort == null) {
        throw new Error('Invalid onion address: missing host or port');
      }
      if (!isValidOnionV3Address(onionHost)) {
        throw new Error(`Invalid onion v3 address: ${onionHost} (must be exactly 56 characters of base32)`);
      }
      host = `${onionHost}.onion`;
      port = parseInt(onionPort, 10);
    } else {
      throw new Error('Unsupported multiaddr protocol');
    }

    try {
      // Create SOCKS5 connection through Tor
      const socksSocket = await this.createSocksConnection(host, port);

      // Ensure components are available
      if (!this.components) {
        throw new Error('Tor transport components not available: Transport components must be initialized');
      }

      // Create a proper MultiaddrConnection wrapper
      const maConn = new SocksMultiaddrConnection(socksSocket, ma);

      // Use the upgrader to create a proper libp2p connection
      return await this.components.upgrader.upgradeOutbound(maConn, options);

    } catch (error) {
      throw this.handleConnectionError(error, `dial to ${ma.toString()}`);
    }
  }

  /**
   * Create a listener (delegates to TCP transport)
   */
  createListener(options: CreateListenerOptions): Listener {
    if (!this.tcpTransport) {
      throw new Error('Tor transport not initialized: Transport must be initialized with components before use');
    }

    // Delegate to the TCP transport for listening
    return this.tcpTransport.createListener(options);
  }

  /**
   * Filter multiaddrs to only include those supported by this transport
   */
  private filter(multiaddrs: Multiaddr[]): Multiaddr[] {
    // Filter for TCP addresses that we can route through Tor
    return multiaddrs.filter(ma => {
      const protocols = ma.getComponents().map(c => c.code);
      // Support IPv4/IPv6 + TCP combinations or Onion v3 addresses
      const isTcp = (protocols.includes(4) || protocols.includes(41)) && protocols.includes(6);
      const isOnion = protocols.includes(445); // 445 is the code for /onion3
      return isTcp || isOnion;
    });
  }

  /**
   * Create a SOCKS5 connection to the target host and port with retry logic
   * Implements per-peer circuit isolation for privacy
   */
  private async createSocksConnection(targetHost: string, targetPort: number): Promise<any> {
    this.log(`Attempting SOCKS connection to ${targetHost}:${targetPort} via proxy ${this.options.socksProxy.host}:${this.options.socksProxy.port}`);

    const circuitId = generateCircuitIdentifier(targetHost);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        const socksOptions = {
          proxy: {
            host: this.options.socksProxy.host,
            port: this.options.socksProxy.port,
            type: 5 as const, // SOCKS5
          },
          command: 'connect' as const,
          destination: {
            host: targetHost,
            port: targetPort,
          },
          timeout: this.options.connectionTimeout,
          // Circuit isolation: Tor interprets different userId as separate circuit request
          // This prevents traffic correlation between different peers
          // remove this if the app is too slow and needs to be optimized
          userId: circuitId,
        };

        const info = await SocksClient.createConnection(socksOptions);
        const socket = info.socket;
        if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
        if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30000);
        if (typeof socket.setTimeout === 'function') socket.setTimeout(0);

        if (attempt > 1) {
          this.log(`SOCKS connection succeeded on attempt ${attempt}`);
        }

        return socket;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.options.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, ...
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.log(`SOCKS connection attempt ${attempt} failed, retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted
    const message = lastError?.message ?? 'Unknown error';
    throw new Error(`SOCKS5 connection failed after ${this.options.maxRetries} attempts: ${message}`);
  }

  /**
   * Handle connection errors with retry logic
   */
  private handleConnectionError(error: unknown, operation: string): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('ECONNREFUSED')) {
      return new Error(
        `Tor proxy connection refused during ${operation}. ` +
        `Is Tor running on ${this.options.socksProxy.host}:${this.options.socksProxy.port}?`
      );
    }

    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return new Error(
        `Tor connection timeout during ${operation}. The Tor network may be slow or unavailable.`
      );
    }

    if (errorMessage.includes('SOCKS')) {
      return new Error(`SOCKS5 protocol error during ${operation}: ${errorMessage}`);
    }

    return new Error(`Tor transport error during ${operation}: ${errorMessage}`);
  }

  /**
   * Validate Tor connectivity using layered approach:
   * 1. Check local Tor control port (fast, no network traffic)
   * 2. Test connection to bootstrap node (validates actual path)
   * 3. Fallback to check.torproject.org (if bootstrap unknown)
   */
  async validateTorConnectivity(
    bootstrapTargetsOrHost?: string | BootstrapTarget[],
    bootstrapPort?: number
  ): Promise<{ available: boolean }> {
    this.log('Validating Tor connectivity...');

    const bootstrapTargets: BootstrapTarget[] = Array.isArray(bootstrapTargetsOrHost)
      ? bootstrapTargetsOrHost
      : (typeof bootstrapTargetsOrHost === 'string' && typeof bootstrapPort === 'number'
        ? [{ host: bootstrapTargetsOrHost, port: bootstrapPort }]
        : []);

    // Layer 1: Check if Tor control port is accessible (local, fast)
    try {
      const net = await import('net');
      const controlSocket = await new Promise<any>((resolve, reject) => {
        const socket = net.connect(9050, '127.0.0.1', () => {
          resolve(socket);
        });
        socket.on('error', reject);
        socket.setTimeout(1000);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Control port timeout'));
        });
      });

      controlSocket.destroy();
      this.log('✓ Tor control port accessible (127.0.0.1:9050)');
    } catch (error) {
      this.log('Tor control port not accessible (this is OK if Tor is configured differently)');
    }

    // Layer 2: Test connection to bootstrap node if provided
    if (bootstrapTargets.length > 0) {
      for (const target of bootstrapTargets) {
        try {
          this.log(`Testing connection to bootstrap node: ${target.host}:${target.port}`);
          const testConnection = await this.createSocksConnection(target.host, target.port);
          this.log('✓ Successfully connected to bootstrap node via Tor');
          testConnection.destroy();
          return { available: true };
        } catch {
          continue;
        }
      }

      this.log('All bootstrap connectivity checks failed, trying fallback...');
    }

    // Layer 3: Fallback to check.torproject.org
    // Only used when no bootstrap nodes are configured (e.g., development/testing environments)
    // In production with bootstrap nodes, this fallback will never be reached
    try {
      this.log('Testing connection to check.torproject.org...');
      const testConnection = await this.createSocksConnection('check.torproject.org', 80);
      this.log('✓ Successfully connected to check.torproject.org via Tor');
      testConnection.destroy();
      return { available: true };
    } catch (error) {
      this.log.error('All Tor connectivity tests failed:', error);
      return { available: false };
    }
  }
}

/**
 * Create a Tor transport factory function (following libp2p pattern)
 */
export function torTransport(options?: Partial<TorTransportOptions>) {
  return (components: TorTransportComponents): Transport => {
    const defaultOptions: TorTransportOptions = {
      socksProxy: {
        host: TOR_CONFIG.DEFAULT_SOCKS_HOST,
        port: TOR_CONFIG.DEFAULT_SOCKS_PORT,
      },
      connectionTimeout: TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
      maxRetries: TOR_CONFIG.DEFAULT_MAX_RETRIES,
    };

    const finalOptions = {
      ...defaultOptions,
      ...options,
      socksProxy: {
        ...defaultOptions.socksProxy,
        ...options?.socksProxy,
      },
    };

    const transport = new TorTransport(finalOptions);
    transport.init(components);
    return transport;
  };
}

/**
 * Create a Tor transport with default configuration (legacy function)
 */
export function createTorTransport(options?: Partial<TorTransportOptions>): TorTransport {
  const defaultOptions: TorTransportOptions = {
    socksProxy: {
      host: TOR_CONFIG.DEFAULT_SOCKS_HOST,
      port: TOR_CONFIG.DEFAULT_SOCKS_PORT,
    },
    connectionTimeout: TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
    maxRetries: TOR_CONFIG.DEFAULT_MAX_RETRIES,
  };

  return new TorTransport({
    ...defaultOptions,
    ...options,
    socksProxy: {
      ...defaultOptions.socksProxy,
      ...options?.socksProxy,
    },
  });
}

/**
 * Validate Tor connectivity without creating a full transport
 * Useful for health checks on startup
 */
export async function validateTorConnection(
  options?: Partial<TorTransportOptions>,
  bootstrapTargetsOrHost?: string | BootstrapTarget[],
  bootstrapPort?: number
): Promise<{ available: boolean }> {
  const transport = createTorTransport(options);
  return await transport.validateTorConnectivity(bootstrapTargetsOrHost, bootstrapPort);
}