import { useEffect, useRef, useState } from "react";
import { finalizeSendingMessage, setMessages, updateChat, updateLocalMessageSendState, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { PendingNotifications } from "./PendingNotifications";
import { FileMessage } from "./FileMessage";
import type { MessageSentStatus } from "../../../types";
import { FILE_ACCEPTANCE_TIMEOUT, SHOW_TIMESTAMP_INTERVAL } from "../../../constants";
import { Info, Loader2 } from "lucide-react";
import { useToast } from "../../ui/use-toast";

type MessagesContainerProps = {
  messages: ChatMessage[];
  isPending: boolean;
}
export const MessagesContainer = ({ messages, isPending }: MessagesContainerProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const dispatch = useDispatch();
  const { toast } = useToast();

  const [error, setError] = useState<string | null>(null);

  const parseFileContent = (content: string | null | undefined): { fileName?: string; fileSize?: number } => {
    if (!content) return {};
    const match = content.match(/^(.*)\s+\((\d+)\s+bytes\)$/);
    if (!match) return {};
    return {
      fileName: match[1],
      fileSize: Number(match[2])
    };
  };

  const getMembershipInfoTooltip = (message: ChatMessage): string | null => {
    if (message.messageType !== 'system' || !message.eventTimestamp) {
      return null;
    }
    const normalized = message.content.toLowerCase();
    const isMembershipEvent =
      normalized.includes('joined the group') ||
      normalized.includes('left the group') ||
      normalized.includes('was removed from the group');
    if (!isMembershipEvent) {
      return null;
    }
    return `${message.content} at ${formatTimestampToHourMinute(message.eventTimestamp)}.${normalized.includes('joined the group') ? ' This member can only see your messages after this system message, not strictly after the join/leave time.' : ''}`;
  };


  useEffect(() => {
    const fetchMessages = async () => {
      if (activeChat) {
        const result = await window.kiyeovoAPI.getMessages(activeChat.id);
        if (result.success) {
          const messages = result.messages.map(msg => {
            let fileName = msg.file_name;
            let fileSize = msg.file_size;
            if (msg.message_type === 'file' && (!fileName || fileSize === undefined)) {
              const parsed = parseFileContent(msg.content);
              fileName = fileName || parsed.fileName;
              if (fileSize === undefined) {
                fileSize = parsed.fileSize;
              }
            }
            const inferredTransferStatus =
              msg.transfer_status ??
              (msg.message_type === 'file'
                ? 'completed'
                : undefined);

            const transferExpiresAt =
              msg.message_type === 'file' && msg.transfer_status === 'pending'
                ? msg.timestamp.getTime() + FILE_ACCEPTANCE_TIMEOUT
                : undefined;

            return {
              id: msg.id,
              chatId: msg.chat_id,
              senderPeerId: msg.sender_peer_id,
              senderUsername: msg.sender_username || 'UNKNOWN',
              content: msg.content,
              timestamp: msg.timestamp.getTime(),
              eventTimestamp: msg.event_timestamp ? msg.event_timestamp.getTime() : undefined,
              messageType: msg.message_type as 'text' | 'file' | 'image' | 'system',
              messageSentStatus: 'online' as MessageSentStatus,
              // File transfer fields
              fileName,
              fileSize,
              filePath: msg.file_path,
              transferStatus: inferredTransferStatus as 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'rejected' | undefined,
              transferProgress: msg.transfer_progress,
              transferError: msg.transfer_error,
              transferExpiresAt
            }
          });
          dispatch(setMessages(messages));
        } else {
          setError(result.error || 'Failed to fetch messages');
        }
      }
    }
    fetchMessages();
  }, [activeChat]);

  useEffect(() => {
    if (activeChat?.justCreated && messages.length === 0) {
      const timeout = setTimeout(() => {
        if (messages.length === 0) {
          console.log(`[MessagesContainer] Clearing justCreated flag for chat ${activeChat.id} after timeout`);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { justCreated: false }
          }));
        }
      }, 10000);

      return () => clearTimeout(timeout);
    }
  }, [activeChat?.justCreated, activeChat?.id, messages.length, dispatch]);

  useEffect(() => {
    // TODO scroll to bottom on first open and when I send a new message,
    // not when a new message is received
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messagesEndRef, messages]);

  const showEmptyState = !isPending && messages.length === 0;
  const isTrustedOutOfBand = activeChat?.trusted_out_of_band;
  let previousSenderPeerId: string | null = null;
  let senderStreak = 0;

  const handleRetryFailedMessage = async (message: ChatMessage) => {
    if (!activeChat) return;
    dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'sending' }));

    try {
      if (activeChat.type === 'group') {
        const { success, error, warning, offlineBackupRetry, message: sentMessage, messageSentStatus } = await window.kiyeovoAPI.sendGroupMessage(activeChat.id, message.content);
        if (!success) {
          dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
          toast.error(error || 'Failed to resend group message');
          return;
        }
        if (warning && offlineBackupRetry) {
          toast.warningAction(
            warning,
            'Try again',
            async () => {
              const retry = await window.kiyeovoAPI.retryGroupOfflineBackup(
                offlineBackupRetry.chatId,
                offlineBackupRetry.messageId,
              );
              if (retry.success) {
                toast.success('Group offline backup synced');
              } else {
                toast.error(retry.error || 'Failed to retry group offline backup');
              }
            },
          );
        }
        if (sentMessage?.messageId) {
          dispatch(finalizeSendingMessage({
            localMessageId: message.id,
            finalMessage: {
              ...message,
              id: sentMessage.messageId,
              timestamp: sentMessage.timestamp ?? Date.now(),
              messageSentStatus: messageSentStatus ?? 'online',
              localSendState: undefined,
            },
          }));
        }
        return;
      }

      if (!activeChat.peerId) {
        dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
        toast.error('No peer ID found for active chat');
        return;
      }

      const { success, error, message: sentMessage, messageSentStatus } = await window.kiyeovoAPI.sendMessage(activeChat.peerId, message.content);
      if (!success) {
        dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
        toast.error(error || 'Failed to resend message');
      } else if (sentMessage?.messageId) {
        dispatch(finalizeSendingMessage({
          localMessageId: message.id,
          finalMessage: {
            ...message,
            id: sentMessage.messageId,
            timestamp: sentMessage.timestamp ?? Date.now(),
            messageSentStatus: messageSentStatus ?? 'online',
            localSendState: undefined,
          },
        }));
      }
    } catch (err) {
      dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
      toast.error(err instanceof Error ? err.message : 'Unexpected resend error');
    }
  };

  return <div className={`flex-1 overflow-y-auto p-6 space-y-2`}>
    {showEmptyState && (
      <div className="w-full flex justify-center items-center h-full">
        <div className="text-center max-w-md">
          {isTrustedOutOfBand ? (
            <>
              <div className="text-muted-foreground text-sm mb-2">
                Created chat with trusted user {activeChat?.username}
              </div>
              <div className="text-muted-foreground text-xs">
                If {activeChat?.username || activeChat.peerId || "the other user"} imported your profile, you can start sending messages. <br />
                If {activeChat?.username || activeChat.peerId || "the other user"} did not import your profile, any messages you send will be lost.
              </div>
            </>
          ) : (
            <div className="text-muted-foreground text-sm">
              {activeChat?.blocked ? (
                <div className="text-muted-foreground text-sm mb-2">
                  You have blocked this user.
                </div>
              ) : (
                <div className="text-muted-foreground text-sm mb-2">
                  No messages yet. Say hi! 👋
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )}
    {isPending && <PendingNotifications senderUsername={messages[0].senderUsername} senderPeerId={messages[0].senderPeerId} />}
    {error && <div className="w-full flex justify-center">
      <div className="text-foreground relative text-center w-1/2 border p-6 rounded-lg border-warning/50 bg-warning/20" style={{ wordBreak: "break-word" }}>
        {error}
      </div>
    </div>}
    {messages.map((message, index) => {
      if (message.senderPeerId === previousSenderPeerId) {
        senderStreak += 1;
      } else {
        previousSenderPeerId = message.senderPeerId;
        senderStreak = 1;
      }

      const senderChanged =
        index === 0 || messages[index - 1].senderPeerId !== message.senderPeerId;
      const hasPendingSendState = !!message.localSendState;
      const showTimestamp =
        hasPendingSendState ||
        senderChanged ||
        message.timestamp - messages[index - 1].timestamp > SHOW_TIMESTAMP_INTERVAL;
      const showSenderLabel =
        message.senderPeerId !== myPeerId &&
        !!activeChat?.groupId &&
        (senderChanged || senderStreak % 10 === 0);
      const isSystemMessage = message.messageType === 'system';

      if (isSystemMessage) {
        const membershipInfoTooltip = getMembershipInfoTooltip(message);
        return (
          <div key={message.id} className="w-full flex flex-col items-center animate-fade-in">
            <div
              className="max-w-[80%] rounded-md px-3 py-1.5 bg-muted/50 text-muted-foreground text-xs text-center"
              style={{ wordBreak: "break-word" }}
            >
              {message.content}
            </div>
            <span className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
              {formatTimestampToHourMinute(message.timestamp)}
              {membershipInfoTooltip && (
                <span className="relative inline-flex items-center group">
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-full p-0.5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={membershipInfoTooltip}
                  >
                    <Info className="w-3 h-3" />
                  </button>
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-72 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-left text-[11px] text-popover-foreground shadow-md group-hover:block group-focus-within:block">
                    {membershipInfoTooltip}
                  </span>
                </span>
              )}
            </span>
          </div>
        );
      }

      return (
        <div
          key={message.id}
          className={`flex flex-col animate-fade-in ${message.senderPeerId === myPeerId || !!activePendingKeyExchange ? "items-end" : "items-start"}`}
        >
          {showSenderLabel &&
            <span className="text-xs text-muted-foreground font-mono">{message.senderUsername ?? message.senderPeerId}</span>
          }
          <div
            className={`max-w-[70%] rounded-lg px-4 py-2.5 ${message.senderPeerId === myPeerId || !!activePendingKeyExchange ? "bg-message-sent text-message-sent-foreground rounded-br-sm" : "bg-message-received text-message-received-foreground rounded-bl-sm"}`}
            style={{ wordBreak: "break-word" }}
          >
            {message.messageType === 'file' && message.fileName ? (
              <FileMessage
                fileId={message.id}
                chatId={message.chatId}
                fileName={message.fileName}
                fileSize={message.fileSize || 0}
                filePath={message.filePath}
                transferStatus={message.transferStatus || 'pending'}
                transferProgress={message.transferProgress}
                transferError={message.transferError}
                transferExpiresAt={message.transferExpiresAt}
                isFromCurrentUser={message.senderPeerId === myPeerId}
              />
            ) : (
              <p className="text-sm text-left leading-relaxed">{message.content}</p>
            )}
          </div>
          {showTimestamp && (
            <span className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
              {formatTimestampToHourMinute(message.timestamp)}
              {message.localSendState === 'sending' && (
                <>
                  <span>•</span>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Sending...</span>
                </>
              )}
              {message.localSendState === 'queued' && " • Queued for sending"}
              {message.localSendState === 'failed' && " • Failed to send"}
              {!message.localSendState && message.messageSentStatus === 'offline' && " • offline"}
              {message.localSendState === 'failed' && (
                <>
                  <span>•</span>
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => { void handleRetryFailedMessage(message); }}
                  >
                    Retry
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      );
    })}
    <div ref={messagesEndRef} />
  </div>
}
