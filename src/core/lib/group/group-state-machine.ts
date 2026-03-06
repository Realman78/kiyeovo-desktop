import type { GroupStatus } from './types.js';

const ALLOWED_TRANSITIONS: Record<GroupStatus, ReadonlySet<GroupStatus>> = {
  invited_pending: new Set<GroupStatus>([
    'awaiting_activation',
    'invite_expired',
    'left',
    'removed',
    'rekeying',
    'active',
  ]),
  awaiting_activation: new Set<GroupStatus>([
    'active',
    'left',
    'removed',
    'invite_expired',
  ]),
  active: new Set<GroupStatus>([
    'rekeying',
    'left',
    'removed',
  ]),
  rekeying: new Set<GroupStatus>([
    'active',
    'left',
    'removed',
    // Creator may roll back first-join rotation to invited_pending on failure.
    'invited_pending',
  ]),
  left: new Set<GroupStatus>([
    // Re-invite path.
    'invited_pending',
    'awaiting_activation',
  ]),
  removed: new Set<GroupStatus>([
    // Re-invite path.
    'invited_pending',
    'awaiting_activation',
  ]),
  invite_expired: new Set<GroupStatus>([
    'invited_pending',
    'awaiting_activation',
    'left',
    'removed',
  ]),
};

export function isGroupStatus(value: unknown): value is GroupStatus {
  if (typeof value !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, value);
}

export function isGroupTransitionAllowed(from: GroupStatus, to: GroupStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertGroupTransition(from: GroupStatus, to: GroupStatus, context?: string): void {
  if (isGroupTransitionAllowed(from, to)) return;
  const suffix = context ? ` (${context})` : '';
  throw new Error(`Invalid group status transition: ${from} -> ${to}${suffix}`);
}
