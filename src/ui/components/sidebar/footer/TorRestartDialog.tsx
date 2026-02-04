import type { FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";

type TorSettings = {
  enabled: boolean;
  socksHost: string;
  socksPort: number;
  connectionTimeout: number;
  circuitTimeout: number;
  maxRetries: number;
  healthCheckInterval: number;
  dnsResolution: 'tor' | 'system';
};

type TorRestartDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingSettings: TorSettings;
  originalSettings: TorSettings;
  onCancel: () => void;
  onConfirm: () => void;
};

export const TorRestartDialog: FC<TorRestartDialogProps> = ({
  open,
  onOpenChange,
  pendingSettings,
  originalSettings,
  onCancel,
  onConfirm
}) => {
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      onCancel();
    }
    onOpenChange(newOpen);
  };

  const getMessage = () => {
    if (pendingSettings.enabled !== originalSettings.enabled) {
      return `${pendingSettings.enabled ? 'Enabling' : 'Disabling'} Tor requires a full app restart. Continue?`;
    }
    return 'Changing Tor settings requires a full app restart. Apply changes now?';
  };

  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Restart Required</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            {getMessage()}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirm}>
              Restart
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
