import { useState, type FC } from "react";
import { Logo } from "../icons/Logo";
import { Plus, Search } from "lucide-react";
import { Button } from "../ui/Button";
import { KiyeovoDialog } from "./KiyeovoDialog";
import { Input } from "../ui/Input";
type SidebarHeaderProps = {};

export const SidebarHeader: FC<SidebarHeaderProps> = ({ }) => {
    const [showDialog, setShowDialog] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");

    const handleShowDialog = () => {
        setShowDialog(true);
    }

    return <>
        <div className="w-full h-36 p-4 border-b border-sidebar-border flex flex-col gap-5">
            <div className="w-full flex items-center justify-between">
                <div
                    className="w-11 h-11 cursor-pointer rounded-full border border-primary/50 flex items-center justify-center glow-border"
                    onClick={handleShowDialog}
                    >
                    <Logo version="2" />
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    // onClick={onNewChat}
                    className="text-sidebar-foreground hover:text-primary bg-secondary/50 border"
                >
                    <Plus className="w-5 h-5" />
                </Button>
            </div>
            <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                icon={<Search className="w-4 h-4" />}
                className="bg-sidebar-accent border-sidebar-border"
                />
        </div>
        <KiyeovoDialog open={showDialog} onOpenChange={setShowDialog} />
    </>
};
