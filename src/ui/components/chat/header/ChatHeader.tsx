import { useState, useEffect, useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "../../../state/store";
import { Button } from "../../ui/Button";
import { Bell, BellOff, MoreVertical, Shield, UserPlus, Ban, UserCheck, Info, Trash2, AlertCircle, Users, Clock, RefreshCw, LogOut, Bug, UserMinus } from "lucide-react";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";
import { updateChat, clearMessages, removeChat, setOfflineFetchStatus, markOfflineFetched, markOfflineFetchFailed } from "../../../state/slices/chatSlice";
import { AboutUserModal } from "./AboutUserModal";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
  DialogBody,
} from "../../ui/Dialog";
import { useToast } from "../../ui/use-toast";
import { Input } from "../../ui/Input";
import { validateUsername } from "../../../utils/general";
import { InviteUsersDialog, type GroupInviteDeliveryView } from "./InviteUsersDialog";
import { INBOUND_INACTIVITY_WARNING_MS, MAX_GROUP_MEMBERS } from "../../../constants";
import { getGroupStatusMessage, isGroupStatusWaiting } from "../../../utils/groupStatusMessages";
import { getGroupCreatorLinkState } from "../../../utils/groupCreatorLinkHealth";

type ChatHeaderProps = {
  username: string;
  peerId: string;
  chatType?: 'direct' | 'group';
  groupStatus?: string;
  chatId?: number;
}

type GroupInfoDetails = {
  groupId: string;
  keyVersion: number;
  groupStatus: string;
  createdByPeerId: string;
  creatorUsername: string;
  createdAt: Date | null;
};

export const ChatHeader = ({ username, peerId, chatType, groupStatus, chatId }: ChatHeaderProps) => {
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const dispatch = useDispatch();
  const { toast } = useToast();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteChatAndUserConfirmOpen, setDeleteChatAndUserConfirmOpen] = useState(false);
  const [deleteGroupChatConfirmOpen, setDeleteGroupChatConfirmOpen] = useState(false);
  const [leaveGroupConfirmOpen, setLeaveGroupConfirmOpen] = useState(false);
  const [isLeavingGroup, setIsLeavingGroup] = useState(false);
  const [kickMemberDialogOpen, setKickMemberDialogOpen] = useState(false);
  const [selectedKickPeerId, setSelectedKickPeerId] = useState<string | null>(null);
  const [isKickingMember, setIsKickingMember] = useState(false);
  const [inviteUsersDialogOpen, setInviteUsersDialogOpen] = useState(false);
  const [isRequestingGroupUpdate, setIsRequestingGroupUpdate] = useState(false);
  const [isCurrentUserGroupCreator, setIsCurrentUserGroupCreator] = useState(false);
  const [groupInfoDialogOpen, setGroupInfoDialogOpen] = useState(false);
  const [groupInfoLoading, setGroupInfoLoading] = useState(false);
  const [groupInfoDetails, setGroupInfoDetails] = useState<GroupInfoDetails | null>(null);
  const [editUsernameModalOpen, setEditUsernameModalOpen] = useState(false);
  const [newUsername, setNewUsername] = useState(username);
  const [validationError, setValidationError] = useState("");
  const [groupMembers, setGroupMembers] = useState<Array<{ peerId: string; username: string; status: 'pending' | 'accepted' | 'confirmed' }>>([]);
  const creatorPermissionRequestRef = useRef(0);

  const fetchGroupMembers = async () => {
    if (chatType !== 'group' || !chatId) return;
    try {
      const result = await window.kiyeovoAPI.getGroupMembers(chatId);
      if (result.success) {
        setGroupMembers(result.members);
      }
    } catch (error) {
      console.error('Failed to fetch group members:', error);
    }
  };

  useEffect(() => {
    fetchGroupMembers();
  }, [chatType, chatId]);

  const loadGroupInfo = async () => {
    if (chatType !== 'group' || !chatId) return;
    setGroupInfoLoading(true);
    try {
      const [chatResult, membersResult] = await Promise.all([
        window.kiyeovoAPI.getChatById(chatId),
        window.kiyeovoAPI.getGroupMembers(chatId),
      ]);

      if (membersResult.success) {
        setGroupMembers(membersResult.members);
      }

      if (chatResult.success && chatResult.chat) {
        const chat = chatResult.chat;
        setGroupInfoDetails({
          groupId: chat.group_id || '',
          keyVersion: chat.key_version ?? 0,
          groupStatus: chat.group_status || chat.status || 'unknown',
          createdByPeerId: chat.group_creator_peer_id || chat.created_by || '',
          creatorUsername: chat.group_creator_username || activeChat?.groupCreatorUsername || '',
          createdAt: chat.created_at ? new Date(chat.created_at) : null,
        });
      } else {
        setGroupInfoDetails(null);
      }
    } catch (error) {
      console.error('Failed to load group info:', error);
      setGroupInfoDetails(null);
    } finally {
      setGroupInfoLoading(false);
    }
  };

  useEffect(() => {
    if (!groupInfoDialogOpen) return;
    void loadGroupInfo();
  }, [groupInfoDialogOpen, chatType, chatId]);

  const refreshGroupCreatorPermission = async () => {
    if (chatType !== 'group' || !chatId) {
      setIsCurrentUserGroupCreator(false);
      return;
    }

    const requestId = ++creatorPermissionRequestRef.current;
    try {
      const chatResult = await window.kiyeovoAPI.getChatById(chatId);
      if (requestId !== creatorPermissionRequestRef.current) return;
      if (!chatResult.success || !chatResult.chat || !myPeerId) {
        setIsCurrentUserGroupCreator(false);
        return;
      }

      setIsCurrentUserGroupCreator(chatResult.chat.created_by === myPeerId);
    } catch (error) {
      if (requestId !== creatorPermissionRequestRef.current) return;
      console.error('Failed to resolve group creator permission:', error);
      setIsCurrentUserGroupCreator(false);
    }
  };

  useEffect(() => {
    void refreshGroupCreatorPermission();
  }, [chatType, chatId, myPeerId]);

  // Refresh member list whenever an offline-message fetch completes (invite responses arrive)
  useEffect(() => {
    if (chatType !== 'group') return;
    const unsub = window.kiyeovoAPI.onOfflineMessagesFetchComplete(() => {
      void fetchGroupMembers();
    });
    return unsub;
  }, [chatType, chatId]);

  // Refresh member list immediately when creator-side membership updates are processed.
  useEffect(() => {
    if (chatType !== 'group' || !chatId) return;
    const unsub = window.kiyeovoAPI.onGroupMembersUpdated((data) => {
      if (data.chatId === chatId) {
        void (async () => {
          await fetchGroupMembers();
          await refreshGroupCreatorPermission();

          // Keep group status in sync without requiring app restart.
          const chatResult = await window.kiyeovoAPI.getChatById(chatId);
          if (chatResult.success && chatResult.chat) {
            dispatch(updateChat({
              id: chatId,
              updates: {
                status: chatResult.chat.status,
                groupStatus: chatResult.chat.group_status,
              }
            }));
          }
        })();
      }
    });
    return unsub;
  }, [chatType, chatId, dispatch]);

  useEffect(() => {
    const checkBlockedStatus = async () => {
      if (!peerId || !activeChat) return;

      try {
        const result = await window.kiyeovoAPI.isUserBlocked(peerId);
        if (result.success) {
          setIsBlocked(result.blocked);
          // Update Redux state
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: result.blocked }
          }));
        }
      } catch (error) {
        console.error('Failed to check blocked status:', error);
      }
    };

    checkBlockedStatus();
  }, [peerId, activeChat?.id, dispatch]);

  const handleToggleMute = async () => {
    if (!activeChat) return;

    try {
      const result = await window.kiyeovoAPI.toggleChatMute(activeChat.id);
      if (result.success) {
        dispatch(updateChat({
          id: activeChat.id,
          updates: { muted: result.muted }
        }));
      }
    } catch (error) {
      console.error('Failed to toggle mute:', error);
    }
    setDropdownOpen(false);
  };

  const handleToggleBlock = async () => {
    if (!peerId || !activeChat) return;

    try {
      if (isBlocked) {
        const result = await window.kiyeovoAPI.unblockUser(peerId);
        if (result.success) {
          setIsBlocked(false);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: false }
          }));
        }
      } else {
        const result = await window.kiyeovoAPI.blockUser(peerId, username, null);
        if (result.success) {
          setIsBlocked(true);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: true }
          }));
        }
      }
    } catch (error) {
      console.error('Failed to toggle block:', error);
    }
    setDropdownOpen(false);
  };

  const handleAboutUser = () => {
    setAboutModalOpen(true);
    setDropdownOpen(false);
  };

  const handleDeleteAllMessages = () => {
    setDeleteConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleDeleteChatAndUser = () => {
    setDeleteChatAndUserConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleDeleteGroupChat = () => {
    setDeleteGroupChatConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleEditUsername = () => {
    setEditUsernameModalOpen(true);
    setDropdownOpen(false);
  };

  const handleLeaveGroup = () => {
    setLeaveGroupConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleAboutGroup = () => {
    setGroupInfoDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleKickMember = () => {
    setSelectedKickPeerId(null);
    setKickMemberDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleInviteUsers = () => {
    const run = async () => {
      if (!chatId || !myPeerId) {
        toast.error('Only the group creator can invite users');
        setDropdownOpen(false);
        return;
      }

      try {
        const chatResult = await window.kiyeovoAPI.getChatById(chatId);
        const canInvite = Boolean(chatResult.success && chatResult.chat && chatResult.chat.created_by === myPeerId);
        if (!canInvite) {
          setIsCurrentUserGroupCreator(false);
          toast.error('Only the group creator can invite users');
          setDropdownOpen(false);
          return;
        }
      } catch (error) {
        console.error('Failed to verify creator permission for invite:', error);
        toast.error('Failed to verify invite permissions');
        setDropdownOpen(false);
        return;
      }

      if (availableInviteSlots <= 0) {
        toast.info('Group member limit reached');
        setDropdownOpen(false);
        return;
      }

      setInviteUsersDialogOpen(true);
      setDropdownOpen(false);
    };
    void run();
  };

  const handleInviteUsersSuccess = async (inviteDeliveries: GroupInviteDeliveryView[]) => {
    const sentCount = inviteDeliveries.filter((delivery) => delivery.status === 'sent').length;
    const queuedCount = inviteDeliveries.filter((delivery) => delivery.status === 'queued_for_retry').length;

    if (sentCount > 0 && queuedCount === 0) {
      toast.success(`Sent ${sentCount} invite(s)`);
    } else {
      const parts: string[] = [];
      if (sentCount > 0) parts.push(`Sent ${sentCount}`);
      if (queuedCount > 0) parts.push(`queued ${queuedCount} for retry`);
      toast.warning(parts.length > 0 ? `${parts.join(', ')} invite(s)` : 'No users were invited');
    }

    await fetchGroupMembers();
  };

  const handleReinviteUser = async (targetPeerId: string): Promise<{ success: boolean; error?: string }> => {
    if (!chatId) {
      return { success: false, error: 'Group chat not found' };
    }
    try {
      const result = await window.kiyeovoAPI.reinviteUserToGroup(chatId, targetPeerId);
      if (!result.success) {
        const error = result.error || 'Failed to re-invite user';
        toast.error(error);
        return { success: false, error };
      }
      const targetUsername = groupMembers.find((m) => m.peerId === targetPeerId)?.username ?? targetPeerId;
      toast.success(`Re-invited ${targetUsername}`);
      await fetchGroupMembers();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to re-invite user';
      toast.error(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const handleCheckMissedGroupMessages = async () => {
    if (!chatId) return;
    setDropdownOpen(false);
    dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));

    try {
      const result = await window.kiyeovoAPI.checkGroupOfflineMessagesForChat(chatId);
      if (!result.success) {
        toast.error(result.error || 'Failed to check missed group messages');
        dispatch(markOfflineFetchFailed(chatId));
        return;
      }

      if ((result.failedChatIds ?? []).includes(chatId)) {
        dispatch(markOfflineFetchFailed(chatId));
        toast.error('Failed to fetch offline messages');
        return;
      }
      dispatch(markOfflineFetched(chatId));

      const unreadMap = result.unreadFromChats instanceof Map
        ? result.unreadFromChats
        : new Map<number, number>();
      const unread = unreadMap.get(chatId) ?? 0;
      const chatWarnings = result.gapWarnings.filter(w => w.chatId === chatId);

      if (unread > 0) {
        toast.success(`Fetched ${unread} missed group message${unread === 1 ? '' : 's'}`);
      } else {
        toast.info('No missed group messages found');
      }

      if (chatWarnings.length > 0) {
        toast.warning(`Detected ${chatWarnings.length} sequence gap(s); some old messages may be missing`);
      }

      await fetchGroupMembers();
    } catch (error) {
      console.error('Failed to check missed group messages:', error);
      toast.error('Failed to check missed group messages');
      dispatch(markOfflineFetchFailed(chatId));
    }
  };

  const handleRequestGroupUpdate = async () => {
    if (!chatId || isRequestingGroupUpdate) return;
    setDropdownOpen(false);
    setIsRequestingGroupUpdate(true);
    try {
      const result = await window.kiyeovoAPI.requestGroupUpdate(chatId);
      if (!result.success) {
        toast.error(result.error || 'Failed to request group update');
        return;
      }
      toast.info('Group update request sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to request group update');
    } finally {
      setIsRequestingGroupUpdate(false);
    }
  };

  const handleDebugTopics = async () => {
    try {
      const result = await window.kiyeovoAPI.getSubscribedTopics();
      if (!result.success) {
        toast.error(result.error || 'Failed to fetch subscribed topics');
        return;
      }
      console.log(`[GROUP-TOPIC][DEBUG][UI] SUBSCRIBED_TOPICS count=${result.topics.length}`);
      result.topics.forEach((topic, index) => {
        console.log(`[GROUP-TOPIC][DEBUG][UI] TOPIC[${index}] ${topic}`);
      });
      toast.info(`Logged ${result.topics.length} subscribed topic(s) to console`);
    } catch (error) {
      console.error('[GROUP-TOPIC][DEBUG][UI] Failed to fetch subscribed topics:', error);
      toast.error('Failed to fetch subscribed topics');
    }
  };

  const confirmDeleteAllMessages = async () => {
    if (!activeChat) return;

    setIsDeleting(true);
    try {
      const result = await window.kiyeovoAPI.deleteAllMessages(activeChat.id);
      if (result.success) {
        // Clear messages from Redux
        dispatch(clearMessages(activeChat.id));
        // Update chat to clear last message
        dispatch(updateChat({
          id: activeChat.id,
          updates: {
            lastMessage: "SYSTEM: No messages yet",
            lastMessageTimestamp: Date.now()
          }
        }));
      }
    } catch (error) {
      console.error('Failed to delete all messages:', error);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };
  const confirmDeleteChatAndUser = async () => {
    console.log("confirmDeleteChatAndUser", activeChat);
    if (!activeChat || !activeChat.peerId) return;

    setIsDeleting(true);
    try {
      console.log("deleting chat and user", activeChat.id, activeChat.peerId);
      const result = await window.kiyeovoAPI.deleteChatAndUser(activeChat.id, activeChat.peerId);
      console.log("result", result);
      if (result.success) {
        dispatch(removeChat(activeChat.id));
        toast.info("Chat and user deleted successfully");
      }
    } catch (error) {
      console.error('Failed to delete all messages:', error);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  const confirmDeleteGroupChat = async () => {
    if (!activeChat || activeChat.type !== 'group') return;

    setIsDeleting(true);
    try {
      const result = await window.kiyeovoAPI.deleteChat(activeChat.id);
      if (!result.success) {
        toast.error(result.error || 'Failed to delete chat');
        return;
      }
      dispatch(removeChat(activeChat.id));
      toast.info('Chat deleted');
      setDeleteGroupChatConfirmOpen(false);
    } catch (error) {
      console.error('Failed to delete group chat:', error);
      toast.error('Failed to delete chat');
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmEditUsername = async () => {
    if (!activeChat || !activeChat.peerId) return;
    const error = validateUsername(newUsername, activeChat.peerId);
    if (error) {
      setValidationError(error);
      return;
    }
    if (chats.find((chat) => chat.username === newUsername || chat.name === newUsername)) {
      setValidationError("Username already exists");
      return;
    }
    const result = await window.kiyeovoAPI.updateUsername(activeChat.peerId, newUsername);
    if (result.success) {
      toast.info("Username updated successfully");
      setEditUsernameModalOpen(false);
      setValidationError("");
      dispatch(updateChat({
        id: activeChat.id,
        updates: { username: newUsername, name: newUsername }
      }));
    } else {
      toast.error("Failed to update username");
    }
  };

  const confirmLeaveGroup = async () => {
    if (!activeChat || activeChat.type !== 'group') return;

    setIsLeavingGroup(true);
    try {
      const result = isCurrentUserGroupCreator
        ? await window.kiyeovoAPI.disbandGroup(activeChat.id)
        : await window.kiyeovoAPI.leaveGroup(activeChat.id);
      if (!result.success) {
        toast.error(result.error || (isCurrentUserGroupCreator ? 'Failed to disband group' : 'Failed to leave group'));
        return;
      }

      if (isCurrentUserGroupCreator) {
        const refreshed = await window.kiyeovoAPI.getChatById(activeChat.id);
        if (refreshed.success && refreshed.chat) {
          dispatch(updateChat({
            id: activeChat.id,
            updates: {
              status: refreshed.chat.status,
              groupStatus: refreshed.chat.group_status,
            },
          }));
        } else {
          dispatch(updateChat({
            id: activeChat.id,
            updates: { groupStatus: 'disbanded' },
          }));
        }
      } else {
        dispatch(removeChat(activeChat.id));
      }
      toast.info(isCurrentUserGroupCreator ? 'Group disbanded' : 'You left the group');
      setLeaveGroupConfirmOpen(false);
    } catch (error) {
      console.error('Failed to leave group:', error);
      toast.error(isCurrentUserGroupCreator ? 'Failed to disband group' : 'Failed to leave group');
    } finally {
      setIsLeavingGroup(false);
    }
  };

  const confirmKickMember = async () => {
    if (!activeChat || activeChat.type !== 'group' || !selectedKickPeerId) return;

    setIsKickingMember(true);
    try {
      const result = await window.kiyeovoAPI.kickGroupMember(activeChat.id, selectedKickPeerId);
      if (!result.success) {
        toast.error(result.error || 'Failed to remove member');
        return;
      }

      const targetName = groupMembers.find((m) => m.peerId === selectedKickPeerId)?.username ?? 'Member';
      toast.info(`${targetName} was removed from the group`);
      setKickMemberDialogOpen(false);
      setSelectedKickPeerId(null);
      await fetchGroupMembers();
      await refreshGroupCreatorPermission();
    } catch (error) {
      console.error('Failed to remove group member:', error);
      toast.error('Failed to remove member');
    } finally {
      setIsKickingMember(false);
    }
  };

  const isGroup = chatType === 'group';
  const resolvedGroupStatus = groupStatus ?? activeChat?.groupStatus;
  const groupCreatorLinkState = activeChat
    ? getGroupCreatorLinkState(activeChat, chats, myPeerId)
    : { broken: false };
  const isFetchingGroupUpdates = isGroup && activeChat?.isFetchingOffline === true;
  const groupStatusMessage = !isGroup ? null : getGroupStatusMessage(groupStatus);
  const showGroupStateMessage = Boolean(groupStatusMessage);
  const showDirectInactivityWarning = !isGroup
    && typeof activeChat?.lastInboundActivityTimestamp === 'number'
    && (Date.now() - activeChat.lastInboundActivityTimestamp) >= INBOUND_INACTIVITY_WARNING_MS;

  const memberSummary = groupMembers.length > 0
    ? groupMembers.map(m => m.status === 'pending' ? `${m.username} (invited)` : m.username).sort().join(', ')
    : 'No members yet';
  const availableInviteSlots = Math.max(0, MAX_GROUP_MEMBERS - (groupMembers.length + 1));
  const disabledInvitePeers = groupMembers.map((member) => ({
    peerId: member.peerId,
    reason: member.status === 'pending' ? 'Invite pending' : 'Already in group',
  }));
  const pendingInvitePeers = groupMembers
    .filter((member) => member.status === 'pending')
    .map((member) => ({ peerId: member.peerId, username: member.username }));
  const kickableMembers = groupMembers.filter((member) => member.status === 'confirmed');
  const groupInfoCreatorName = isCurrentUserGroupCreator
    ? 'You'
    : (groupInfoDetails?.creatorUsername || activeChat?.groupCreatorUsername || 'Unknown');
  const groupInfoCreatorPeerId = groupInfoDetails?.createdByPeerId || activeChat?.groupCreatorPeerId || 'Unknown';
  const groupInfoStatus = groupInfoDetails?.groupStatus || groupStatus || 'unknown';
  const groupInfoCreatedAt = groupInfoDetails?.createdAt
    ? groupInfoDetails.createdAt.toLocaleString()
    : 'Unknown';
  const confirmedGroupMemberCount = groupMembers.filter((member) => member.status === 'confirmed').length;
  const invitedOrPendingGroupMemberCount = groupMembers.filter((member) => member.status !== 'confirmed').length;
  const groupInfoMemberCount = confirmedGroupMemberCount + 1; // Include current user
  const leaveDialogTitle = isCurrentUserGroupCreator ? 'Disband Group' : 'Leave Group';
  const leaveDialogDescription = isCurrentUserGroupCreator
    ? 'Are you sure you want to disband this group?'
    : 'Are you sure you want to leave this group?';
  const leaveConfirmLabel = isCurrentUserGroupCreator
    ? (isLeavingGroup ? 'Disbanding...' : 'Disband Group')
    : (isLeavingGroup ? 'Leaving...' : 'Leave Group');
  const canShowLeaveOrDisband = isCurrentUserGroupCreator
    ? resolvedGroupStatus !== 'rekeying' && resolvedGroupStatus !== 'disbanded'
    : resolvedGroupStatus === 'active';
  const canRequestGroupUpdate = isGroup
    && !isCurrentUserGroupCreator
    && !groupCreatorLinkState.broken
    && resolvedGroupStatus !== 'invited_pending'
    && resolvedGroupStatus !== 'left'
    && resolvedGroupStatus !== 'removed'
    && resolvedGroupStatus !== 'disbanded';
  const canDeleteGroupChat = isGroup
    && (resolvedGroupStatus === 'disbanded' || groupCreatorLinkState.broken);

  return <div className={`${showGroupStateMessage || showDirectInactivityWarning ? 'h-20' : 'h-16'} px-6 flex items-center justify-between border-b border-border ${activeChat?.status === 'pending' ? "" : "bg-card/50"}`}>
    <div className="flex items-center gap-3">
      {isGroup ? (
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <Users className="w-5 h-5 text-primary" />
        </div>
      ) : activeChat?.status === 'pending' ? (
        <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
          <UserPlus className="w-5 h-5 text-warning" />
        </div>
      ) : null}
      <div>
        <h3 className="font-medium text-foreground text-left flex items-center gap-2">
          <span>{username}</span>
          {isFetchingGroupUpdates && (
            <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
              <span className="w-3 h-3 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
              fetching group updates
            </span>
          )}
        </h3>
        {isGroup ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground truncate max-w-xs text-left" title={memberSummary}>
              {memberSummary}
            </span>
            {showGroupStateMessage && (
              <div className="flex items-center gap-1">
                {isGroupStatusWaiting(groupStatus) ? (
                  <Clock className="w-3 h-3 text-warning" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-warning" />
                )}
                <span className="text-xs text-warning">{groupStatusMessage}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Shield className="w-3 h-3 text-primary" />
              <span className="text-xs text-muted-foreground font-mono">
                {peerId}
              </span>
            </div>
            {showDirectInactivityWarning && (
              <div className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-warning" />
                <span className="text-xs text-warning">
                  No activity from this contact for over 30 days.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    <div className="flex items-center gap-1">
      {isGroup && (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleDebugTopics}
          title="Debug: log subscribed topics"
        >
          <Bug className="w-4 h-4" />
        </Button>
      )}
      <DropdownMenu
        open={dropdownOpen}
        onOpenChange={setDropdownOpen}
        trigger={
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
            <MoreVertical className="w-4 h-4" />
          </Button>
        }
      >
        {isGroup ? (
          <>
            <DropdownMenuItem
              icon={<Info className="w-4 h-4" />}
              onClick={handleAboutGroup}
            >
              About group
            </DropdownMenuItem>
            {groupStatus === 'active' && (
              <DropdownMenuItem
                icon={activeChat?.muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                onClick={handleToggleMute}
              >
                {activeChat?.muted ? 'Enable notifications' : 'Disable notifications'}
              </DropdownMenuItem>
            )}
            {groupStatus === 'active' && (
              <DropdownMenuItem
                icon={<RefreshCw className="w-4 h-4" />}
                onClick={handleCheckMissedGroupMessages}
              >
                Check missed messages
              </DropdownMenuItem>
            )}
            {canRequestGroupUpdate && (
              <DropdownMenuItem
                icon={<RefreshCw className="w-4 h-4" />}
                onClick={handleRequestGroupUpdate}
              >
                {isRequestingGroupUpdate ? 'Requesting update...' : 'Request group update'}
              </DropdownMenuItem>
            )}
            {groupStatus === 'active' && isCurrentUserGroupCreator && (
              <DropdownMenuItem
                icon={<UserPlus className="w-4 h-4" />}
                onClick={handleInviteUsers}
              >
                Invite users
              </DropdownMenuItem>
            )}
            {groupStatus === 'active' && isCurrentUserGroupCreator && kickableMembers.length > 0 && (
              <DropdownMenuItem
                icon={<UserMinus className="w-4 h-4" />}
                onClick={handleKickMember}
              >
                Remove member
              </DropdownMenuItem>
            )}
            {canShowLeaveOrDisband && (
              <DropdownMenuItem
                icon={<LogOut className="w-4 h-4" />}
                onClick={handleLeaveGroup}
              >
                {isCurrentUserGroupCreator ? 'Disband group' : 'Leave group'}
              </DropdownMenuItem>
            )}
            {canDeleteGroupChat && (
              <DropdownMenuItem
                icon={<Trash2 className="w-4 h-4" />}
                onClick={handleDeleteGroupChat}
              >
                Delete chat
              </DropdownMenuItem>
            )}
          </>
        ) : (
          <>
            <DropdownMenuItem
              icon={<Info className="w-4 h-4" />}
              onClick={handleAboutUser}
            >
              About user
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Info className="w-4 h-4" />}
              onClick={handleEditUsername}
            >
              Edit username
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={activeChat?.muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              onClick={handleToggleMute}
            >
              {activeChat?.muted ? 'Enable notifications' : 'Disable notifications'}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={isBlocked ? <UserCheck className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
              onClick={handleToggleBlock}
            >
              {isBlocked ? 'Unblock user' : 'Block user'}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Trash2 className="w-4 h-4" />}
              onClick={handleDeleteAllMessages}
            >
              Clear messages
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Trash2 className="w-4 h-4" />}
              onClick={handleDeleteChatAndUser}
            >
              Delete chat & User
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenu>
    </div>

    {activeChat && (
      <>
        <AboutUserModal
          open={aboutModalOpen}
          onOpenChange={setAboutModalOpen}
          peerId={peerId}
          chatId={activeChat.id}
        />
        {isGroup && chatId && (
          <InviteUsersDialog
            open={inviteUsersDialogOpen}
            onOpenChange={setInviteUsersDialogOpen}
            chatId={chatId}
            groupName={username}
            disabledPeers={disabledInvitePeers}
            pendingInvitePeers={pendingInvitePeers}
            maxSelectable={availableInviteSlots}
            onSuccess={handleInviteUsersSuccess}
            onReinvite={handleReinviteUser}
          />
        )}
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete All Messages</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete all messages in this chat? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteAllMessages}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete All'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={deleteChatAndUserConfirmOpen} onOpenChange={setDeleteChatAndUserConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Chat & User</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this chat and user? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
                <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                <div className="text-sm text-warning">
                  <p className="font-semibold mb-1">Warning: Offline messages will not work immediately</p>
                  {/* TODO change the text below after testing*/}
                  <p className="text-xs">
                    If you make contact with <span className="font-semibold">{username}</span> again, offline delivery and group updates in groups that <span className="font-semibold">{username}</span>  is the creator of (or you are the creator of and the user is in those groups) WILL NOT WORK unless <span className="font-semibold">{username}</span> also deletes your account and then you establish a new contact.
                  </p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleteChatAndUserConfirmOpen(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteChatAndUser}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Chat'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={deleteGroupChatConfirmOpen} onOpenChange={setDeleteGroupChatConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Group Chat</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this group chat? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
                <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                <div className="text-sm text-warning">
                  <p className="font-semibold mb-1">Local action</p>
                  <p className="text-xs">
                    This only removes the chat from your device.
                  </p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleteGroupChatConfirmOpen(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteGroupChat}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Chat'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={leaveGroupConfirmOpen} onOpenChange={setLeaveGroupConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{leaveDialogTitle}</DialogTitle>
              <DialogDescription>
                {leaveDialogDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
                <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                <div className="text-sm text-warning">
                  <p className="font-semibold mb-1">Consequences</p>
                  <p className="text-xs">
                    {isCurrentUserGroupCreator
                      ? 'Members will receive a disband notification and this chat will become read-only with a disbanded status.'
                      : 'You will stop receiving new group messages and cannot send to this group. Rejoining requires a new invite from the group creator.'}
                  </p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setLeaveGroupConfirmOpen(false)}
                disabled={isLeavingGroup}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmLeaveGroup}
                disabled={isLeavingGroup}
              >
                {leaveConfirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={groupInfoDialogOpen} onOpenChange={setGroupInfoDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Group Info</DialogTitle>
              <DialogDescription>
                Details about this group and its members.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="max-h-[60vh] overflow-y-auto space-y-4">
              {groupInfoLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Name</span>
                      <span className="font-medium text-right">{username}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Status</span>
                      <span className="text-right">{groupInfoStatus}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Key version</span>
                      <span className="font-mono text-right">{groupInfoDetails?.keyVersion ?? 0}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Creator</span>
                      <span className="text-right">{groupInfoCreatorName}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Creator peer ID</span>
                      <span className="font-mono text-xs text-right break-all">{groupInfoCreatorPeerId}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Created</span>
                      <span className="text-right">{groupInfoCreatedAt}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Members</span>
                      <span className="text-right">{groupInfoMemberCount}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Invited/Pending</span>
                      <span className="text-right">{invitedOrPendingGroupMemberCount}</span>
                    </div>
                  </div>
                  <div className="border-t border-border pt-3 space-y-2">
                    <h4 className="text-sm font-medium">Member list</h4>
                    <div className="max-h-56 overflow-y-auto border border-border rounded-md">
                      <div className="px-3 py-2.5 border-b border-border text-sm flex items-center justify-between">
                        <span>You</span>
                        <span className="text-xs text-muted-foreground">{isCurrentUserGroupCreator ? 'creator' : 'member'}</span>
                      </div>
                      {groupMembers.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">No other members yet.</div>
                      ) : (
                        groupMembers
                          .slice()
                          .sort((a, b) => a.username.localeCompare(b.username))
                          .map((member) => (
                            <div key={member.peerId} className="px-3 py-2.5 border-b border-border last:border-b-0 text-sm flex items-center justify-between gap-3">
                              <span className="truncate">{member.username}</span>
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {member.status === 'confirmed' ? 'member' : member.status === 'accepted' ? 'awaiting activation' : 'invited'}
                              </span>
                            </div>
                          ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => setGroupInfoDialogOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={kickMemberDialogOpen} onOpenChange={setKickMemberDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove Member</DialogTitle>
              <DialogDescription>
                Select a member to remove from this group.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="max-h-56 overflow-y-auto border border-border rounded-md">
                {kickableMembers.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">No removable members.</div>
                ) : (
                  kickableMembers.map((member) => {
                    const isSelected = selectedKickPeerId === member.peerId;
                    return (
                      <button
                        key={member.peerId}
                        type="button"
                        disabled={isKickingMember}
                        onClick={() => setSelectedKickPeerId(member.peerId)}
                        className={`cursor-pointer w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors ${isSelected ? 'bg-destructive/10 text-destructive' : 'hover:bg-secondary/50'
                          }`}
                      >
                        {member.username}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
                <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                <div className="text-sm text-warning">
                  <p className="font-semibold mb-1">Consequences</p>
                  <p className="text-xs">
                    The member will lose access to new group messages immediately and can rejoin only through a new invite.
                  </p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setKickMemberDialogOpen(false)}
                disabled={isKickingMember}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmKickMember}
                disabled={isKickingMember || !selectedKickPeerId}
              >
                {isKickingMember ? 'Removing...' : 'Remove Member'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={editUsernameModalOpen} onOpenChange={setEditUsernameModalOpen}>
          <DialogContent>
            <form onSubmit={(e) => {
              e.preventDefault();
              confirmEditUsername();
            }}>
              <DialogHeader>
                <DialogTitle>Edit Username</DialogTitle>
                <DialogDescription>
                  Enter new username for {username}. This action edits {username}'s username only for you.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <label className="block text-sm font-medium text-foreground mb-2">
                  New Username
                </label>
                <Input
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="Enter new username"
                />
                {validationError && (
                  <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>{validationError}</span>
                  </div>
                )}
              </DialogBody>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditUsernameModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  disabled={validateUsername(newUsername, peerId) !== ""}
                >
                  Confirm
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </>
    )}
  </div>
}
