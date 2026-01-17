import type { FC } from "react";
import { Logo } from "../icons/Logo";
import { Plus } from "lucide-react";
import { Button } from "../ui/Button";
type SidebarHeaderProps = {};

export const SidebarHeader: FC<SidebarHeaderProps> = ({ }) => {
    return <div className="w-full h-36 p-4 border-b border-sidebar-border flex flex-col">
        <div className="w-full flex items-center justify-between">
            <Logo version="2" />
            <Button
                variant="ghost"
                size="icon"
                // onClick={onNewChat}
                className="text-sidebar-foreground hover:text-primary"
            >
                <Plus className="w-5 h-5" />
            </Button>
        </div>
    </div>;
};
