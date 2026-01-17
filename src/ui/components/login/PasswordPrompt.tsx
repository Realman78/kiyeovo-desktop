import { useState, useEffect, useRef } from 'react';
import type { PasswordRequest } from '../../types';
import { Input } from '../ui/Input';
import { Eye, EyeOff, Lock, Shield, AlertCircle, CheckCircle, FileKey, Loader2 } from 'lucide-react'
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
import { formatRecoveryPhrase } from '../../utils/general';

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
}

export function PasswordPrompt({ passwordRequest, handleSubmit, password, setPassword, confirmPassword, setConfirmPassword, rememberMe, setRememberMe, isSubmitting }: PasswordPromptProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState<string>('');
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [pendingEvent, setPendingEvent] = useState<React.FormEvent | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);

  const passwordInputRef = useRef<HTMLInputElement>(null);

  const isNewPassword = passwordRequest.isNewPassword ?? false;

  useEffect(() => {
    if (passwordRequest.prefilledPassword && !password) {
      setPassword(passwordRequest.prefilledPassword);
    }
  }, [passwordRequest.prefilledPassword]);

  useEffect(() => {
    if (passwordRequest.cooldownSeconds !== undefined) {
      setCooldownRemaining(passwordRequest.cooldownSeconds);
    }
  }, [passwordRequest.cooldownSeconds]);

  useEffect(() => {
    if (cooldownRemaining <= 0) return;

    const timer = setInterval(() => {
      setCooldownRemaining(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownRemaining]);

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

        {passwordRequest.prefilledPassword ? (
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
              Processing...
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
      </form>

      {/* Recovery Phrase Dialog */}
      <Dialog open={showRecoveryDialog} onOpenChange={setShowRecoveryDialog}>
        <DialogContent className="w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileKey className="w-5 h-5" />
              RECOVERY PHRASE - WRITE THIS DOWN NOW
            </DialogTitle>
            <DialogDescription>
              This phrase can recover your identity if you forget your password. Store it safely!
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {passwordRequest.recoveryPhrase && (
              <>
                {/* Recovery phrase grid */}
                <div className="bg-secondary/50 border border-border rounded-lg p-4 font-mono text-sm">
                  {formatRecoveryPhrase(passwordRequest.recoveryPhrase).map((row, i) => (
                    <div key={i} className="flex gap-4 mb-2">
                      {row.map((item, j) => (
                        <div key={j} className="flex-1 flex items-center gap-2">
                          <span className="text-muted-foreground w-6 text-right">{item.num}.</span>
                          <span className="text-foreground font-medium">{item.word}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Important notes */}
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 space-y-2">
                  <p className="text-warning font-semibold text-sm">IMPORTANT:</p>
                  <ul className="text-xs text-foreground space-y-1 list-disc list-inside">
                    <li>Write these words on paper (DO NOT take a screenshot)</li>
                    <li>Store in a safe place (safe, password manager, etc.)</li>
                    <li>This phrase can recover your identity if you forget your password</li>
                    <li>Keep your database backups safe as well</li>
                  </ul>
                </div>
              </>
            )}
          </DialogBody>

          <DialogFooter>
            <Button onClick={handleRecoveryConfirm} className="w-full">
              <CheckCircle className="w-4 h-4" />
              I wrote it down
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
