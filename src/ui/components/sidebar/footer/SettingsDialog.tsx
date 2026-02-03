import { type FC, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Bell, BellOff } from "lucide-react";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  useEffect(() => {
    // Listen for notifications setting changes
    const unsubscribe = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled: boolean) => {
      console.log(`[SettingsDialog] Notifications enabled changed to: ${enabled}`);
      setNotificationsEnabled(enabled);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const result = await window.kiyeovoAPI.getNotificationsEnabled();
      if (result.success) {
        setNotificationsEnabled(result.enabled);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleNotifications = async () => {
    const newValue = !notificationsEnabled;
    setNotificationsEnabled(newValue);

    try {
      const result = await window.kiyeovoAPI.setNotificationsEnabled(newValue);
      if (!result.success) {
        // Revert on failure
        setNotificationsEnabled(!newValue);
        console.error("Failed to update notifications setting:", result.error);
      }
    } catch (error) {
      // Revert on failure
      setNotificationsEnabled(!newValue);
      console.error("Failed to update notifications setting:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading settings...</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 border border-border rounded-lg transition-colors">
                <div className="flex items-center gap-3">
                  {notificationsEnabled ? (
                    <Bell className="w-5 h-5 text-primary" />
                  ) : (
                    <BellOff className="w-5 h-5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Notifications & Sounds
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {notificationsEnabled
                        ? "Enabled for all chats"
                        : "Disabled for all chats"}
                    </p>
                  </div>
                </div>
                <Button
                  variant={notificationsEnabled ? "default" : "outline"}
                  size="sm"
                  onClick={handleToggleNotifications}
                >
                  {notificationsEnabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
