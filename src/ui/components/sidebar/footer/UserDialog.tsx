import { useState, useEffect } from "react";
import { AtSign, Shield, AlertCircle, Copy, Check, User, Edit2, X } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogBody,
    DialogFooter,
} from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { useToast } from "../../ui/use-toast";
import { setRegistered, setUsername } from "../../../state/slices/userSlice";


interface UserDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRegister: (username: string) => Promise<void>;
    backendError?: string;
    isRegistering?: boolean;
}

const UserDialog = ({ open, onOpenChange, onRegister, backendError, isRegistering }: UserDialogProps) => {
    const [validationError, setValidationError] = useState("");
    const [unregisterError, setUnregisterError] = useState("");
    const [isCopied, setIsCopied] = useState(false);
    const [isEditingUsername, setIsEditingUsername] = useState(false);
    const [autoRegister, setAutoRegister] = useState(false);
    const { toast } = useToast();
    const user = useSelector((state: RootState) => state.user);
    const [newUsername, setNewUsername] = useState(user.username || "");
    const dispatch = useDispatch();
    
    const validateUsername = (value: string) => {
        if (value.length < 3) {
            return "Username must be at least 3 characters";
        }
        if (value.length > 20) {
            return "Username must be less than 20 characters";
        }
        if (!/^[a-zA-Z0-9_]+$/.test(value)) {
            return "Only letters, numbers, and underscores allowed";
        }
        return "";
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const error = validateUsername(newUsername);
        if (error) {
            setValidationError(error);
            return;
        }
        await onRegister(newUsername);
    };

    const handleUnregister = async () => {
        if (!user.username) {
            setUnregisterError("Username not found");
            return;
        }
        const result = await window.kiyeovoAPI.unregister(user.username);
        if (result.usernameUnregistered && result.peerIdUnregistered) {
            onOpenChange(false);
            toast.info("Username and peer ID unregistered successfully");
        } else if (result.usernameUnregistered) {
            toast.info("Username unregistered successfully. Peer ID is still registered");
        } else if (result.peerIdUnregistered) {
            toast.info("Peer ID unregistered successfully. Username is still registered");
        } else {
            setUnregisterError("Failed to unregister username and peer ID");
        }

        if (result.usernameUnregistered || result.peerIdUnregistered) {
            dispatch(setUsername(""));
            dispatch(setRegistered(false));
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setNewUsername(e.target.value);
        if (validationError) setValidationError("");
    };

    useEffect(() => {
        if (!open) {
            setNewUsername("");
            setValidationError("");
            setIsEditingUsername(false);
        } else {
            // Load auto-register setting when dialog opens
            const loadAutoRegister = async () => {
                const result = await window.kiyeovoAPI.getAutoRegister();
                setAutoRegister(result.autoRegister);
            };
            loadAutoRegister();
        }
    }, [open]);

    useEffect(() => {
        console.log("user", user);
        setNewUsername(user.username ?? "");
    }, [open, user.username])

    const handleAutoRegisterToggle = async (enabled: boolean) => {
        setAutoRegister(enabled);
        await window.kiyeovoAPI.setAutoRegister(enabled);
    };

    const displayError = backendError || validationError;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
                            <User className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <DialogTitle>{user.username}</DialogTitle>
                            {/* <DialogDescription>
                Create a unique username
              </DialogDescription> */}
                        </div>
                    </div>
                </DialogHeader>

                <form onSubmit={handleSubmit}>
                    <DialogBody className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold text-foreground mb-2">
                                Peer ID
                            </label>
                            <div className="flex items-center gap-3">
                                <p className="text-sm font-medium text-foreground break-all">{user.peerId}</p>
                                <button
                                    type="button"
                                    className="text-sm cursor-pointer text-muted-foreground hover:text-foreground shrink-0"
                                    onClick={() => {
                                        setIsCopied(true);
                                        navigator.clipboard.writeText(user.peerId);
                                        setTimeout(() => {
                                            setIsCopied(false);
                                        }, 2000);
                                    }}
                                >
                                    {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-foreground mb-2">
                                Username
                            </label>
                            <div className="flex items-center gap-3">
                                <p className="text-sm font-medium text-foreground">{user.username}</p>
                                {!isEditingUsername && (
                                    <button
                                        type="button"
                                        onClick={() => setIsEditingUsername(true)}
                                        className="text-sm cursor-pointer text-primary hover:text-primary/80 flex items-center gap-1"
                                    >
                                        <Edit2 className="w-3 h-3" />
                                        <span>Change</span>
                                    </button>
                                )}
                            </div>
                            
                            {isEditingUsername && (
                                <div className="mt-3 space-y-2">
                                    <Input
                                        placeholder="Enter new username..."
                                        value={newUsername}
                                        onChange={handleChange}
                                        icon={<AtSign className="w-4 h-4" />}
                                        spellCheck={false}
                                        autoFocus
                                    />
                                    {displayError && (
                                        <div className="flex items-center gap-2 text-destructive text-sm">
                                            <AlertCircle className="w-4 h-4" />
                                            <span>{displayError}</span>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                setIsEditingUsername(false);
                                                setNewUsername(user.username || "");
                                                setValidationError("");
                                            }}
                                        >
                                            <X className="w-3 h-3 mr-1" />
                                            Cancel
                                        </Button>
                                        <Button
                                            type="submit"
                                            size="sm"
                                            disabled={!newUsername || isRegistering || newUsername === user.username}
                                        >
                                            {isRegistering ? 'Saving...' : 'Save'}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="pt-2 pb-2 border-t border-b border-border">
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="block text-sm font-medium text-foreground mb-1">
                                        Auto-register username
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                        Automatically restore your username when the app starts
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleAutoRegisterToggle(!autoRegister)}
                                    className={`relative cursor-pointer inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                        autoRegister ? 'bg-primary' : 'bg-input'
                                    } ${autoRegister ? 'hover:bg-primary/80' : 'hover:bg-input/80'}`}
                                >
                                    <span
                                        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                                            autoRegister ? 'translate-x-6' : 'translate-x-1'
                                        }`}
                                    />
                                </button>
                            </div>
                        </div>

                        <div className="p-3 rounded-md bg-secondary/50 border border-border">
                            <div className="flex items-start gap-2">
                                <Shield size={55} className="text-primary h-fit mt-0.5" />
                                <div className="text-s text-muted-foreground">
                                    <p className="font-medium text-foreground mb-1">IMPORTANT NOTICE</p>
                                    <p className="text-sm">
                                        The username is stored on the DHT network and is used for
                                        other users to find you. The recommendation is to not use usernames
                                        as they can be overwritten by anyone. Use Peer IDs or Trusted Contacts instead.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {!!unregisterError && (
                            <div className="flex items-center gap-2 text-destructive text-sm">
                                <AlertCircle className="w-4 h-4" />
                                <span>{unregisterError}</span>
                            </div>
                        )}
                    </DialogBody>

                    <DialogFooter>
                        <div className="flex flex-1 items-center justify-between">
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => handleUnregister()}
                            >
                                Unregister
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                Close
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default UserDialog;
