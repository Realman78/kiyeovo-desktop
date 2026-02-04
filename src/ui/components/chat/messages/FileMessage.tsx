import React, { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { FolderOpen } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../state/store';
import { setPendingFileStatus, updateFileTransferStatus } from '../../../state/slices/chatSlice';

interface FileMessageProps {
  fileId: string;
  chatId: number;
  fileName: string;
  fileSize: number;
  filePath?: string;
  transferStatus: 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'rejected';
  transferProgress?: number;
  transferError?: string;
  transferExpiresAt?: number;
  isFromCurrentUser: boolean;
}

export const FileMessage: React.FC<FileMessageProps> = ({
  fileId,
  chatId,
  fileName,
  fileSize,
  filePath,
  transferStatus,
  transferProgress = 0,
  transferError,
  transferExpiresAt,
  isFromCurrentUser
}) => {
  const dispatch = useDispatch();
  const messages = useSelector((state: RootState) => state.chat.messages);
  const [timeLeftMs, setTimeLeftMs] = useState(() => {
    if (transferStatus === 'pending' && transferExpiresAt) {
      return Math.max(0, transferExpiresAt - Date.now());
    }
    return 0;
  });

  useEffect(() => {
    if (transferStatus !== 'pending' || !transferExpiresAt) {
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, transferExpiresAt - Date.now());
      setTimeLeftMs(remaining);
      if (remaining === 0 && !isFromCurrentUser) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'expired',
          transferError: 'Offer expired'
        }));
        const hasOtherPending = messages.some(m => m.chatId === chatId && m.id !== fileId && m.transferStatus === 'pending');
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      }
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [transferStatus, transferExpiresAt, isFromCurrentUser, fileId, chatId, messages, dispatch]);
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatTimeLeft = (ms: number): string => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleAccept = async () => {
    try {
      const result = await window.kiyeovoAPI.acceptFile(fileId);
      if (result.success) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'in_progress'
        }));
        const hasOtherPending = messages.some(m => m.chatId === chatId && m.id !== fileId && m.transferStatus === 'pending');
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      } else {
        console.error('Failed to accept file:', result.error);
      }
    } catch (error) {
      console.error('Error accepting file:', error);
    }
  };

  const handleReject = async () => {
    try {
      const result = await window.kiyeovoAPI.rejectFile(fileId);
      if (result.success) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'rejected',
          transferError: 'Offer rejected'
        }));
        const hasOtherPending = messages.some(m => m.chatId === chatId && m.id !== fileId && m.transferStatus === 'pending');
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      } else {
        console.error('Failed to reject file:', result.error);
      }
    } catch (error) {
      console.error('Error rejecting file:', error);
    }
  };

  const handleOpenFile = async () => {
    if (filePath && transferStatus === 'completed') {
      const result = await window.kiyeovoAPI.openFileLocation(filePath);
      if (!result.success) {
        console.error('Failed to open file location:', result.error);
      }
    }
  };

  const getStatusText = () => {
    switch (transferStatus) {
      case 'pending':
        return isFromCurrentUser ? 'Awaiting acceptance' : 'Waiting...';
      case 'in_progress':
        return `${transferProgress}%`;
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'expired':
        return 'Offer expired';
      case 'rejected':
        return 'Offer rejected';
      default:
        return '';
    }
  };

  const getIcon = () => {
    const extension = fileName.split('.').pop()?.toLowerCase();

    // File type icons
    const iconMap: Record<string, string> = {
      pdf: '📄',
      doc: '📝',
      docx: '📝',
      txt: '📝',
      jpg: '🖼️',
      jpeg: '🖼️',
      png: '🖼️',
      gif: '🖼️',
      mp4: '🎬',
      mp3: '🎵',
      zip: '📦',
      rar: '📦',
    };

    return iconMap[extension || ''] || '📎';
  };

  return (
    <div className="flex flex-col gap-2 w-[250px]">
      <div className="flex items-center justify-between gap-3">
        <div className={`text-2xl ${isFromCurrentUser ? 'bg-background/50' : ''} rounded-md p-1`}>{getIcon()}</div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium truncate">{fileName}</p>
          <p className="text-xs opacity-70">{formatFileSize(fileSize)}</p>
        </div>
        {transferStatus === 'completed' && !!filePath ? (
        <Button
          onClick={handleOpenFile}
          variant="outline"
          size="icon"
        >
          <FolderOpen className="w-4 h-4" />
        </Button>
      ) : <div></div>}
      </div>

      {transferStatus === 'in_progress' && (
        <div className="w-full">
          <div className="w-full bg-background/20 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-300"
              style={{ width: `${transferProgress}%` }}
            />
          </div>
          <p className="text-xs opacity-70 mt-1">{getStatusText()}</p>
        </div>
      )}

      {transferStatus === 'failed' && (
        <div className="text-xs">
          {transferError || 'Transfer failed'}
        </div>
      )}

      {(transferStatus === 'expired' || transferStatus === 'rejected') && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {transferStatus === 'pending' && (
        <div className="text-xs opacity-70">
          <div>{getStatusText()}</div>
          {transferExpiresAt && (
            <div>Expires in {formatTimeLeft(timeLeftMs)}</div>
          )}
        </div>
      )}

      {transferStatus === 'pending' && !isFromCurrentUser && (
        <div className="flex gap-2">
          <Button
            onClick={handleAccept}
            size="sm"
            className="flex-1"
          >
            Accept
          </Button>
          <Button
            onClick={handleReject}
            size="sm"
            variant="outline"
            className="flex-1"
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
};
