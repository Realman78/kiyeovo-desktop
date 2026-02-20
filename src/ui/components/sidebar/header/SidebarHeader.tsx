import { useEffect, useState, useRef, type FC } from "react";
import { Logo } from "../../icons/Logo";
import { Plus, MessageSquarePlus, UserPlus, Users } from "lucide-react";
import { Button } from "../../ui/Button";
import ConnectionStatusDialog from "./ConnectionStatusDialog";
import { KiyeovoDialog } from "./KiyeovoDialog";
import { useDispatch, useSelector } from "react-redux";
import { setConnected, setRegistered, setUsername } from "../../../state/slices/userSlice";
import NewConversationDialog from "./NewConversationDialog";
import ImportTrustedUserDialog from "./ImportTrustedUserDialog";
import NewGroupDialog from "./NewGroupDialog";
import { addPendingKeyExchange, setActivePendingKeyExchange, setActiveChat, addChat, type Chat } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";
import { useToast } from "../../ui/use-toast";

type SidebarHeaderProps = {
    collapsed?: boolean;
};

export const SidebarHeader: FC<SidebarHeaderProps> = ({ collapsed = false }) => {
    const [dhtDialogOpen, setDhtDialogOpen] = useState(false);
    const [kiyeovoDialogOpen, setKiyeovoDialogOpen] = useState(false);
    const [isDHTConnected, setIsDHTConnected] = useState<boolean | null>(null);
    const [newConversationDialogOpen, setNewConversationDialogOpen] = useState(false);
    const [importTrustedUserDialogOpen, setImportTrustedUserDialogOpen] = useState(false);
    const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [isTorEnabled, setIsTorEnabled] = useState<boolean>(false);
    const isConnected = useSelector((state: RootState) => state.user.connected);
    const isRegistered = useSelector((state: RootState) => state.user.registered);

    const dispatch = useDispatch();
    const { toast } = useToast();

    // Ref to track latest newConversationDialogOpen value without recreating listeners
    const newConversationDialogOpenRef = useRef(newConversationDialogOpen);
    const attemptedAutoRegisterRef = useRef(false);

    // Keep ref in sync with state
    useEffect(() => {
        newConversationDialogOpenRef.current = newConversationDialogOpen;
    }, [newConversationDialogOpen]);

    const handleNewConversation = async (peerIdOrUsername: string, message: string) => {
        setError(undefined);

        try {
            const result = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, message);

            if (result.success) {
                setNewConversationDialogOpen(false);
                dispatch(setActivePendingKeyExchange(null));
            } else {
                setError(result.error || 'Failed to send message');
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            setError(err instanceof Error ? err.message : 'Unexpected error occurred');
        }
    }


    useEffect(() => {
        const unsubStatus = window.kiyeovoAPI.onDHTConnectionStatus((status: { connected: boolean }) => {
            console.log('DHT connection status:', status.connected);
            setIsDHTConnected(status.connected);
            dispatch(setConnected(status.connected));
            if (!status.connected) {
                attemptedAutoRegisterRef.current = false;
                return;
            }
            if (status.connected && !isRegistered && !attemptedAutoRegisterRef.current) {
                attemptedAutoRegisterRef.current = true;
                void window.kiyeovoAPI.attemptAutoRegister().then((result) => {
                    if (result.success && result.username) {
                        dispatch(setUsername(result.username));
                        dispatch(setRegistered(true));
                    }
                });
            }
        });

        // Listen for key exchange sent event (to close dialog immediately)
        const unsubSent = window.kiyeovoAPI.onKeyExchangeSent((data) => {
            // this needs to be called only for new conversations, not for existing chats
            console.log(`[UI] Key exchange sent to ${data.username}, newConversationDialogOpen: ${newConversationDialogOpenRef.current}`);
            if (!newConversationDialogOpenRef.current) return;
            console.log(`[UI] Key exchange sent to ${data.username}, closing dialog...`);
            dispatch(addPendingKeyExchange(data));
            setNewConversationDialogOpen(false);
            dispatch(setActivePendingKeyExchange(data.peerId));
        });

        return () => {
            unsubStatus();
            unsubSent();
        };
    }, [dispatch, isRegistered]);

    useEffect(() => {
        if (isConnected) {
            setIsDHTConnected(true);
        }
    }, [isConnected]);

    useEffect(() => {
        // Load Tor settings to display connection mode
        const loadTorSettings = async () => {
            try {
                const result = await window.kiyeovoAPI.getTorSettings();
                if (result.success && result.settings) {
                    setIsTorEnabled(result.settings.enabled === 'true');
                }
            } catch (error) {
                console.error('Failed to load Tor settings:', error);
            }
        };
        void loadTorSettings();
    }, []);


    const handleShowDhtDialog = () => {
        setDhtDialogOpen(true);
    }

    const handleShowKiyeovoDialog = () => {
        setKiyeovoDialogOpen(true);
    }

    const handleShowNewConversationDialog = () => {
        setError(undefined);
        setNewConversationDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleShowImportTrustedUserDialog = () => {
        setImportTrustedUserDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleShowNewGroupDialog = () => {
        setNewGroupDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleGroupCreated = async (groupId: string, chatId: number) => {
        console.log(`Group created: ${groupId}, chat ID: ${chatId}`);

        try {
            const result = await window.kiyeovoAPI.getChatById(chatId);
            if (result.success && result.chat) {
                const chat: Chat = {
                    id: result.chat.id,
                    type: result.chat.type as 'direct' | 'group',
                    name: result.chat.name,
                    lastMessage: '',
                    lastMessageTimestamp: new Date(result.chat.updated_at || result.chat.created_at).getTime(),
                    unreadCount: 0,
                    status: result.chat.status as 'active' | 'pending' | 'awaiting_acceptance',
                    justCreated: true,
                    fetchedOffline: true,
                    isFetchingOffline: false,
                };
                dispatch(addChat(chat));
            }
        } catch (error) {
            console.error('Failed to fetch group chat:', error);
        }

        dispatch(setActiveChat(chatId));
        toast.success("Group invites have been sent.", "Group created");
    }

    const handleImportSuccess = async (chatId: number) => {
        console.log(`Successfully imported trusted user, chat ID: ${chatId}`);

        // Fetch the new chat and add it to the state
        try {
            const result = await window.kiyeovoAPI.getChatById(chatId);
            if (result.success && result.chat) {
                const chat: Chat = {
                    id: result.chat.id,
                    type: result.chat.type as 'direct' | 'group',
                    name: result.chat.username || result.chat.name,
                    peerId: result.chat.other_peer_id,
                    lastMessage: result.chat.last_message_content || '',
                    lastMessageTimestamp: result.chat.last_message_timestamp
                        ? new Date(result.chat.last_message_timestamp).getTime()
                        : new Date(result.chat.updated_at || result.chat.created_at).getTime(),
                    unreadCount: 0,
                    status: result.chat.status as 'active' | 'pending' | 'awaiting_acceptance',
                    username: result.chat.username,
                    trusted_out_of_band: result.chat.trusted_out_of_band,
                    justCreated: true,
                    fetchedOffline: true,
                    isFetchingOffline: false,
                };
                dispatch(addChat(chat));
            }
        } catch (error) {
            console.error('Failed to fetch chat:', error);
        }

        // Navigate to the chat
        dispatch(setActiveChat(chatId));

        // Show success toast
        toast.success("You can now send encrypted messages to this user.", "User imported successfully");
    }

    return <>
        <div className={collapsed ? "w-full p-3 flex flex-col items-center gap-3" : "w-full p-4 flex"}>
            <div className={collapsed ? "flex flex-col items-center gap-3" : "w-full flex items-center justify-between"}>
                <div className="w-10 h-10 cursor-pointer rounded-full border border-primary/50 flex items-center justify-center glow-border" onClick={handleShowKiyeovoDialog}>
                    <Logo version="2" />
                </div>
                {collapsed ? (
                    <button
                        onClick={handleShowDhtDialog}
                        className="flex cursor-pointer items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-sidebar-accent"
                        title={isDHTConnected === null ? "Connecting..." : isDHTConnected ? `Connected (${isTorEnabled ? 'tor' : 'local'})` : "Offline"}
                        aria-label="DHT status"
                    >
                        <span className={`w-2.5 h-2.5 rounded-full ${isDHTConnected === null ? "bg-muted-foreground" : isDHTConnected ? "bg-success pulse-online" : "bg-destructive"}`} />
                    </button>
                ) : (
                    <button
                        onClick={handleShowDhtDialog}
                        className={`flex cursor-pointer items-center gap-2 px-2 py-1 rounded-md transition-colors hover:bg-sidebar-accent group ${isDHTConnected === null ? "text-muted-foreground" : isDHTConnected ? "text-success" : "text-destructive"}`}
                    >
                        <span className="font-mono text-xs uppercase tracking-wider">
                            {isDHTConnected === null ? "Connecting..." : isDHTConnected ? `Connected (${isTorEnabled ? 'tor' : 'local'})` : "Offline"}
                        </span>
                        <span className={`w-2 h-2 rounded-full mb-0.5 ${isDHTConnected === null ? "bg-muted-foreground" : isDHTConnected ? "bg-success pulse-online" : "bg-destructive"}`} />
                    </button>
                )}
                <DropdownMenu
                    open={dropdownOpen}
                    onOpenChange={setDropdownOpen}
                    align={collapsed ? "start" : "end"}
                    trigger={
                        <Button
                            variant="ghost"
                            size="icon"
                            className="text-sidebar-foreground hover:text-primary bg-secondary/50 border"
                        >
                            <Plus className="w-5 h-5" />
                        </Button>
                    }
                >
                    <DropdownMenuItem
                        icon={<MessageSquarePlus className="w-4 h-4" />}
                        onClick={handleShowNewConversationDialog}
                    >
                        New Conversation
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        icon={<UserPlus className="w-4 h-4" />}
                        onClick={handleShowImportTrustedUserDialog}
                    >
                        Import Trusted User
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        icon={<Users className="w-4 h-4" />}
                        onClick={handleShowNewGroupDialog}
                    >
                        New Group
                    </DropdownMenuItem>
                </DropdownMenu>
            </div>
        </div>
        <ConnectionStatusDialog open={dhtDialogOpen} onOpenChange={setDhtDialogOpen} isConnected={isDHTConnected} />
        <KiyeovoDialog open={kiyeovoDialogOpen} onOpenChange={setKiyeovoDialogOpen} />
        <NewConversationDialog
            open={newConversationDialogOpen}
            onOpenChange={(open) => {
                setNewConversationDialogOpen(open);
                if (!open) {
                    setError(undefined);
                }
            }}
            onNewConversation={handleNewConversation}
            backendError={error}
            setError={setError}
        />
        <ImportTrustedUserDialog
            open={importTrustedUserDialogOpen}
            onOpenChange={setImportTrustedUserDialogOpen}
            onSuccess={handleImportSuccess}
        />
        <NewGroupDialog
            open={newGroupDialogOpen}
            onOpenChange={setNewGroupDialogOpen}
            onSuccess={handleGroupCreated}
        />
    </>
};
