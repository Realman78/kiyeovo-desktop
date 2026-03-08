import { type FC, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Bell, BellOff, FolderOpen, Info, Trash2, Database, Settings } from "lucide-react";
import { KiyeovoDialog } from "../header/KiyeovoDialog";
import { TorSettingsSection } from "./TorSettingsSection";
import { FastRelaySettingsSection } from "./FastRelaySettingsSection";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { TorRestartDialog } from "./TorRestartDialog";
import { ConfigurationDialog } from "./ConfigurationDialog";
import { TOR_CONFIG } from "../../../constants";
import { handleDeleteAccount } from "../../../utils/handlers";
import { useToast } from "../../ui/use-toast";
import type { NetworkMode } from "../../../../core/types";


type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { toast } = useToast();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [downloadsDir, setDownloadsDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [torSettings, setTorSettings] = useState({
    socksHost: TOR_CONFIG.DEFAULT_SOCKS_HOST,
    socksPort: TOR_CONFIG.DEFAULT_SOCKS_PORT,
    connectionTimeout: TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
    circuitTimeout: TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
    maxRetries: TOR_CONFIG.DEFAULT_MAX_RETRIES,
    healthCheckInterval: TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
    dnsResolution: TOR_CONFIG.DNS_RESOLUTION_TOR as 'tor' | 'system'
  });
  const [originalTorSettings, setOriginalTorSettings] = useState(torSettings);
  const [torConfirmOpen, setTorConfirmOpen] = useState(false);
  const [pendingTorSettings, setPendingTorSettings] = useState(torSettings);
  const [fastRelayMultiaddrsText, setFastRelayMultiaddrsText] = useState('');
  const [originalFastRelayMultiaddrsText, setOriginalFastRelayMultiaddrsText] = useState('');
  const [fastRelayConfirmOpen, setFastRelayConfirmOpen] = useState(false);
  const [pendingFastRelayMultiaddrsText, setPendingFastRelayMultiaddrsText] = useState('');
  const [fastRelayError, setFastRelayError] = useState<string | null>(null);
  const [isTestingFastRelays, setIsTestingFastRelays] = useState(false);
  const [fastRelayTestSummary, setFastRelayTestSummary] = useState<string | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('fast');

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

  const normalizeRelayListForEditor = (raw: string): string =>
    raw
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join('\n');

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [notifResult, downloadsDirResult, torResult, networkModeResult, fastRelayResult] = await Promise.all([
        window.kiyeovoAPI.getNotificationsEnabled(),
        window.kiyeovoAPI.getDownloadsDir(),
        window.kiyeovoAPI.getTorSettings(),
        window.kiyeovoAPI.getNetworkMode(),
        window.kiyeovoAPI.getFastRelaySettings(),
      ]);

      if (notifResult.success) {
        setNotificationsEnabled(notifResult.enabled);
      }

      if (downloadsDirResult.success && downloadsDirResult.path) {
        setDownloadsDir(downloadsDirResult.path);
      }
      if (torResult.success && torResult.settings) {
        const s = torResult.settings;
        const loadedSettings = {
          socksHost: s.socksHost || TOR_CONFIG.DEFAULT_SOCKS_HOST,
          socksPort: s.socksPort ? parseInt(s.socksPort, 10) : TOR_CONFIG.DEFAULT_SOCKS_PORT,
          connectionTimeout: s.connectionTimeout ? parseInt(s.connectionTimeout, 10) : TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
          circuitTimeout: s.circuitTimeout ? parseInt(s.circuitTimeout, 10) : TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
          maxRetries: s.maxRetries ? parseInt(s.maxRetries, 10) : TOR_CONFIG.DEFAULT_MAX_RETRIES,
          healthCheckInterval: s.healthCheckInterval ? parseInt(s.healthCheckInterval, 10) : TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
          dnsResolution: (s.dnsResolution === TOR_CONFIG.DNS_RESOLUTION_SYSTEM ? 'system' : 'tor') as 'tor' | 'system'
        };
        setTorSettings(loadedSettings);
        setOriginalTorSettings(loadedSettings);
      }

      if (networkModeResult.success) {
        setNetworkMode(networkModeResult.mode);
      }

      if (fastRelayResult.success && fastRelayResult.settings) {
        const normalized = normalizeRelayListForEditor(fastRelayResult.settings.multiaddrs || '');
        setFastRelayMultiaddrsText(normalized);
        setOriginalFastRelayMultiaddrsText(normalized);
        setFastRelayError(null);
        setFastRelayTestSummary(null);
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
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select Downloads Directory',
        properties: ['openDirectory']
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

  const handleConfirmTorRestart = (updatedSettings: typeof torSettings) => {
    setPendingTorSettings(updatedSettings);
    setTorConfirmOpen(true);
  };

  const handleApplyTorSettings = async () => {
    try {
      const result = await window.kiyeovoAPI.setTorSettings(pendingTorSettings);
      if (!result.success) {
        console.error('Failed to update Tor settings:', result.error);
        return;
      }
      await window.kiyeovoAPI.restartApp();
    } catch (error) {
      console.error('Failed to apply Tor settings:', error);
    }
  };

  const handleConfirmFastRelayRestart = (updatedRelayText: string) => {
    setPendingFastRelayMultiaddrsText(updatedRelayText);
    setFastRelayError(null);
    setFastRelayConfirmOpen(true);
  };

  const handleApplyFastRelaySettings = async () => {
    try {
      const result = await window.kiyeovoAPI.setFastRelaySettings({ multiaddrs: pendingFastRelayMultiaddrsText });
      if (!result.success) {
        setFastRelayError(result.error || 'Failed to update fast relay settings');
        return;
      }
      const normalized = normalizeRelayListForEditor(result.normalizedMultiaddrs || '');
      setFastRelayMultiaddrsText(normalized);
      setOriginalFastRelayMultiaddrsText(normalized);
      await window.kiyeovoAPI.restartApp();
    } catch (error) {
      setFastRelayError(error instanceof Error ? error.message : 'Failed to update fast relay settings');
    }
  };

  const handleTestFastRelays = async () => {
    setIsTestingFastRelays(true);
    setFastRelayError(null);
    setFastRelayTestSummary(null);
    try {
      const result = await window.kiyeovoAPI.testFastRelayNodes({ multiaddrs: fastRelayMultiaddrsText });
      if (!result.success) {
        setFastRelayError(result.error || 'Fast relay test failed');
        return;
      }
      const total = result.results.length;
      const successful = result.results.filter((entry) => entry.success).length;
      const failedEntries = result.results.filter((entry) => !entry.success);
      const summary = `Relay reachability: ${successful}/${total} succeeded.`;
      setFastRelayTestSummary(summary);

      if (failedEntries.length === 0) {
        toast.success(summary, 'Relay test passed');
        return;
      }

      toast.warning(`${summary}`, 'Relay test partial');
    } catch (error) {
      setFastRelayError(error instanceof Error ? error.message : 'Fast relay test failed');
    } finally {
      setIsTestingFastRelays(false);
    }
  };

  const handleBackupDatabase = async () => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const defaultFileName = `kiyeovo-backup-${timestamp}.db`;

      const result = await window.kiyeovoAPI.showSaveDialog({
        title: 'Save Database Backup',
        defaultPath: defaultFileName,
        filters: [
          { name: 'Database Files', extensions: ['db'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePath) {
        const backupResult = await window.kiyeovoAPI.backupDatabase(result.filePath);
        if (backupResult.success) {
          toast.info('Database backup successful');
          onOpenChange(false);
          // Could show a success toast here
        } else {
          console.error('Failed to backup database:', backupResult.error);
        }
      }
    } catch (error) {
      console.error('Failed to backup database:', error);
    }
  }

  const handleCancelTorRestart = () => {
    setTorSettings(originalTorSettings);
    setTorConfirmOpen(false);
  };

  const handleCancelFastRelayRestart = () => {
    setFastRelayMultiaddrsText(originalFastRelayMultiaddrsText);
    setFastRelayConfirmOpen(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading settings...</div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 border border-border rounded-lg transition-colors">
                  <div className="flex items-center gap-3">
                    <Info className="w-5 h-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        About Kiyeovo
                      </p>
                      <p className="text-xs text-muted-foreground">
                        App info and resources
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAboutOpen(true)}
                  >
                    Open
                  </Button>
                </div>
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
                    variant={!notificationsEnabled ? "default" : "outline"}
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
                <TorSettingsSection
                  torSettings={torSettings}
                  setTorSettings={setTorSettings}
                  originalTorSettings={originalTorSettings}
                  onConfirmRestart={handleConfirmTorRestart}
                  isAnonymousMode={networkMode === 'anonymous'}
                />
                <FastRelaySettingsSection
                  relayMultiaddrsText={fastRelayMultiaddrsText}
                  setRelayMultiaddrsText={setFastRelayMultiaddrsText}
                  originalRelayMultiaddrsText={originalFastRelayMultiaddrsText}
                  onConfirmRestart={handleConfirmFastRelayRestart}
                  onTestRelays={handleTestFastRelays}
                  isTestingRelays={isTestingFastRelays}
                  testSummary={fastRelayTestSummary}
                  backendError={fastRelayError}
                  isFastMode={networkMode === 'fast'}
                />

                <div className="flex items-center justify-between p-3 border border-border rounded-lg transition-colors">
                  <div className="flex items-center gap-3">
                    <Settings className="w-5 h-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Configuration
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Performance and behavior settings
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfigDialogOpen(true)}
                  >
                    Open
                  </Button>
                </div>

                <div className="flex items-center justify-between p-3 border border-border rounded-lg transition-colors">
                  <div className="flex items-center gap-3 flex-1">
                    <Database className="w-5 h-5 text-primary shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">
                        Backup Database
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Save a copy of all your data
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBackupDatabase}
                    className="shrink-0"
                  >
                    Backup
                  </Button>
                </div>

                <div className="flex items-center justify-between p-3 border border-destructive/50 rounded-lg transition-colors bg-destructive/5">
                  <div className="flex items-center gap-3 flex-1">
                    <Trash2 className="w-5 h-5 text-destructive shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">
                        Delete Account
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Permanently delete all data
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteAccountOpen(true)}
                    className="shrink-0"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      <KiyeovoDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <TorRestartDialog
        open={torConfirmOpen}
        onOpenChange={setTorConfirmOpen}
        onCancel={handleCancelTorRestart}
        onConfirm={handleApplyTorSettings}
      />
      <TorRestartDialog
        open={fastRelayConfirmOpen}
        onOpenChange={setFastRelayConfirmOpen}
        onCancel={handleCancelFastRelayRestart}
        onConfirm={handleApplyFastRelaySettings}
        message="Changing fast relay settings requires a full app restart. Apply changes now?"
      />
      <DeleteAccountDialog
        open={deleteAccountOpen}
        onOpenChange={setDeleteAccountOpen}
        onConfirm={handleDeleteAccount}
      />
      <ConfigurationDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
      />
    </>
  );
};
