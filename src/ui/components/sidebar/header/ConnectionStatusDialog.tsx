import { useState, useEffect } from "react";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/Dialog";
import { useToast } from "../../ui/use-toast";
import type { NetworkMode } from "../../../../core/types";
import { ConnectionNodesTab } from "./ConnectionNodesTab";

interface BootstrapNode {
  id: string;
  address: string;
  connected: boolean;
}

interface RelayNode {
  address: string;
  connected: boolean;
}

interface ConnectionStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isConnected: boolean | null;
}

const ConnectionStatusDialog = ({
  open,
  onOpenChange,
  isConnected,
}: ConnectionStatusDialogProps) => {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'bootstrap' | 'relays'>('bootstrap');
  const [networkMode, setNetworkMode] = useState<NetworkMode>('fast');

  const [bootstrapNodes, setBootstrapNodes] = useState<BootstrapNode[]>([]);
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([]);

  const [newBootstrapAddress, setNewBootstrapAddress] = useState("");
  const [newRelayAddress, setNewRelayAddress] = useState("");

  const [isLoadingBootstrapNodes, setIsLoadingBootstrapNodes] = useState(true);
  const [isLoadingRelayNodes, setIsLoadingRelayNodes] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [isRetryingBootstrap, setIsRetryingBootstrap] = useState(false);
  const [isRetryingRelays, setIsRetryingRelays] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const refreshBootstrapNodes = async () => {
    const nodesResult = await window.kiyeovoAPI.getBootstrapNodes();
    if (!nodesResult.success) {
      throw new Error(nodesResult.error || 'Failed to fetch bootstrap nodes');
    }

    const fetchedNodes: BootstrapNode[] = nodesResult.nodes.map((node, index) => ({
      id: `${index}`,
      address: node.address,
      connected: node.connected,
    }));
    setBootstrapNodes(fetchedNodes);
  };

  const refreshRelayNodes = async () => {
    const relayResult = await window.kiyeovoAPI.getRelayStatus();
    if (!relayResult.success) {
      throw new Error(relayResult.error || 'Failed to fetch relay nodes');
    }
    setRelayNodes(relayResult.nodes);
  };

  useEffect(() => {
    if (!open) return;

    const fetchDialogData = async () => {
      setIsLoadingBootstrapNodes(true);
      setIsLoadingRelayNodes(true);
      setBootstrapError(null);
      setRelayError(null);

      try {
        const modeResult = await window.kiyeovoAPI.getNetworkMode();
        if (!modeResult.success) {
          throw new Error(modeResult.error || 'Failed to fetch network mode');
        }
        setNetworkMode(modeResult.mode);

        await refreshBootstrapNodes();
        if (modeResult.mode === 'fast') {
          await refreshRelayNodes();
        } else {
          setRelayNodes([]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error occurred';
        setBootstrapError(message);
        setRelayError(message);
      } finally {
        setIsLoadingBootstrapNodes(false);
        setIsLoadingRelayNodes(false);
      }
    };

    void fetchDialogData();
  }, [open, isConnected]);

  useEffect(() => {
    if (networkMode !== 'fast' && activeTab === 'relays') {
      setActiveTab('bootstrap');
    }
  }, [networkMode, activeTab]);

  const handleRetryBootstrap = async () => {
    setIsRetryingBootstrap(true);
    setBootstrapError(null);

    try {
      const result = await window.kiyeovoAPI.retryBootstrap();
      if (!result.success) {
        const message = result.error || 'Failed to retry bootstrap connection';
        setBootstrapError(message);
        toast.error(message);
        return;
      }

      await refreshBootstrapNodes();
      if (networkMode === 'fast') {
        await refreshRelayNodes();
      }
      toast.success('Bootstrap retry complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred';
      setBootstrapError(message);
      toast.error(message);
    } finally {
      setIsRetryingBootstrap(false);
    }
  };

  const handleRetryRelays = async () => {
    setIsRetryingRelays(true);
    setRelayError(null);

    try {
      const result = await window.kiyeovoAPI.retryRelays();
      if (!result.success) {
        const message = result.error || 'Failed to retry relay reservations';
        setRelayError(message);
        toast.error(message);
        return;
      }

      await refreshRelayNodes();
      toast.success(`Relay retry complete (${result.connected}/${result.attempted})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred';
      setRelayError(message);
      toast.error(message);
    } finally {
      setIsRetryingRelays(false);
    }
  };

  const handleAddBootstrapNode = async () => {
    const normalizedAddress = newBootstrapAddress.trim();
    if (!normalizedAddress) return;

    if (bootstrapNodes.some(node => node.address === normalizedAddress)) {
      setBootstrapError('Bootstrap node already exists');
      return;
    }

    setBootstrapError(null);
    try {
      const result = await window.kiyeovoAPI.addBootstrapNode(normalizedAddress);
      if (!result.success) {
        setBootstrapError(result.error || 'Failed to add bootstrap node');
        return;
      }

      await refreshBootstrapNodes();
      setNewBootstrapAddress("");
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : 'Unexpected error occurred');
    }
  };

  const handleAddRelayNode = async () => {
    const normalizedAddress = newRelayAddress.trim();
    if (!normalizedAddress) return;

    if (relayNodes.some(node => node.address === normalizedAddress)) {
      setRelayError('Relay node already exists');
      return;
    }

    setRelayError(null);
    try {
      const result = await window.kiyeovoAPI.addRelayNode(normalizedAddress);
      if (!result.success) {
        const message = result.error || 'Failed to add relay node';
        setRelayError(message);
        toast.error(message);
        return;
      }

      await refreshRelayNodes();
      setNewRelayAddress("");
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred';
      setRelayError(message);
      toast.error(message);
    }
  };

  const handleRemoveBootstrapNode = async (address: string) => {
    setBootstrapError(null);
    try {
      const result = await window.kiyeovoAPI.removeBootstrapNode(address);
      if (!result.success) {
        setBootstrapError(result.error || 'Failed to remove bootstrap node');
        return;
      }

      await refreshBootstrapNodes();
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : 'Unexpected error occurred');
    }
  };

  const handleRemoveRelayNode = async (address: string) => {
    setRelayError(null);
    try {
      const result = await window.kiyeovoAPI.removeRelayNode(address);
      if (!result.success) {
        const message = result.error || 'Failed to remove relay node';
        setRelayError(message);
        toast.error(message);
        return;
      }

      await refreshRelayNodes();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred';
      setRelayError(message);
      toast.error(message);
    }
  };

  const handleCopy = (address: string) => {
    setCopiedAddress(address);
    navigator.clipboard.writeText(address);
    setTimeout(() => {
      setCopiedAddress((current) => (current === address ? null : current));
    }, 2000);
  };

  const showLiveNodeConnectivity = isConnected === true;
  const bootstrapConnectedCount = bootstrapNodes.filter((node) => showLiveNodeConnectivity && node.connected).length;
  const relayConnectedCount = relayNodes.filter((node) => showLiveNodeConnectivity && node.connected).length;
  const bootstrapEntries = bootstrapNodes.map((node) => ({
    key: node.id,
    address: node.address,
    connected: showLiveNodeConnectivity && node.connected,
  }));
  const relayEntries = relayNodes.map((node) => ({
    key: node.address,
    address: node.address,
    connected: showLiveNodeConnectivity && node.connected,
  }));
  const isFastMode = networkMode === 'fast';
  const isRelayTab = activeTab === 'relays' && isFastMode;
  const headerDescription = isConnected === null
    ? "Connecting to the DHT network..."
    : isConnected
      ? (isRelayTab
          ? `Connected to ${relayConnectedCount} relay node${relayConnectedCount !== 1 ? 's' : ''}`
          : `Connected to ${bootstrapConnectedCount} bootstrap node${bootstrapConnectedCount !== 1 ? 's' : ''}`)
      : "Not connected to the DHT network";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isConnected === null ? (
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            ) : isConnected ? (
              <Wifi className="w-5 h-5 text-success" />
            ) : (
              <WifiOff className="w-5 h-5 text-destructive" />
            )}
            DHT Network Status
          </DialogTitle>
          <DialogDescription>{headerDescription}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {isFastMode ? (
            <div className="relative grid grid-cols-2 border-b border-border">
              <div
                className="absolute bottom-0 h-[2px] w-1/2 bg-primary transition-transform duration-200 ease-in-out"
                style={{ transform: activeTab === 'bootstrap' ? 'translateX(0)' : 'translateX(100%)' }}
              />
              <button
                type="button"
                onClick={() => setActiveTab('bootstrap')}
                className={`cursor-pointer px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'bootstrap' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Bootstrap
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('relays')}
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'relays'
                    ? 'text-primary cursor-pointer'
                    : 'text-muted-foreground hover:text-foreground cursor-pointer'
                }`}
              >
                Relays
              </button>
            </div>
          ) : null}

          {!isRelayTab ? (
            <ConnectionNodesTab
              sectionLabel="Bootstrap Nodes"
              addLabel="Add Bootstrap Node"
              addPlaceholder="Peer address"
              retryLabel="Retry Bootstrap Connection"
              loadingLabel="Loading nodes..."
              emptyLabel="No bootstrap nodes configured"
              nodes={bootstrapEntries}
              loading={isLoadingBootstrapNodes}
              error={bootstrapError}
              copiedAddress={copiedAddress}
              newAddress={newBootstrapAddress}
              retrying={isRetryingBootstrap}
              retryDisabled={isRetryingBootstrap || isLoadingBootstrapNodes}
              onNewAddressChange={setNewBootstrapAddress}
              onAdd={handleAddBootstrapNode}
              onRetry={handleRetryBootstrap}
              onCopy={handleCopy}
              onRemove={handleRemoveBootstrapNode}
            />
          ) : (
            <ConnectionNodesTab
              sectionLabel="Relay Nodes"
              addLabel="Add Relay Node"
              addPlaceholder="/ip4/1.2.3.4/tcp/4002/p2p/12D3Koo..."
              retryLabel="Retry Relay Reservations"
              loadingLabel="Loading relay nodes..."
              emptyLabel="No relay nodes configured"
              nodes={relayEntries}
              loading={isLoadingRelayNodes}
              error={relayError}
              copiedAddress={copiedAddress}
              newAddress={newRelayAddress}
              retrying={isRetryingRelays}
              retryDisabled={networkMode !== 'fast' || isRetryingRelays || isLoadingRelayNodes || relayNodes.length === 0}
              onNewAddressChange={setNewRelayAddress}
              onAdd={handleAddRelayNode}
              onRetry={handleRetryRelays}
              onCopy={handleCopy}
              onRemove={handleRemoveRelayNode}
            />
          )}

          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Network Status</span>
              <span className={isConnected ? "text-success" : "text-destructive"}>
                {isConnected ? "ONLINE" : "OFFLINE"}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono mt-1">
              <span className="text-muted-foreground">Bootstrap Nodes Connected</span>
              <span className="text-foreground">{bootstrapConnectedCount}</span>
            </div>
            {isFastMode ? (
              <div className="flex items-center justify-between text-xs font-mono mt-1">
                <span className="text-muted-foreground">Relay Nodes Connected</span>
                <span className="text-foreground">{relayConnectedCount}/{relayNodes.length}</span>
              </div>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectionStatusDialog;
