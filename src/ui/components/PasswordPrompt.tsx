import { useState } from 'react';
import type { PasswordRequest } from '../types';
import { Input } from './ui/Input';
import { Eye, EyeOff, Lock, Shield } from 'lucide-react'
import { Button } from './ui/Button';

type PasswordPromptProps = {
  passwordRequest: PasswordRequest;
  handleSubmit: (e: React.FormEvent) => void;
  password: string;
  setPassword: React.Dispatch<React.SetStateAction<string>>;
  confirmPassword: string;
  setConfirmPassword: React.Dispatch<React.SetStateAction<string>>;
  error: string;
  rememberMe: boolean;
  setRememberMe: React.Dispatch<React.SetStateAction<boolean>>;
  initStatus: string;
}

export function PasswordPrompt({ passwordRequest, handleSubmit, password, setPassword, confirmPassword, setConfirmPassword, error, rememberMe, setRememberMe, initStatus }: PasswordPromptProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className='flex flex-col gap-4 justify-center items-center'>
      <div className='flex flex-col gap-2 text-center'>
        <h1 className="text-xl font-mono font-semibold tracking-wide text-foreground">
          {initStatus.includes("Create") ? "NEW IDENTITY" : "UNLOCK IDENTITY"}
        </h1>
        <p className="text-sm text-muted-foreground">
        {initStatus.includes("Create") ? "Create a strong password that will be used to log into your identity" : "Enter password to decrypt identity information"}
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-6 w-96">
        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            placeholder="Enter decryption key..."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            icon={<Lock className="w-4 h-4" />}
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute cursor-pointer right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-input text-primary transition-all"
          />
          <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors leading-relaxed">
            Remember me (only works if you have OS keychain enabled)
          </span>
        </label>

        <Button type="submit" className="w-full" disabled={!password}>
          <Shield className="w-4 h-4" />
          Decrypt & Access
        </Button>
      </form>
    </div>
  );
}
