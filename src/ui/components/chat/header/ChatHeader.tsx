import { useState, useEffect } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "../../../state/store";
import { Button } from "../../ui/Button";
import { Bell, BellOff, MoreVertical, Shield, UserPlus, Ban, UserCheck, Info, Trash2, AlertCircle, Users, Clock } from "lucide-react";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";
import { updateChat, clearMessages, removeChat } from "../../../state/slices/chatSlice";
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

type ChatHeaderProps = {
  username: string;
  peerId: string;
  chatType?: 'direct' | 'group';
  groupStatus?: string;
  chatId?: number;
}
export const ChatHeader = ({ username, peerId, chatType, groupStatus, chatId }: ChatHeaderProps) => {
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const dispatch = useDispatch();
  const { toast } = useToast();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteChatAndUserConfirmOpen, setDeleteChatAndUserConfirmOpen] = useState(false);
  const [editUsernameModalOpen, setEditUsernameModalOpen] = useState(false);
  const [newUsername, setNewUsername] = useState(username);
  const [validationError, setValidationError] = useState("");
  const [groupMembers, setGroupMembers] = useState<Array<{ peerId: string; username: string; status: 'pending' | 'accepted' | 'confirmed' }>>([]);

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

  const handleEditUsername = () => {
    setEditUsernameModalOpen(true);
    setDropdownOpen(false);
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

  const isGroup = chatType === 'group';
  const isGroupPending = isGroup && groupStatus !== 'active';

  const memberSummary = groupMembers.length > 0
    ? groupMembers.map(m => m.status === 'pending' ? `${m.username} (invited)` : m.username).join(', ')
    : 'No members yet';

  return <div className={`${isGroupPending ? 'h-20' : 'h-16'} px-6 flex items-center justify-between border-b border-border ${activeChat?.status === 'pending' ? "" : "bg-card/50"}`}>
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
        <h3 className="font-medium text-foreground text-left">{username}</h3>
        {isGroup ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground truncate max-w-xs text-left" title={memberSummary}>
              {memberSummary}
            </span>
            {isGroupPending && (
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-warning" />
                <span className="text-xs text-warning">Waiting for members to accept invites...</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Shield className="w-3 h-3 text-primary" />
            <span className="text-xs text-muted-foreground font-mono">
              {peerId}
            </span>
          </div>
        )}
      </div>
    </div>

    <div className="flex items-center gap-1">
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
              onClick={() => setDropdownOpen(false)}
            >
              About group
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={activeChat?.muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              onClick={handleToggleMute}
            >
              {activeChat?.muted ? 'Enable notifications' : 'Disable notifications'}
            </DropdownMenuItem>
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
                  <p className="font-semibold mb-1">Warning: Offline messages will not work</p>
                  <p className="text-xs">
                    In case you make contact with <span className="font-semibold">{username}</span> again, you <span className="font-semibold">will not receive offline messages</span> from this user until they also delete and re-initiate contact with you.
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
                {isDeleting ? 'Deleting...' : 'Delete Chat & User'}
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
