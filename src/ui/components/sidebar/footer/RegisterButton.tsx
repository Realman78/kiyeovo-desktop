import { UserPlus } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import RegisterDialog from "./RegisterDialog";
import { useDispatch } from "react-redux";
import { setRegistered, setUsername } from "../../../state/slices/userSlice";

export const RegisterButton: FC = () => {
    const [showDialog, setShowDialog] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [isRegistering, setIsRegistering] = useState(false);
    const dispatch = useDispatch();

    const handleShowDialog = () => {
        setShowDialog(true);
        setError(undefined); // Clear previous errors when opening dialog
    }

    const handleRegister = async (username: string, rememberMe: boolean) => {
        setIsRegistering(true);
        setError(undefined);

        try {
            const result = await window.kiyeovoAPI.register(username, rememberMe);
            if (result.success) {
                console.log(`Successfully registered username: ${username}`);
                setShowDialog(false);
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

    return <>
            <button
                onClick={handleShowDialog}
                className="w-full cursor-pointer flex items-center gap-3 p-2 rounded-md bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors group"
            >
                <div className="w-9 h-9 rounded-full border border-primary/50 flex items-center justify-center group-hover:border-primary transition-colors">
                    <UserPlus className="w-4 h-4 text-primary" />
                </div>
                <div className="text-left">
                    <p className="text-sm font-mono font-medium text-primary">
                        Register Identity
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Register with a unique username
                    </p>
                </div>
            </button>
        <RegisterDialog
            open={showDialog}
            onOpenChange={setShowDialog}
            onRegister={handleRegister}
            backendError={error}
            isRegistering={isRegistering}
        />
    </>
}
