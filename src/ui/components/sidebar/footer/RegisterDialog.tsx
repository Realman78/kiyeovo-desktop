import { useState } from "react";
import { UserPlus, AtSign, Shield, AlertCircle } from "lucide-react";
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


interface RegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegister: (username: string) => void;
}

const RegisterDialog = ({ open, onOpenChange, onRegister }: RegisterDialogProps) => {
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateUsername(username);
    if (validationError) {
      setError(validationError);
      return;
    }
    onRegister(username);
    setUsername("");
    setError("");
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(e.target.value);
    if (error) setError("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Register Identity</DialogTitle>
              <DialogDescription>
                Create a unique username
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Username
              </label>
              <Input
                placeholder="Enter username..."
                value={username}
                onChange={handleChange}
                icon={<AtSign className="w-4 h-4" />}
                autoFocus
              />
              {error && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>{error}</span>
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!username}>
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RegisterDialog;
