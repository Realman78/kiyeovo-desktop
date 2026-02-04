import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { FileUp, X } from 'lucide-react';

interface SendFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (filePath: string, fileName: string, fileSize: number) => Promise<void>;
}

export const SendFileDialog: React.FC<SendFileDialogProps> = ({ open, onOpenChange, onSend }) => {
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleBrowse = async () => {
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select File',
        filters: [
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePath) {
        let fileSize = 0;
        let fileName = result.filePath.split(/[\\/]/).pop() || 'Unknown';
        try {
          const meta = await window.kiyeovoAPI.getFileMetadata(result.filePath);
          if (meta.success) {
            fileSize = meta.size || 0;
            fileName = meta.name || fileName;
          }
        } catch (metaError) {
          console.error('Error loading file metadata:', metaError);
        }
        setSelectedFile({
          path: result.filePath,
          name: fileName,
          size: fileSize
        });
      }
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  };

  const handleSend = async () => {
    if (!selectedFile) return;

    const filePath = selectedFile.path;
    const fileName = selectedFile.name;
    const fileSize = selectedFile.size;
    setSelectedFile(null);
    onOpenChange(false);
    setIsLoading(true);
    try {
      await onSend(filePath, fileName, fileSize);
    } catch (error) {
      console.error('Error sending file:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setSelectedFile(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send File</DialogTitle>
        </DialogHeader>

        <DialogBody>
          {selectedFile ? (
            <div className="border border-border rounded-lg p-4 bg-muted">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground mt-1">{selectedFile.path}</p>
                  <p className="text-xs text-muted-foreground mt-1">{selectedFile.size} bytes</p>
                </div>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="ml-2 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
              <p className="text-muted-foreground mb-3">No file selected</p>
              <Button onClick={handleBrowse} variant="outline">
                <FileUp className="w-4 h-4 mr-2" />
                Browse Files
              </Button>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            onClick={handleCancel}
            variant="outline"
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!selectedFile || isLoading}
          >
            {isLoading ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
