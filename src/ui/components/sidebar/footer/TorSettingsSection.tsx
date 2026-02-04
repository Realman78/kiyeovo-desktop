import React, { useEffect, type FC } from "react";
import { Button } from "../../ui/Button";
import { HatGlasses } from "lucide-react";

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

type TorSettingsSectionProps = {
  torSettings: TorSettings;
  setTorSettings: (next: TorSettings | ((prev: TorSettings) => TorSettings)) => void;
  originalTorSettings: TorSettings;
  onConfirmRestart: (updatedSettings: TorSettings) => void;
};

export const TorSettingsSection: FC<TorSettingsSectionProps> = ({
  torSettings,
  setTorSettings,
  originalTorSettings,
  onConfirmRestart
}) => {
  const [isConfigExpanded, setIsConfigExpanded] = React.useState(originalTorSettings.enabled);

  useEffect(() => {
    setIsConfigExpanded(originalTorSettings.enabled);
  }, [originalTorSettings.enabled]);

  const updateTorField = (updates: Partial<TorSettings>) => {
    const newSettings = { ...torSettings, ...updates };
    setTorSettings(newSettings);
  };

  const handleToggleEnabled = () => {
    if (originalTorSettings.enabled) {
      // Currently enabled - disable immediately (show dialog)
      const newSettings = { ...torSettings, enabled: false };
      setTorSettings(newSettings);
      onConfirmRestart(newSettings);
    } else {
      // Currently disabled - enable and show config
      const newSettings = { ...torSettings, enabled: true };
      setTorSettings(newSettings);
      setIsConfigExpanded(true);
    }
  };

  const handleCancel = () => {
    setTorSettings(originalTorSettings);
    setIsConfigExpanded(originalTorSettings.enabled);
  };

  const hasChanges = JSON.stringify(torSettings) !== JSON.stringify(originalTorSettings);

  return (
    <div className="border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HatGlasses className="w-5 h-5 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Tor Network</p>
            <p className="text-xs text-muted-foreground">Requires restart to apply</p>
          </div>
        </div>
        {isConfigExpanded && hasChanges ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant={originalTorSettings.enabled ? "default" : "outline"}
            size="sm"
            onClick={handleToggleEnabled}
          >
            {originalTorSettings.enabled ? "Enabled" : "Disabled"}
          </Button>
        )}
      </div>

      {isConfigExpanded && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">SOCKS Host</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              value={torSettings.socksHost}
              onChange={(e) => updateTorField({ socksHost: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">SOCKS Port</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              type="number"
              value={torSettings.socksPort}
              onChange={(e) => updateTorField({ socksPort: parseInt(e.target.value || '0', 10) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Connection Timeout (ms)</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              type="number"
              value={torSettings.connectionTimeout}
              onChange={(e) => updateTorField({ connectionTimeout: parseInt(e.target.value || '0', 10) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Circuit Timeout (ms)</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              type="number"
              value={torSettings.circuitTimeout}
              onChange={(e) => updateTorField({ circuitTimeout: parseInt(e.target.value || '0', 10) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Max Retries</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              type="number"
              value={torSettings.maxRetries}
              onChange={(e) => updateTorField({ maxRetries: parseInt(e.target.value || '0', 10) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Health Check Interval (ms)</span>
            <input
              className="border border-border rounded px-2 py-1 bg-background"
              type="number"
              value={torSettings.healthCheckInterval}
              onChange={(e) => updateTorField({ healthCheckInterval: parseInt(e.target.value || '0', 10) })}
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs text-muted-foreground">DNS Resolution</span>
            <select
              className="border border-border rounded px-2 py-1 bg-background"
              value={torSettings.dnsResolution}
              onChange={(e) => updateTorField({ dnsResolution: e.target.value as 'tor' | 'system' })}
            >
              <option value="tor">tor</option>
              <option value="system">system</option>
            </select>
          </label>
        </div>
      )}
      {hasChanges && torSettings.enabled && <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => onConfirmRestart(torSettings)}
        >
          Apply & Restart
        </Button>
      </div>}
    </div>
  );
};
