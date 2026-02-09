import { useState, useEffect, useRef } from "react";
import type { PasswordRequest } from "../types";
import { PasswordPrompt } from "../components/login/PasswordPrompt";
import { Logo } from "../components/icons/Logo";

type LoginProps = {
    initStatus: string;
}

export const Login = ({ initStatus }: LoginProps) => {
    const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [rememberMe, setRememberMe] = useState(false)
    const previousPasswordRequestRef = useRef<PasswordRequest | null>(null);

    useEffect(() => {
        const restorePendingPasswordRequest = async () => {
            try {
                const initState = await window.kiyeovoAPI.getInitState();
                if (initState.pendingPasswordRequest) {
                    setPasswordRequest(initState.pendingPasswordRequest);
                    setIsSubmitting(false);
                }
            } catch {
                // ignore and rely on live password events
            }
        };
        void restorePendingPasswordRequest();

        const unsubscribe = window.kiyeovoAPI.onPasswordRequest((request) => {
            const previousRequest = previousPasswordRequestRef.current;
            const modeChanged = previousRequest?.isNewPassword !== request.isNewPassword;
            const isRetryWithError = Boolean(request.errorMessage);

            // Keep typed password on failed retries; reset only on fresh flow/mode changes.
            if (!isRetryWithError || modeChanged) {
                setPassword('');
                setConfirmPassword('');
            }
            setPasswordRequest(request);
            setIsSubmitting(false);
            previousPasswordRequestRef.current = request;
        });

        return unsubscribe;
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        setIsSubmitting(true);
        window.kiyeovoAPI.submitPassword(password, rememberMe);
    };

    return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
        <div className="w-16 h-16 mb-6 rounded-full border border-primary/50 flex items-center justify-center glow-border">
            <Logo version="2" />
        </div>
        {!!passwordRequest ? <PasswordPrompt
            passwordRequest={passwordRequest}
            handleSubmit={handleSubmit}
            password={password}
            setPassword={setPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            rememberMe={rememberMe}
            setRememberMe={setRememberMe}
            isSubmitting={isSubmitting}
            initStatus={initStatus} />
            : <div>{initStatus}</div>}
    </div>
}
