import { useEffect, useState, type FC } from "react";
import { Logo } from "../../icons/Logo";
import { Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import ConnectionStatusDialog from "./ConnectionStatusDialog";
import { KiyeovoDialog } from "./KiyeovoDialog";
import { useDispatch, useSelector } from "react-redux";
import { setConnected } from "../../../state/slices/userSlice";
import NewConversationDialog from "./NewConversationDialog";
import { addPendingKeyExchange, setActivePendingKeyExchange } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";

type SidebarHeaderProps = {};

export const SidebarHeader: FC<SidebarHeaderProps> = ({ }) => {
    const [dhtDialogOpen, setDhtDialogOpen] = useState(false);
    const [kiyeovoDialogOpen, setKiyeovoDialogOpen] = useState(false);
    const [isDHTConnected, setIsDHTConnected] = useState<boolean | null>(null);
    const [newConversationDialogOpen, setNewConversationDialogOpen] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const isConnected = useSelector((state: RootState) => state.user.connected);

    const dispatch = useDispatch();

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
        });

        // Listen for key exchange sent event (to close dialog immediately)
        const unsubSent = window.kiyeovoAPI.onKeyExchangeSent((data) => {
            console.log(`[UI] Key exchange sent to ${data.username}, closing dialog...`);
            dispatch(addPendingKeyExchange(data));
            setNewConversationDialogOpen(false);
            dispatch(setActivePendingKeyExchange(data.peerId));
        });

        return () => {
          unsubStatus();
          unsubSent();
        };
      }, [dispatch]);

      useEffect(() => {
        if (isConnected) {
            setIsDHTConnected(true);
        }
      }, [isConnected]);
    

    const handleShowDhtDialog = () => {
        setDhtDialogOpen(true);
    }

    const handleShowKiyeovoDialog = () => {
        setKiyeovoDialogOpen(true);
    }

    const handleShowNewConversationDialog = () => {
        setNewConversationDialogOpen(true);
    }

    return <>
        <div className="w-full p-4 flex">
            <div className="w-full flex items-center justify-between">
                <div className="w-10 h-10 cursor-pointer rounded-full border border-primary/50 flex items-center justify-center glow-border" onClick={handleShowKiyeovoDialog}>
                    <Logo version="2" />
                </div>
                <button
                    onClick={handleShowDhtDialog}
                    className={`flex cursor-pointer items-center gap-2 px-2 py-1 rounded-md transition-colors hover:bg-sidebar-accent group ${isDHTConnected === null ? "text-muted-foreground" : isDHTConnected ? "text-success" : "text-destructive"}`}
                >
                    <span className="font-mono text-xs uppercase tracking-wider">
                        {isDHTConnected === null ? "Connecting..." : isDHTConnected ? "Connected" : "Offline"}
                    </span>
                    <span className={`w-2 h-2 rounded-full mb-0.5 ${isDHTConnected === null ? "bg-muted-foreground" : isDHTConnected ? "bg-success pulse-online" : "bg-destructive"}`} />
                </button>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleShowNewConversationDialog}
                    className="text-sidebar-foreground hover:text-primary bg-secondary/50 border"
                >
                    <Plus className="w-5 h-5" />
                </Button>
            </div>
        </div>
        <ConnectionStatusDialog open={dhtDialogOpen} onOpenChange={setDhtDialogOpen} isConnected={isDHTConnected} />
        <KiyeovoDialog open={kiyeovoDialogOpen} onOpenChange={setKiyeovoDialogOpen} />
        <NewConversationDialog
            open={newConversationDialogOpen}
            onOpenChange={setNewConversationDialogOpen}
            onNewConversation={handleNewConversation}
            backendError={error}
            setError={setError}
        />
    </>
};
