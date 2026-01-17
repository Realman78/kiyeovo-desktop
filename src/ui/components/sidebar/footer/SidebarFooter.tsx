import type { FC } from "react";
import { RegisterButton } from "./RegisterButton";

export const SidebarFooter: FC = () => {
    return <div className="p-3 border-t border-sidebar-border bg-sidebar-accent/50">
    {/* {isRegistered ? (
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-mono font-medium text-sidebar-foreground truncate">
            {username}
          </p>
          <p className="text-xs text-success font-mono">online</p>
        </div>
        <CyberButton
          variant="ghost"
          size="icon"
          onClick={onSettings}
          className="text-muted-foreground hover:text-foreground"
        >
          <Settings className="w-4 h-4" />
        </CyberButton>
      </div>
    ) : ( */}
    <RegisterButton />
    {/* )} */}
  </div>
};
