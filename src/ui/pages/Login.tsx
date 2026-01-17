import { useState, useEffect } from "react";
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
    const [rememberMe, setRememberMe] = useState(true)

    useEffect(() => {
        const unsubscribe = window.kiyeovoAPI.onPasswordRequest((request) => {
            setPasswordRequest(request);
            setPassword('');
            setConfirmPassword('');
            setIsSubmitting(false);
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
            isSubmitting={isSubmitting} />
            : <div>{initStatus}</div>}
    </div>
}