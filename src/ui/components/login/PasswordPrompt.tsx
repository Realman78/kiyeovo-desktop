import { useState, useEffect, useRef } from 'react';
import type { PasswordRequest } from '../../types';
import { Input } from '../ui/Input';
import { Eye, EyeOff, Lock, Shield, AlertCircle, CheckCircle, FileKey, Loader2, Database, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../ui/Dialog';
import { RecoveryPhraseDisplayDialog } from './RecoveryPhraseDisplayDialog';

export interface PasswordValidationResult {
  valid: boolean;
  message?: string;
}

export function validatePasswordStrength(password: string): PasswordValidationResult {
  if (password.length < 12) {
    return {
      valid: false,
      message: 'Password must be at least 12 characters long'
    };
  }

  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const diversity = [hasLowercase, hasUppercase, hasDigit, hasSpecial].filter(Boolean).length;

  if (diversity < 4) {
    return {
      valid: false,
      message: 'Password must contain at least: lowercase, uppercase, numbers, special character'
    };
  }

  return { valid: true };
}

type PasswordPromptProps = {
  passwordRequest: PasswordRequest;
  handleSubmit: (e: React.FormEvent) => void;
  password: string;
  setPassword: React.Dispatch<React.SetStateAction<string>>;
  confirmPassword: string;
  setConfirmPassword: React.Dispatch<React.SetStateAction<string>>;
  rememberMe: boolean;
  setRememberMe: React.Dispatch<React.SetStateAction<boolean>>;
  isSubmitting: boolean;
  initStatus: string;
}

export function PasswordPrompt({
  passwordRequest,
  handleSubmit,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  rememberMe,
  setRememberMe,
  isSubmitting,
  initStatus
}: PasswordPromptProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState<string>('');
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<React.FormEvent | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number | null>(null);
  const [showAlternativeMethods, setShowAlternativeMethods] = useState(false);
  const [showRecoveryPhraseDialog, setShowRecoveryPhraseDialog] = useState(false);
  const [recoveryPhraseInput, setRecoveryPhraseInput] = useState('');
  const [isProcessingRecovery, setIsProcessingRecovery] = useState(false);

  const passwordInputRef = useRef<HTMLInputElement>(null);

  const isNewPassword = passwordRequest.isNewPassword ?? false;

  useEffect(() => {
    if (passwordRequest.prefilledPassword && !password) {
      setPassword(passwordRequest.prefilledPassword);
    }
  }, [passwordRequest.prefilledPassword]);

  useEffect(() => {
    if (isProcessingRecovery) {
      setIsProcessingRecovery(false);
      setShowRecoveryPhraseDialog(false);
      setRecoveryPhraseInput('');
    }
  }, [passwordRequest]);

  useEffect(() => {
    if (passwordRequest.cooldownUntil !== undefined) {
      setCooldownUntilMs(passwordRequest.cooldownUntil);
      return;
    }
    if (passwordRequest.cooldownSeconds !== undefined) {
      setCooldownUntilMs(Date.now() + passwordRequest.cooldownSeconds * 1000);
      return;
    }
    setCooldownUntilMs(null);
  }, [passwordRequest.cooldownSeconds, passwordRequest.cooldownUntil]);

  useEffect(() => {
    if (!cooldownUntilMs) {
      setCooldownRemaining(0);
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000));
      setCooldownRemaining(remaining);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntilMs]);

  useEffect(() => {
    if (isNewPassword && password.length > 0) {
      const validation = validatePasswordStrength(password);
      setValidationError(validation.valid ? '' : validation.message || '');
    } else {
      setValidationError('');
    }
  }, [password, isNewPassword]);

  useEffect(() => {
    if (passwordInputRef.current && !isSubmitting && cooldownRemaining <= 0) {
      passwordInputRef.current.focus();
    }
  }, [isSubmitting, cooldownRemaining]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (passwordRequest.recoveryPhrase) {
      setPendingEvent(e);
      setShowRecoveryDialog(true);
    } else {
      handleSubmit(e);
    }
  };

  const handleRecoveryConfirm = () => {
    setShowRecoveryDialog(false);
    if (pendingEvent) {
      handleSubmit(pendingEvent);
      setPendingEvent(null);
    }
  };

  const formatCooldownTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const isLocked = cooldownRemaining > 0;

  const handleImportBackup = async () => {
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select Database Backup',
        filters: [
          { name: 'Database Files', extensions: ['db'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePath) {
        const restoreResult = await window.kiyeovoAPI.restoreDatabaseFromFile(result.filePath);
        if (!restoreResult.success) {
          console.error('Failed to restore database:', restoreResult.error);
        }
        // App will restart automatically after successful restore
      }
    } catch (error) {
      console.error('Failed to import backup:', error);
    }
  };

  const handleRecoveryPhraseLogin = async () => {
    if (!recoveryPhraseInput.trim()) {
      return;
    }
    setIsProcessingRecovery(true);
    window.kiyeovoAPI.submitPassword(recoveryPhraseInput.trim(), false, true);
  };

  return (
    <div className='flex flex-col gap-4 justify-center items-center'>
      <div className='flex flex-col gap-2 text-center'>
        <h1 className="text-xl font-mono font-semibold tracking-wide text-foreground">
          {isNewPassword ? "NEW IDENTITY" : "UNLOCK IDENTITY"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isNewPassword ? "Create a strong password that will be used to log into your identity" : "Enter password to decrypt identity information"}
        </p>
      </div>
      <form onSubmit={handleFormSubmit} className="space-y-6 w-96">
        {/* Cooldown warning */}
        {isLocked && (
          <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded-lg">
            <AlertCircle className="w-4 h-4 mt-0.5 text-warning shrink-0" />
            <div className="text-sm text-warning text-left">
              <p className="font-semibold">Too many failed attempts</p>
              <p>Please wait {formatCooldownTime(cooldownRemaining)} before trying again</p>
            </div>
          </div>
        )}

        {/* Display error message from backend */}
        {passwordRequest.errorMessage && !isLocked && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
            <AlertCircle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
            <span className="text-sm text-destructive text-left">{passwordRequest.errorMessage}</span>
          </div>
        )}

        <div className="space-y-4">
          <div className="relative">
            <Input
              ref={passwordInputRef}
              type={showPassword ? "text" : "password"}
              placeholder={
                passwordRequest.prefilledPassword
                  ? "Password loaded from keychain"
                  : isNewPassword
                    ? "Enter password..."
                    : "Enter decryption key..."
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              icon={<Lock className="w-4 h-4" />}
              autoFocus
              disabled={isSubmitting || isLocked}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
              disabled={isSubmitting || isLocked}
              className="absolute cursor-pointer right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {isNewPassword && (
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Confirm password..."
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                icon={<Lock className="w-4 h-4" />}
                disabled={isSubmitting || isLocked}
              />
            </div>
          )}
        </div>

        {isNewPassword && password.length > 0 && (
          <div className={`flex items-start mt-[-16px] gap-2 text-xs ${validationError ? 'text-destructive' : 'text-success'}`}>
            {validationError ? (
              <>
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span className='text-left'>{validationError}</span>
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span className='text-left'>Password strength: Strong</span>
              </>
            )}
          </div>
        )}

        {isNewPassword && confirmPassword.length > 0 && password !== confirmPassword && (
          <div className="flex items-start mt-[-16px] gap-2 text-xs text-destructive">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className='text-left'>Passwords do not match</span>
          </div>
        )}

        {passwordRequest.prefilledPassword && !passwordRequest.errorMessage ? (
          <div className="flex items-start gap-3">
            <CheckCircle className="w-4 h-4 mt-0.5 text-success shrink-0" />
            <span className="text-xs text-success leading-relaxed">
              Password loaded from OS keychain
            </span>
          </div>
        ) : passwordRequest.keychainAvailable ? (
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={isSubmitting || isLocked}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-input text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors leading-relaxed">
              Remember me
            </span>
          </label>
        ) : null}

        <Button
          type="submit"
          className="w-full"
          disabled={
            isSubmitting ||
            isLocked ||
            !password ||
            (isNewPassword && !!validationError) ||
            (isNewPassword && password !== confirmPassword)
          }
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {initStatus || 'Processing...'}
            </>
          ) : isLocked ? (
            <>
              <Lock className="w-4 h-4" />
              Locked ({formatCooldownTime(cooldownRemaining)})
            </>
          ) : (
            <>
              <Shield className="w-4 h-4" />
              {isNewPassword ? 'Create Identity' : 'Decrypt & Access'}
            </>
          )}
        </Button>

        <div className="mt-4 pt-4 border-t border-border">
          <button
            type="button"
            onClick={() => setShowAlternativeMethods(!showAlternativeMethods)}
            className="w-fit flex items-center justify-left cursor-pointer gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <span>Alternative methods</span>
            {showAlternativeMethods ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${showAlternativeMethods ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0'
              }`}
          >
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleImportBackup}
                disabled={isSubmitting || isLocked}
              >
                <Database className="w-4 h-4" />
                Import from Backup
              </Button>
              {!isNewPassword && <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setShowRecoveryPhraseDialog(true)}
                disabled={isSubmitting || isLocked}
              >
                <FileKey className="w-4 h-4" />
                Unlock with Recovery Phrase
              </Button>}
            </div>
          </div>
        </div>
      </form>

      <RecoveryPhraseDisplayDialog
        open={showRecoveryDialog}
        onOpenChange={setShowRecoveryDialog}
        recoveryPhrase={passwordRequest.recoveryPhrase}
        onConfirm={handleRecoveryConfirm}
      />

      {/* Recovery Phrase Login Dialog */}
      <Dialog open={showRecoveryPhraseDialog} onOpenChange={setShowRecoveryPhraseDialog}>
        <DialogContent className="w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileKey className="w-5 h-5" />
              Unlock with Recovery Phrase
            </DialogTitle>
            <DialogDescription>
              Enter your 24-word recovery phrase to unlock your identity
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">
                Recovery Phrase
              </label>
              <textarea
                className="w-full min-h-[120px] px-3 py-2 text-sm bg-input border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none font-mono"
                placeholder="Enter your 24-word recovery phrase separated by spaces"
                value={recoveryPhraseInput}
                onChange={(e) => setRecoveryPhraseInput(e.target.value)}
                disabled={isSubmitting || isProcessingRecovery}
                spellCheck="false"
              />
              <div className="text-xs text-muted-foreground">
                {recoveryPhraseInput.trim() ? (
                  <span className={recoveryPhraseInput.trim().split(/\s+/).length === 24 ? 'text-success' : recoveryPhraseInput.trim().split(/\s+/).length < 24 ? 'text-warning' : 'text-destructive'}>
                    {recoveryPhraseInput.trim().split(/\s+/).length} / 24 words
                  </span>
                ) : (
                  <span>0 / 24 words</span>
                )}
              </div>
            </div>

          </DialogBody>

          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowRecoveryPhraseDialog(false);
                setRecoveryPhraseInput('');
              }}
              className="flex-1"
              disabled={isProcessingRecovery}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRecoveryPhraseLogin}
              disabled={!recoveryPhraseInput.trim() || isSubmitting || isProcessingRecovery || recoveryPhraseInput.trim().split(/\s+/).length !== 24}
              className="flex-1"
            >
              {isProcessingRecovery ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  <Shield className="w-4 h-4" />
                  Unlock Identity
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
