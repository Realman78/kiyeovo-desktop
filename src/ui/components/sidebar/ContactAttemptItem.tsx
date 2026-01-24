import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { setActiveContactAttempt } from "../../state/slices/chatSlice";
import type { RootState } from "../../state/store";

export interface ContactAttempt {
  peerId: string;
  username: string;
  message: string;
  messageBody?: string;
  receivedAt: number;
  expiresAt: number;
}

interface ContactAttemptItemProps {
  attempt: ContactAttempt;
  // onClick: () => void;
  onExpired: (peerId: string) => void;
}

export const ContactAttemptItem = ({ attempt, onExpired }: ContactAttemptItemProps) => {
  const [timeLeft, setTimeLeft] = useState(0);
  const {activeChat, chats} = useSelector((state: RootState) => state.chat);
  const dispatch = useDispatch();

  const handleSelectContactAttempt = () => {
    dispatch(setActiveContactAttempt(attempt.peerId));
  };

  useEffect(() => {
    const updateTimer = () => {
      const remaining = Math.max(0, attempt.expiresAt - Date.now());
      setTimeLeft(remaining);

      if (remaining === 0) {
        onExpired(attempt.peerId);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [attempt.expiresAt, attempt.peerId, onExpired]);

  const minutes = Math.floor(timeLeft / 60000);
  const seconds = Math.floor((timeLeft % 60000) / 1000);
  const isSelected = activeChat?.peerId === attempt.peerId;

  return (
    <div
      onClick={handleSelectContactAttempt}
      className={`flex items-center gap-3 p-3 
        cursor-pointer bg-warning/5 hover:bg-warning/10 transition-colors
        ${isSelected ? 'border-l-2 border-warning bg-warning/10' : ''}
        `}
    >
      <div className="shrink-0">
        <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
          <UserPlus className="w-5 h-5 text-warning" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate text-left">{attempt.username}</div>
        <div className="text-xs text-muted-foreground truncate text-left">
          {attempt.messageBody ? attempt.messageBody : attempt.message}
        </div>
      </div>
      <div className="shrink-0">
        <div className="text-xs text-warning font-mono tabular-nums">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </div>
      </div>
    </div>
  );
};
