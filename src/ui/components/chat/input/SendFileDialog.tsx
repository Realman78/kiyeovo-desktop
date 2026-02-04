import React, { useEffect, useState } from 'react';
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
import { MAX_FILE_SIZE } from '../../../constants';

interface SendFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (filePath: string, fileName: string, fileSize: number) => Promise<void>;
}

export const SendFileDialog: React.FC<SendFileDialogProps> = ({ open, onOpenChange, onSend }) => {
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  };

  useEffect(() => {
    if (!open) {
      setIsLoading(false);
      setSelectedFile(null);
      setSizeError(null);
    }
  }, [open]);

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
        setSizeError(fileSize > MAX_FILE_SIZE ? `File exceeds size limit (${formatFileSize(MAX_FILE_SIZE)} max)` : null);
      }
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  };

  const handleSend = () => {
    if (!selectedFile || sizeError) return;

    const filePath = selectedFile.path;
    const fileName = selectedFile.name;
    const fileSize = selectedFile.size;

    setSelectedFile(null);
    onOpenChange(false);
    void onSend(filePath, fileName, fileSize).catch(err => {
      console.error('Error sending file:', err);
    });
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
                  <p className="text-xs text-muted-foreground mt-1">{formatFileSize(selectedFile.size)}</p>
                </div>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="ml-2 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {sizeError && (
                <p className="text-xs text-destructive mt-2">{sizeError}</p>
              )}
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
            disabled={!selectedFile || isLoading || !!sizeError}
          >
            {isLoading ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
