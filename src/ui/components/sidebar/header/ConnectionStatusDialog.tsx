import { useState, useEffect } from "react";
import { Wifi, WifiOff, Plus, Trash2, RefreshCw, Loader2, Copy, Check } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

interface BootstrapNode {
  id: string;
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
  const [nodes, setNodes] = useState<BootstrapNode[]>([]);
  const [newAddress, setNewAddress] = useState("");
  const [isLoadingNodes, setIsLoadingNodes] = useState(true);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (open) {
      const fetchBootstrapNodes = async () => {
        setIsLoadingNodes(true);
        setNodesError(null);

        try {
          const result = await window.kiyeovoAPI.getBootstrapNodes();

          if (result.success) {
            const fetchedNodes: BootstrapNode[] = result.nodes.map((node, index) => ({
              id: `${index}`,
              address: node.address,
              connected: node.connected,
            }));
            setNodes(fetchedNodes);
          } else {
            setNodesError(result.error || 'Failed to fetch bootstrap nodes');
          }
        } catch (error) {
          console.error('Failed to fetch bootstrap nodes:', error);
          setNodesError(error instanceof Error ? error.message : 'Unexpected error occurred');
        } finally {
          setIsLoadingNodes(false);
        }
      };

      void fetchBootstrapNodes();
    }
  }, [open]);

  const handleRetryBootstrap = async () => {
    setIsRetrying(true);
    setNodesError(null);

    try {
      const result = await window.kiyeovoAPI.retryBootstrap();

      if (result.success) {
        console.log('[UI] Bootstrap retry successful, refetching nodes...');
        const nodesResult = await window.kiyeovoAPI.getBootstrapNodes();
        if (nodesResult.success) {
          const fetchedNodes: BootstrapNode[] = nodesResult.nodes.map((node, index) => ({
            id: `${index}`,
            address: node.address,
            connected: node.connected,
          }));
          setNodes(fetchedNodes);
        }
      } else {
        setNodesError(result.error || 'Failed to retry bootstrap connection');
      }
    } catch (error) {
      console.error('Failed to retry bootstrap:', error);
      setNodesError(error instanceof Error ? error.message : 'Unexpected error occurred');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleAddNode = async () => {
    const normalizedAddress = newAddress.trim();
    if (!normalizedAddress) return;

    const alreadyExists = nodes.some(node => node.address === normalizedAddress);
    if (alreadyExists) {
      setNodesError('Bootstrap node already exists');
      return;
    }

    setNodesError(null);

    try {
      const result = await window.kiyeovoAPI.addBootstrapNode(normalizedAddress);

      if (result.success) {
        console.log('[UI] Bootstrap node added successfully');
        const nodesResult = await window.kiyeovoAPI.getBootstrapNodes();
        if (nodesResult.success) {
          const fetchedNodes: BootstrapNode[] = nodesResult.nodes.map((node, index) => ({
            id: `${index}`,
            address: node.address,
            connected: node.connected,
          }));
          setNodes(fetchedNodes);
        }
        setNewAddress("");
      } else {
        setNodesError(result.error || 'Failed to add bootstrap node');
      }
    } catch (error) {
      console.error('Failed to add bootstrap node:', error);
      setNodesError(error instanceof Error ? error.message : 'Unexpected error occurred');
    }
  };

  const handleRemoveNode = async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    setNodesError(null);

    try {
      const result = await window.kiyeovoAPI.removeBootstrapNode(node.address);

      if (result.success) {
        console.log('[UI] Bootstrap node removed successfully');
        setNodes(nodes.filter(n => n.id !== nodeId));
      } else {
        setNodesError(result.error || 'Failed to remove bootstrap node');
      }
    } catch (error) {
      console.error('Failed to remove bootstrap node:', error);
      setNodesError(error instanceof Error ? error.message : 'Unexpected error occurred');
    }
  };

  const handleCopy = (peerId: string) => {
    setIsCopied(true);
    navigator.clipboard.writeText(peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  const connectedCount = nodes.filter(n => n.connected).length;

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
          <DialogDescription>
            {isConnected === null ? (
              "Connecting to the DHT network..."
            ) : isConnected ? (
              `Connected to ${connectedCount} bootstrap node${connectedCount !== 1 ? 's' : ''}`
            ) : "Not connected to the DHT network"
            }
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Node list */}
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
              Bootstrap Nodes
            </label>

            {isLoadingNodes ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading nodes...</span>
              </div>
            ) : nodesError ? (
              <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20">
                <span className="text-sm text-destructive">{nodesError}</span>
              </div>
            ) : nodes.length === 0 ? (
              <div className="p-4 rounded-md bg-secondary/50 border border-border">
                <span className="text-sm text-muted-foreground">No bootstrap nodes configured</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border"
                  >
                    <div className={`w-2 h-2 rounded-full ${node.connected ? 'bg-success' : 'bg-muted-foreground'}`} />
                    <span
                      className="flex-1 text-sm font-mono text-foreground truncate"
                      title={node.address}
                    >
                      {node.address}
                    </span>
                    <div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleCopy(node.address)}
                        className="h-7 w-7 text-muted-foreground"
                      >
                        {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveNode(node.id)}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3 hover:text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add new node */}
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
              Add Bootstrap Node
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Peer address"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddNode()}
                className="flex-1"
                parentClassName="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleAddNode}
                disabled={!newAddress.trim()}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Retry Bootstrap Button */}
          <div className="pt-2 border-t border-border">
            <Button
              variant="outline"
              className="w-full"
              onClick={handleRetryBootstrap}
              disabled={isRetrying || isLoadingNodes}
            >
              {isRetrying ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry Bootstrap Connection
                </>
              )}
            </Button>
          </div>

          {/* Status info */}
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Network Status</span>
              <span className={isConnected ? "text-success" : "text-destructive"}>
                {isConnected ? "ONLINE" : "OFFLINE"}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono mt-1">
              <span className="text-muted-foreground">Bootstrap Nodes Connected</span>
              <span className="text-foreground">{connectedCount}</span>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectionStatusDialog;
