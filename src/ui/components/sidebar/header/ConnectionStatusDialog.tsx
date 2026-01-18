import { useState } from "react";
import { Wifi, WifiOff, Plus, Trash2, Link, Unlink, Loader2 } from "lucide-react";
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
  onConnectionChange: (connected: boolean) => void;
}

const ConnectionStatusDialog = ({
  open,
  onOpenChange,
  isConnected,
  onConnectionChange,
}: ConnectionStatusDialogProps) => {
  const [nodes, setNodes] = useState<BootstrapNode[]>([
    { id: "1", address: "bootstrap1.nexusmesh.io:4001", connected: true },
    { id: "2", address: "bootstrap2.nexusmesh.io:4001", connected: false },
    { id: "3", address: "dht.example.org:4001", connected: false },
  ]);
  const [newAddress, setNewAddress] = useState("");

  const handleConnect = (nodeId: string) => {
    setNodes(nodes.map(node => 
      node.id === nodeId ? { ...node, connected: true } : node
    ));
    onConnectionChange(true);
  };

  const handleDisconnect = (nodeId: string) => {
    const updatedNodes = nodes.map(node => 
      node.id === nodeId ? { ...node, connected: false } : node
    );
    setNodes(updatedNodes);
    
    // Check if any nodes are still connected
    const anyConnected = updatedNodes.some(node => node.connected);
    onConnectionChange(anyConnected);
  };

  const handleAddNode = () => {
    if (newAddress.trim()) {
      setNodes([...nodes, {
        id: Date.now().toString(),
        address: newAddress.trim(),
        connected: false,
      }]);
      setNewAddress("");
    }
  };

  const handleRemoveNode = (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (node?.connected) {
      handleDisconnect(nodeId);
    }
    setNodes(nodes.filter(n => n.id !== nodeId));
  };

  const connectedCount = nodes.filter(n => n.connected).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {nodes.map((node) => (
                <div
                  key={node.id}
                  className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border"
                >
                  <div className={`w-2 h-2 rounded-full ${node.connected ? 'bg-success' : 'bg-muted-foreground'}`} />
                  <span className="flex-1 text-sm font-mono text-foreground truncate">
                    {node.address}
                  </span>
                  <div className="flex items-center gap-1">
                    {node.connected ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDisconnect(node.id)}
                        className="h-7 px-2 text-destructive hover:text-destructive"
                      >
                        <Unlink className="w-3 h-3 mr-1" />
                        <span className="text-xs">Disconnect</span>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleConnect(node.id)}
                        className="h-7 px-2 text-success hover:text-success"
                      >
                        <Link className="w-3 h-3 mr-1" />
                        <span className="text-xs">Connect</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveNode(node.id)}
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Add new node */}
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
              Add Bootstrap Node
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="address:port"
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

          {/* Status info */}
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Network Status</span>
              <span className={isConnected ? "text-success" : "text-destructive"}>
                {isConnected ? "ONLINE" : "OFFLINE"}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono mt-1">
              <span className="text-muted-foreground">Active Connections</span>
              <span className="text-foreground">{connectedCount}</span>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectionStatusDialog;
