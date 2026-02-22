import { useState, useEffect, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { GroupInviteItem, type GroupInvite } from "./GroupInviteItem";
import { useToast } from "../../ui/use-toast";
import type { FC } from "react";
import { useDispatch } from "react-redux";
import { setChats, type Chat } from "../../../state/slices/chatSlice";

export const GroupInviteList: FC = () => {
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const dispatch = useDispatch();

  const fetchInvites = useCallback(async () => {
    try {
      const result = await window.kiyeovoAPI.getGroupInvites();
      if (result.success) {
        setInvites(result.invites);
      }
    } catch (error) {
      console.error('Failed to fetch group invites:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  useEffect(() => {
    const unsubscribe = window.kiyeovoAPI.onOfflineMessagesFetchComplete(() => {
      void fetchInvites();
    });

    return () => {
      unsubscribe();
    };
  }, [fetchInvites]);

  const handleRespond = async (groupId: string, accept: boolean) => {
    try {
      const result = await window.kiyeovoAPI.respondToGroupInvite(groupId, accept);
      if (result.success) {
        setInvites(prev => prev.filter(inv => inv.groupId !== groupId));
        if (accept) {
          const chatsResult = await window.kiyeovoAPI.getChats();
          if (chatsResult.success) {
            const mappedChats: Chat[] = chatsResult.chats.map((dbChat: any) => ({
              id: dbChat.id,
              type: dbChat.type,
              name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
              peerId: dbChat.other_peer_id,
              lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
              lastMessageTimestamp: dbChat.last_message_timestamp
                ? new Date(dbChat.last_message_timestamp).getTime()
                : new Date(dbChat.updated_at).getTime(),
              unreadCount: 0,
              status: dbChat.status,
              fetchedOffline: dbChat.type === 'group',
              isFetchingOffline: false,
              blocked: dbChat.blocked,
              muted: dbChat.muted,
              groupStatus: dbChat.group_status,
            }));
            dispatch(setChats(mappedChats));
          }
        }
        toast.success(
          accept
            ? 'Group invite accepted. Waiting for creator activation...'
            : 'Group invite rejected'
        );
      } else {
        toast.error(result.error || 'Failed to respond to invite');
      }
    } catch (error) {
      console.error('Failed to respond to group invite:', error);
      toast.error('Failed to respond to invite');
    }
  };

  if (isLoading || invites.length === 0) return null;

  return (
    <div className="border-b border-sidebar-border mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full cursor-pointer flex items-center justify-between px-4 py-2 hover:bg-sidebar-accent transition-colors"
      >
        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          Group Invites
        </div>
        <div className="flex items-center gap-2">
          <div className="shrink-0 w-5 h-5 rounded-full bg-primary/80 text-primary-foreground text-xs font-bold font-mono flex items-center justify-center">
            {invites.length}
          </div>
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isExpanded ? '' : '-rotate-90'}`}
          />
        </div>
      </button>

      <div
        className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-96' : 'max-h-0'}`}
      >
        {invites.map(invite => (
          <GroupInviteItem
            key={invite.groupId}
            invite={invite}
            onRespond={handleRespond}
          />
        ))}
      </div>
    </div>
  );
};
