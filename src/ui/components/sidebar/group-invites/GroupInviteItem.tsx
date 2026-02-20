import { useState } from "react";
import { Users, Check, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { useExpirationTimer } from "../../../hooks/useExpirationTimer";
import type { FC } from "react";

export interface GroupInvite {
  groupId: string;
  groupName: string;
  inviterPeerId: string;
  inviterUsername: string;
  inviteId: string;
  expiresAt: number;
}

interface GroupInviteItemProps {
  invite: GroupInvite;
  onRespond: (groupId: string, accept: boolean) => void;
}

export const GroupInviteItem: FC<GroupInviteItemProps> = ({ invite, onRespond }) => {
  const [isResponding, setIsResponding] = useState(false);
  const { minutes, seconds } = useExpirationTimer(invite.expiresAt);

  const handleRespond = async (accept: boolean) => {
    setIsResponding(true);
    try {
      onRespond(invite.groupId, accept);
    } finally {
      setIsResponding(false);
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-primary/5 hover:bg-primary/10 transition-colors">
      <div className="shrink-0">
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <Users className="w-5 h-5 text-primary" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate text-left">{invite.groupName}</div>
        <div className="text-xs text-muted-foreground truncate text-left">
          from {invite.inviterUsername}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <span className="text-xs text-muted-foreground font-mono tabular-nums mr-1">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="w-7 h-7 text-green-500 hover:text-green-600 hover:bg-green-500/10"
          disabled={isResponding}
          onClick={() => handleRespond(true)}
          title="Accept"
        >
          <Check className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="w-7 h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
          disabled={isResponding}
          onClick={() => handleRespond(false)}
          title="Reject"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};
