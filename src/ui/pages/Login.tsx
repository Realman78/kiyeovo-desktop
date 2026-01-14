import { useState, useEffect, type SetStateAction } from "react";
import type { PasswordRequest } from "../types";
import { PasswordPrompt } from "../components/PasswordPrompt";
import { Lock } from 'lucide-react'

type LoginProps = {
    initStatus: string;
}

export const Login = ({ initStatus }: LoginProps) => {
    const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [isSubmitted, setIsSubmitted] = useState(false)
    const [rememberMe, setRememberMe] = useState(false)

    useEffect(() => {
        const unsubscribe = window.kiyeovoAPI.onPasswordRequest((request) => {
            setPasswordRequest(request);
            setPassword('');
            setConfirmPassword('');
            setError('');
        });

        return unsubscribe;
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!password) {
            setError('Password cannot be empty');
            return;
        }

        if (passwordRequest?.isNewPassword && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        window.kiyeovoAPI.submitPassword(password);
        setIsSubmitted(true)
        setPasswordRequest(null);
        setPassword('');
        setConfirmPassword('');
        setError('');
    };

    return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
        <div className="w-16 h-16 mb-6 rounded-full border border-primary/50 flex items-center justify-center glow-border">
            <Lock className="w-8 h-8 text-primary" />
        </div>
        {!!passwordRequest ? <PasswordPrompt
            passwordRequest={passwordRequest}
            handleSubmit={handleSubmit}
            password={password}
            setPassword={setPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            error={error} rememberMe={rememberMe}
            setRememberMe={setRememberMe} initStatus={initStatus} />
            : <div>{initStatus}</div>}
    </div>
}