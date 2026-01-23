import { useState, useEffect } from "react";
import { UserPlus, AtSign, Shield, AlertCircle, Copy, Check, User } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogBody,
    DialogFooter,
} from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";


interface UserDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRegister: (username: string) => Promise<void>;
    backendError?: string;
    isRegistering?: boolean;
}

const UserDialog = ({ open, onOpenChange, onRegister, backendError, isRegistering }: UserDialogProps) => {
    const [validationError, setValidationError] = useState("");
    const [isCopied, setIsCopied] = useState(false);

    const user = useSelector((state: RootState) => state.user);
    const [newUsername, setNewUsername] = useState(user.username || "");

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

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setNewUsername(e.target.value);
        if (validationError) setValidationError("");
    };

    useEffect(() => {
        if (!open) {
            setNewUsername("");
            setValidationError("");
        }
    }, [open]);

    useEffect(() => {
        console.log("user", user);
        setNewUsername(user.username ?? "");
    }, [open, user.username])

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
                                <p className="text-sm font-medium text-foreground">{user.peerId}</p>
                                <button
                                    type="button"
                                    className="text-sm cursor-pointer text-muted-foreground hover:text-foreground"
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
                            <label className="block text-sm font-medium text-foreground mb-2">
                                Change Username
                            </label>
                            <Input
                                placeholder="Enter new username..."
                                value={newUsername}
                                onChange={handleChange}
                                icon={<AtSign className="w-4 h-4" />}
                                spellCheck={false}
                            />
                            {displayError && (
                                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                                    <AlertCircle className="w-4 h-4" />
                                    <span>{displayError}</span>
                                </div>
                            )}
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
                    </DialogBody>

                    <DialogFooter>
                        <div className="flex flex-1 items-center justify-between">

                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => onOpenChange(false)}
                            >
                                Unregister
                            </Button>
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => onOpenChange(false)}
                                >
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={!newUsername || isRegistering}>
                                    {isRegistering ? 'Changing username...' : 'Change username'}
                                </Button>
                            </div>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default UserDialog;
