import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { Button } from "../../ui/Button";
import { MoreVertical, Shield, UserPlus } from "lucide-react";

type ChatHeaderProps = {
    username: string;
    peerId: string;
}
export const ChatHeader = ({ username, peerId }: ChatHeaderProps) => {
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    return <div className={`h-16 px-6 flex items-center justify-between border-b border-border ${activeChat?.status === 'pending' ? "" : "bg-card/50"}`}>
    <div className="flex items-center gap-3">
      {activeChat?.status === 'pending' ? (
        <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
        <UserPlus className="w-5 h-5 text-warning" />
      </div>
      ) : null}
      <div>
        <h3 className="font-medium text-foreground text-left">{username}</h3>
        <div className="flex items-center gap-1.5">
          <Shield className="w-3 h-3 text-primary" />
          <span className="text-xs text-muted-foreground font-mono">
            {peerId}
          </span>
        </div>
      </div>
    </div>

    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
        <MoreVertical className="w-4 h-4" />
      </Button>
    </div>
  </div>
}
