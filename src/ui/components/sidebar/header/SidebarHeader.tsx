import { useEffect, useState, type FC } from "react";
import { Logo } from "../../icons/Logo";
import { Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import ConnectionStatusDialog from "./ConnectionStatusDialog";
import { KiyeovoDialog } from "./KiyeovoDialog";
type SidebarHeaderProps = {};

export const SidebarHeader: FC<SidebarHeaderProps> = ({ }) => {
    const [dhtDialogOpen, setDhtDialogOpen] = useState(false);
    const [kiyeovoDialogOpen, setKiyeovoDialogOpen] = useState(false);
    const [isDHTConnected, setIsDHTConnected] = useState<boolean | null>(null);

    useEffect(() => {
        const unsubStatus = window.kiyeovoAPI.onDHTConnectionStatus((status: { connected: boolean }) => {
            console.log('DHT connection status:', status.connected);
          setIsDHTConnected(status.connected);
        });
    
        return () => {
          unsubStatus();
        };
      }, []);
    

    const handleShowDhtDialog = () => {
        setDhtDialogOpen(true);
    }

    const handleShowKiyeovoDialog = () => {
        setKiyeovoDialogOpen(true);
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
                    // onClick={onNewChat}
                    className="text-sidebar-foreground hover:text-primary bg-secondary/50 border"
                >
                    <Plus className="w-5 h-5" />
                </Button>
            </div>
        </div>
        <ConnectionStatusDialog open={dhtDialogOpen} onOpenChange={setDhtDialogOpen} isConnected={isDHTConnected} onConnectionChange={setIsDHTConnected} />
        <KiyeovoDialog open={kiyeovoDialogOpen} onOpenChange={setKiyeovoDialogOpen} />
    </>
};
