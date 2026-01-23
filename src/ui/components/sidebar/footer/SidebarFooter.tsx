import { useState, type FC } from "react";
import { RegisterButton } from "./RegisterButton";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { Check, Copy, Settings, User } from "lucide-react";
import { Button } from "../../ui/Button";
import UserDialog from "./UserDialog";
import { setRegistered, setUsername } from "../../../state/slices/userSlice";

export const SidebarFooter: FC = () => {
  const user = useSelector((state: RootState) => state.user);
  const [isCopied, setIsCopied] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const dispatch = useDispatch();
  const handleSettings = () => {
    console.log("settings");
  }

  const handleCopyPeerId = () => {
    setIsCopied(true);
    navigator.clipboard.writeText(user.peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  const handleUsernameChange = async (username: string) => {
    setIsRegistering(true);
    setError(undefined);

    try {
        const result = await window.kiyeovoAPI.register(username);
        if (result.success) {
            console.log(`Successfully registered username: ${username}`);
            setUserDialogOpen(false);
            setError(undefined);
            dispatch(setUsername(username));
            dispatch(setRegistered(true));
        } else {
            setError(result.error || 'Failed to register username');
        }
    } catch (err) {
        console.error('Registration error:', err);
        setError(err instanceof Error ? err.message : 'Unexpected error occurred');
    } finally {
        setIsRegistering(false);
    }
  }

  return <div className="p-3 border-t border-sidebar-border bg-sidebar-accent/50">
    <div className="flex items-center gap-3">
      {user.registered ? (
        <>
          <div className="relative">
            <div className="w-9 h-9 cursor-pointer rounded-full bg-secondary flex items-center justify-center" onClick={() => setUserDialogOpen(true)}>
              <User className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-mono font-medium text-sidebar-foreground truncate text-left">
              {user.username}
            </p>
            <div className="flex items-center gap-1">
              <p className="text-xs text-success font-mono text-left truncate cursor-pointer" onClick={handleCopyPeerId}>{user.peerId}</p>
              <button
                type="button"
                className="text-xs cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={handleCopyPeerId}
              >
                {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>
          <UserDialog open={userDialogOpen} onOpenChange={setUserDialogOpen} onRegister={handleUsernameChange} isRegistering={isRegistering} backendError={error} />
        </>
      ) : (
        <RegisterButton />
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleSettings}
        className="text-muted-foreground hover:text-foreground"
      >
        <Settings className="w-4 h-4" />
      </Button>
    </div>
  </div>
};
