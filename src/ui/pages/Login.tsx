import { useState, useEffect, useRef } from "react";
import type { PasswordRequest } from "../types";
import { PasswordPrompt } from "../components/login/PasswordPrompt";
import { Logo } from "../components/icons/Logo";
import { DEFAULT_NETWORK_MODE, NETWORK_MODES } from "../../core/constants";
import type { NetworkMode } from "../../core/types";
import { NetworkModeSelector } from "../components/login/NetworkModeSelector";

type LoginProps = {
    initStatus: string;
}

export const Login = ({ initStatus }: LoginProps) => {
    const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [rememberMe, setRememberMe] = useState(false)
    const [networkMode, setNetworkMode] = useState<NetworkMode>(DEFAULT_NETWORK_MODE);
    const [isModeLoading, setIsModeLoading] = useState(true);
    const [isModeSaving, setIsModeSaving] = useState(false);
    const [modeError, setModeError] = useState<string | null>(null);
    const [isSwitchingMode, setIsSwitchingMode] = useState(false);
    const [requiresNetworkModeSelection, setRequiresNetworkModeSelection] = useState(false);
    const previousPasswordRequestRef = useRef<PasswordRequest | null>(null);

    useEffect(() => {
        let isMounted = true;

        const loadNetworkMode = async () => {
            try {
                const result = await window.kiyeovoAPI.getNetworkMode();
                if (!isMounted) return;
                if (result.success) {
                    setNetworkMode(result.mode);
                    setModeError(null);
                } else {
                    setModeError(result.error || 'Failed to load network mode');
                }
            } catch (error) {
                if (!isMounted) return;
                setModeError(error instanceof Error ? error.message : 'Failed to load network mode');
            } finally {
                if (isMounted) {
                    setIsModeLoading(false);
                }
            }
        };

        const restorePendingPasswordRequest = async () => {
            try {
                const initState = await window.kiyeovoAPI.getInitState();
                if (!isMounted) return;
                setRequiresNetworkModeSelection(Boolean(initState.requiresNetworkModeSelection));
                if (initState.pendingPasswordRequest) {
                    setPasswordRequest(initState.pendingPasswordRequest);
                    setIsSubmitting(false);
                }
            } catch {
                // ignore and rely on live password events
            }
        };
        void loadNetworkMode();
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

        return () => {
            isMounted = false;
            unsubscribe();
        };
    }, []);

    const handleNetworkModeChange = async (nextMode: NetworkMode) => {
        if (isModeSaving) {
            return;
        }
        if (!requiresNetworkModeSelection && nextMode === networkMode) {
            return;
        }

        const previousMode = networkMode;
        setNetworkMode(nextMode);
        setIsModeSaving(true);
        setModeError(null);

        try {
            const result = await window.kiyeovoAPI.setNetworkMode(nextMode);
            if (!result.success) {
                setNetworkMode(previousMode);
                setModeError(result.error || 'Failed to save network mode');
                return;
            }

            if (requiresNetworkModeSelection) {
                const initResult = await window.kiyeovoAPI.startInitialization();
                if (!initResult.success) {
                    setModeError(initResult.error || 'Failed to start initialization');
                    setNetworkMode(previousMode);
                    return;
                }
                setRequiresNetworkModeSelection(false);
            }
        } catch (error) {
            setNetworkMode(previousMode);
            setModeError(error instanceof Error ? error.message : 'Failed to save network mode');
        } finally {
            setIsModeSaving(false);
        }
    };

    const handleSwitchNetworkMode = async (targetMode: NetworkMode): Promise<void> => {
        if (isSwitchingMode) return;

        setIsSwitchingMode(true);
        setModeError(null);
        try {
            const setResult = await window.kiyeovoAPI.setNetworkMode(targetMode);
            if (!setResult.success) {
                setModeError(setResult.error || 'Failed to switch network mode');
                setIsSwitchingMode(false);
                return;
            }
            setNetworkMode(targetMode);
            await window.kiyeovoAPI.restartApp();
        } catch (error) {
            setModeError(error instanceof Error ? error.message : 'Failed to switch network mode');
            setIsSwitchingMode(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        setIsSubmitting(true);
        window.kiyeovoAPI.submitPassword(password, rememberMe);
    };

    if (requiresNetworkModeSelection) {
        return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
            <div className={`w-16 h-16 mb-6 rounded-full border ${networkMode === NETWORK_MODES.ANONYMOUS ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"} flex items-center justify-center`}>
                <Logo version="2" _isTorActive={networkMode === NETWORK_MODES.ANONYMOUS} />
            </div>
            <div className="text-center w-3/4">
                <h1 className="text-xl font-mono font-semibold tracking-wide text-foreground">Choose Network Mode</h1>
                <p className="text-sm text-muted-foreground">Select how Kiyeovo should connect before unlocking your identity.</p>
            </div>
            <div className="flex justify-center flex-col items-center mt-6">
                <NetworkModeSelector
                    loading={isModeLoading}
                    saving={isModeSaving}
                    error={modeError}
                    onChange={handleNetworkModeChange}
                />
                <div className="mt-2 text-center w-114">
                    <p className="text-xs text-muted-foreground">*Privacy notice: Fast and Anonymous modes currently share the same identity. If you use both modes, someone who knows your identity in one mode could link it to the other. For maximum privacy, use only Anonymous mode.</p>
                </div>
            </div>
            <div className="text-xs text-muted-foreground">
                {isModeSaving ? `Applying ${networkMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast'} mode...` : ''}
            </div>
        </div>;
    }

    return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
        <div className={`w-16 h-16 mb-6 rounded-full border ${networkMode === NETWORK_MODES.ANONYMOUS ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"} flex items-center justify-center`}>
            <Logo version="2" _isTorActive={networkMode === NETWORK_MODES.ANONYMOUS}/>
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
            initStatus={initStatus}
            networkMode={networkMode}
            onSwitchNetworkMode={handleSwitchNetworkMode}
            isSwitchingNetworkMode={isSwitchingMode}
            modeSwitchError={modeError}
        />
            : <div>{initStatus}</div>}
    </div>
}
