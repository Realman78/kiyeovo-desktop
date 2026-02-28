import type { ChatNode } from '../../types.js';
import {
  GROUP_INFO_REPUBLISH_MAX_ATTEMPTS,
  GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY,
  GROUP_INFO_REPUBLISH_RETRY_STEADY_DELAY,
} from '../../constants.js';
import { generalErrorHandler } from '../../utils/general-error.js';
import type { ChatDatabase, GroupPendingInfoPublish } from '../db/database.js';
import type { GroupInfoLatest, GroupInfoVersioned } from './types.js';
import { putJsonToDHT } from './group-dht-publish.js';

interface GroupInfoRepublisherDeps {
  node: ChatNode;
  database: ChatDatabase;
}

export class GroupInfoRepublisher {
  private readonly deps: GroupInfoRepublisherDeps;
  private inFlight = false;

  constructor(deps: GroupInfoRepublisherDeps) {
    this.deps = deps;
  }

  async runCycle(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      const due = this.deps.database.getDuePendingGroupInfoPublishes(now, 100);
      if (due.length === 0) return;
      const connectedPeers = this.deps.node.getConnections().length;
      if (connectedPeers === 0) {
        console.log(`[GROUP-INFO][CYCLE][SKIP] due=${due.length} reason=no_connected_peers`);
        return;
      }

      let published = 0;
      let failed = 0;
      let removedInvalid = 0;
      let removedStale = 0;
      let removedCapped = 0;
      console.log(`[GROUP-INFO][CYCLE][START] due=${due.length} connectedPeers=${connectedPeers}`);

      for (const pending of due) {
        try {
          const pruneReason = this.getPruneReason(pending);
          if (pruneReason) {
            this.deps.database.removePendingGroupInfoPublish(pending.group_id, pending.key_version);
            if (pruneReason === 'attempt_cap') removedCapped++;
            else removedStale++;
            console.log(
              `[GROUP-INFO][ITEM][REMOVE] group=${pending.group_id} keyVersion=${pending.key_version} reason=${pruneReason}`,
            );
            continue;
          }

          const parsed = this.parsePendingPayloads(pending);
          if (!parsed) {
            this.deps.database.removePendingGroupInfoPublish(pending.group_id, pending.key_version);
            removedInvalid++;
            console.log(
              `[GROUP-INFO][ITEM][REMOVE] group=${pending.group_id} keyVersion=${pending.key_version} reason=invalid_payload`,
            );
            continue;
          }

          await putJsonToDHT(this.deps.node, parsed.versionedDhtKey, parsed.versionedRecord);
          await putJsonToDHT(this.deps.node, parsed.latestDhtKey, parsed.latestRecord);

          this.deps.database.updateGroupKeyStateHash(pending.group_id, pending.key_version, parsed.versionedRecord.stateHash);
          if (pending.key_version > 1) {
            this.deps.database.markGroupKeyUsedUntil(pending.group_id, pending.key_version - 1, Date.now());
          }
          this.deps.database.removePendingGroupInfoPublish(pending.group_id, pending.key_version);
          published++;
          console.log(
            `[GROUP-INFO][ITEM][DONE] group=${pending.group_id} keyVersion=${pending.key_version}`,
          );
        } catch (error: unknown) {
          failed++;
          const errorText = error instanceof Error ? error.message : String(error);
          const nextRetryAt = Date.now() + this.computeRetryDelay(pending.attempts);
          this.deps.database.markPendingGroupInfoPublishAttempt(
            pending.group_id,
            pending.key_version,
            nextRetryAt,
            errorText,
          );
          generalErrorHandler(
            error,
            `[GROUP-INFO] Failed to republish group=${pending.group_id} keyVersion=${pending.key_version}`,
          );
        }
      }

      console.log(
        `[GROUP-INFO][CYCLE][DONE] published=${published} failed=${failed} removedInvalid=${removedInvalid} removedStale=${removedStale} removedCapped=${removedCapped}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private parsePendingPayloads(pending: GroupPendingInfoPublish): {
    versionedDhtKey: string;
    latestDhtKey: string;
    versionedRecord: GroupInfoVersioned;
    latestRecord: GroupInfoLatest;
  } | null {
    try {
      const versionedRecord = JSON.parse(pending.versioned_payload) as GroupInfoVersioned;
      const latestRecord = JSON.parse(pending.latest_payload) as GroupInfoLatest;
      if (
        versionedRecord.groupId !== pending.group_id
        || versionedRecord.version !== pending.key_version
        || latestRecord.groupId !== pending.group_id
        || latestRecord.latestVersion !== pending.key_version
      ) {
        return null;
      }
      return {
        versionedDhtKey: pending.versioned_dht_key,
        latestDhtKey: pending.latest_dht_key,
        versionedRecord,
        latestRecord,
      };
    } catch {
      return null;
    }
  }

  private computeRetryDelay(attempts: number): number {
    const base = attempts <= 0
      ? GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY
      : GROUP_INFO_REPUBLISH_RETRY_STEADY_DELAY;
    const jitter = base * (Math.random() * 0.2);
    return Math.floor(base + jitter);
  }

  private getPruneReason(pending: GroupPendingInfoPublish): 'attempt_cap' | 'group_missing' | 'epoch_missing' | null {
    if (pending.attempts >= GROUP_INFO_REPUBLISH_MAX_ATTEMPTS) {
      return 'attempt_cap';
    }

    const chat = this.deps.database.getChatByGroupId(pending.group_id);
    if (!chat || chat.type !== 'group') {
      return 'group_missing';
    }

    const keyExists = this.deps.database.getGroupKeyForEpoch(pending.group_id, pending.key_version);
    if (!keyExists) {
      return 'epoch_missing';
    }

    return null;
  }
}
