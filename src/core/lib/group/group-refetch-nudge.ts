import type { ChatDatabase } from '../db/database.js';

interface CreatorNudgeDeps {
  database: ChatDatabase;
  myPeerId: string;
  nudgeGroupRefetch?: (peerId: string, groupId: string) => void;
}

export function nudgeGroupRefetchIfCreator(
  deps: CreatorNudgeDeps,
  peerId: string,
  message: object,
): void {
  const groupIdCandidate = (message as { groupId?: unknown }).groupId;
  if (typeof groupIdCandidate !== 'string') {
    return;
  }

  const groupId = groupIdCandidate;
  const chat = deps.database.getChatByGroupId(groupId);
  if (chat?.group_creator_peer_id === deps.myPeerId) {
    deps.nudgeGroupRefetch?.(peerId, groupId);
  }
}
