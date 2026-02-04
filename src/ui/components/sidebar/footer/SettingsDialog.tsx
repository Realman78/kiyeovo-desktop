import { type FC, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Bell, BellOff, FolderOpen } from "lucide-react";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [downloadsDir, setDownloadsDir] = useState<string>('');
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
      const [notifResult, downloadsDirResult] = await Promise.all([
        window.kiyeovoAPI.getNotificationsEnabled(),
        window.kiyeovoAPI.getDownloadsDir()
      ]);

      if (notifResult.success) {
        setNotificationsEnabled(notifResult.enabled);
      }

      if (downloadsDirResult.success && downloadsDirResult.path) {
        setDownloadsDir(downloadsDirResult.path);
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

  const handleChangeDownloadsDir = async () => {
    try {
      const result = await window.kiyeovoAPI.showSaveDialog({
        title: 'Select Downloads Directory',
        defaultPath: downloadsDir
      });

      if (!result.canceled && result.filePath) {
        const setResult = await window.kiyeovoAPI.setDownloadsDir(result.filePath);
        if (setResult.success) {
          setDownloadsDir(result.filePath);
        } else {
          console.error("Failed to update downloads directory:", setResult.error);
        }
      }
    } catch (error) {
      console.error("Failed to change downloads directory:", error);
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

              <div className="flex items-center justify-between p-3 border border-border rounded-lg transition-colors">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FolderOpen className="w-5 h-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      Downloads Directory
                    </p>
                    <p className="text-xs text-muted-foreground truncate" title={downloadsDir}>
                      {downloadsDir || 'Not set'}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangeDownloadsDir}
                  className="shrink-0"
                >
                  Change
                </Button>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
