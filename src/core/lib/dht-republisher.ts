import type { ChatNode } from '../types.js';
import type { QueryEvent } from '@libp2p/kad-dht';
import {
  GROUP_DHT_REPUBLISH_INTERVAL,
  GROUP_DHT_REPUBLISH_JITTER,
} from '../constants.js';

interface TrackedRecord {
  dhtKey: Uint8Array;
  rawBytes: Uint8Array;
  lastPublished: number;
}

export class DhtRepublisher {
  private node: ChatNode;
  private records: Map<string, TrackedRecord> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(node: ChatNode) {
    this.node = node;
  }

  track(dhtKeyStr: string, dhtKey: Uint8Array, rawBytes: Uint8Array): void {
    this.records.set(dhtKeyStr, {
      dhtKey,
      rawBytes,
      lastPublished: 0,
    });
  }

  untrack(dhtKeyStr: string): void {
    this.records.delete(dhtKeyStr);
  }

  updateBytes(dhtKeyStr: string, rawBytes: Uint8Array): void {
    const existing = this.records.get(dhtKeyStr);
    if (existing) {
      existing.rawBytes = rawBytes;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async republishAll(): Promise<void> {
    const entries = [...this.records.entries()];
    const now = Date.now();

    for (const [keyStr, record] of entries) {
      try {
        await this.putRecord(record.dhtKey, record.rawBytes);
        record.lastPublished = now;
      } catch (err) {
        console.error(`[DHT-REPUBLISH] Failed to re-publish ${keyStr.slice(0, 40)}:`, err);
      }
    }
  }

  private async putRecord(key: Uint8Array, value: Uint8Array): Promise<void> {
    let errorCount = 0;
    let successCount = 0;

    for await (const event of this.node.services.dht.put(key, value) as AsyncIterable<QueryEvent>) {
      if (event.name === 'QUERY_ERROR') {
        errorCount++;
      } else if (event.name === 'PEER_RESPONSE') {
        successCount++;
      }
    }

    if (successCount === 0) {
      throw new Error(`DHT put failed: ${errorCount} errors, 0 successful peers`);
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const jitter = (Math.random() * 2 - 1) * GROUP_DHT_REPUBLISH_JITTER;
    const delay = GROUP_DHT_REPUBLISH_INTERVAL + jitter;
    this.timer = setTimeout(async () => {
      await this.republishAll();
      this.scheduleNext();
    }, delay);
  }
}
