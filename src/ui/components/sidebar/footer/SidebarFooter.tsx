import { useState, type FC } from "react";
import { RegisterButton } from "./RegisterButton";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { Check, Copy, Settings, User } from "lucide-react";
import { Button } from "../../ui/Button";
import UserDialog from "./UserDialog";
import { setRegistered, setUsername } from "../../../state/slices/userSlice";
import { SettingsDialog } from "./SettingsDialog";
import RegisterDialog from "./RegisterDialog";

type SidebarFooterProps = {
  collapsed?: boolean;
};

export const SidebarFooter: FC<SidebarFooterProps> = ({ collapsed = false }) => {
  const user = useSelector((state: RootState) => state.user);
  const [isCopied, setIsCopied] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);
  const [isUpdatingUsername, setIsUpdatingUsername] = useState(false);
  const [updateUsernameError, setUpdateUsernameError] = useState<string | undefined>(undefined);
  const [isRegisteringIdentity, setIsRegisteringIdentity] = useState(false);
  const [registerIdentityError, setRegisterIdentityError] = useState<string | undefined>(undefined);
  const [pendingRegisterUsername, setPendingRegisterUsername] = useState("");
  const dispatch = useDispatch();

  const handleSettings = () => {
    setSettingsDialogOpen(true);
  }

  const handleCopyPeerId = () => {
    setIsCopied(true);
    navigator.clipboard.writeText(user.peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  const handleUsernameChange = async (username: string) => {
    setIsUpdatingUsername(true);
    setUpdateUsernameError(undefined);

    try {
        const result = await window.kiyeovoAPI.register(username, false);
        if (result.success) {
            console.log(`Successfully registered username: ${username}`);
            setUserDialogOpen(false);
            setUpdateUsernameError(undefined);
            dispatch(setUsername(username));
            dispatch(setRegistered(true));
        } else {
            setUpdateUsernameError(result.error || 'Failed to register username');
        }
    } catch (err) {
        console.error('Registration error:', err);
        setUpdateUsernameError(err instanceof Error ? err.message : 'Unexpected error occurred');
    } finally {
        setIsUpdatingUsername(false);
    }
  };

  const handleRegisterIdentity = async (username: string, rememberMe: boolean) => {
    setIsRegisteringIdentity(true);
    setRegisterIdentityError(undefined);
    setPendingRegisterUsername(username);

    try {
      const result = await window.kiyeovoAPI.register(username, rememberMe);
      if (result.success) {
        dispatch(setUsername(username));
        dispatch(setRegistered(true));
        setRegisterIdentityError(undefined);
        setRegisterDialogOpen(false);
      } else {
        setRegisterIdentityError(result.error || 'Failed to register username');
      }
    } catch (err) {
      console.error('Registration error:', err);
      setRegisterIdentityError(err instanceof Error ? err.message : 'Unexpected error occurred');
    } finally {
      setIsRegisteringIdentity(false);
    }
  };

  return <div className={`flex border-t border-sidebar-border bg-sidebar-accent/50 ${collapsed ? "h-24 p-2" : "h-20 p-3"}`}>
    <div className={`flex w-full ${collapsed ? "flex-col items-center justify-between" : "items-center gap-3"}`}>
      {collapsed ? (
        <>
          {user.registered ? (
            <div className="relative">
              <div className="w-9 h-9 cursor-pointer rounded-full bg-secondary flex items-center justify-center" onClick={() => setUserDialogOpen(true)}>
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
            </div>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={isRegisteringIdentity}
              pendingUsername={pendingRegisterUsername}
              collapsed
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSettings}
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </>
      ) : (
        <>
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
            </>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={isRegisteringIdentity}
              pendingUsername={pendingRegisterUsername}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSettings}
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
    <UserDialog
      open={userDialogOpen}
      onOpenChange={setUserDialogOpen}
      onRegister={handleUsernameChange}
      isRegistering={isUpdatingUsername}
      backendError={updateUsernameError}
    />
    <RegisterDialog
      open={registerDialogOpen}
      onOpenChange={setRegisterDialogOpen}
      onRegister={handleRegisterIdentity}
      backendError={registerIdentityError}
      isRegistering={isRegisteringIdentity}
      initialUsername={pendingRegisterUsername}
    />
    <SettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
  </div>
};
