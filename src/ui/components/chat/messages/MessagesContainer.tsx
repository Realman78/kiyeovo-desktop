import { useCallback, useEffect, useRef, useState } from "react";
import { finalizeSendingMessage, prependMessages, setMessages, updateChat, updateLocalMessageSendState, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { PendingNotifications } from "./PendingNotifications";
import { MessageRow } from "./MessageRow";
import type { MessageSentStatus } from "../../../types";
import { FILE_ACCEPTANCE_TIMEOUT, INITIAL_MESSAGES_LIMIT, LOAD_MORE_MESSAGES_LIMIT, SHOW_TIMESTAMP_INTERVAL } from "../../../constants";
import { useToast } from "../../ui/use-toast";
import type { Message } from "../../../../core/lib/db/database";

type MessagesContainerProps = {
  messages: ChatMessage[];
  isPending: boolean;
}

function mapDbMessage(msg: Message & { sender_username?: string }): ChatMessage {
  let fileName = msg.file_name;
  let fileSize = msg.file_size;
  if (msg.message_type === 'file' && (!fileName || fileSize === undefined)) {
    const match = msg.content?.match(/^(.*)\s+\((\d+)\s+bytes\)$/);
    if (match) {
      fileName = fileName || match[1];
      if (fileSize === undefined) fileSize = Number(match[2]);
    }
  }
  const inferredTransferStatus =
    msg.transfer_status ??
    (msg.message_type === 'file' ? 'completed' : undefined);

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
    fileName,
    fileSize,
    filePath: msg.file_path,
    transferStatus: inferredTransferStatus as 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'rejected' | undefined,
    transferProgress: msg.transfer_progress,
    transferError: msg.transfer_error,
    transferExpiresAt
  };
}

export const MessagesContainer = ({ messages, isPending }: MessagesContainerProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const skipNextAutoScrollRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const activeChatIdRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const dispatch = useDispatch();
  const { toast } = useToast();

  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const showEmptyState = !isPending && messages.length === 0;

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
    return `${message.content} at ${formatTimestampToHourMinute(message.eventTimestamp)}.${normalized.includes('joined the group') ? ' This member can only see your messages after this system message, not strictly after the join time.' : ''}`;
  };

  // Initial fetch
  useEffect(() => {
    const chatId = activeChat?.id ?? null;
    activeChatIdRef.current = chatId;
    loadTokenRef.current += 1;
    const requestToken = loadTokenRef.current;
    setError(null);
    setHasMore(true);
    setIsLoadingMore(false);
    isLoadingMoreRef.current = false;
    offsetRef.current = 0;

    const fetchMessages = async () => {
      if (!chatId) return;
      const result = await window.kiyeovoAPI.getMessages(chatId, INITIAL_MESSAGES_LIMIT, 0);
      if (loadTokenRef.current !== requestToken || activeChatIdRef.current !== chatId) {
        return;
      }
      if (result.success) {
        const mapped = result.messages.map(mapDbMessage);
        dispatch(setMessages(mapped));
        offsetRef.current = mapped.length;
        setHasMore(mapped.length >= INITIAL_MESSAGES_LIMIT);
      } else {
        setError(result.error || 'Failed to fetch messages');
      }
    }
    void fetchMessages();
  }, [activeChat?.id, dispatch]);

  // Load more on scroll to top
  const loadMore = useCallback(async () => {
    const chatId = activeChat?.id;
    if (!chatId || isLoadingMoreRef.current || !hasMore) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const requestToken = loadTokenRef.current;
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    try {
      const result = await window.kiyeovoAPI.getMessages(chatId, LOAD_MORE_MESSAGES_LIMIT, offsetRef.current);
      if (loadTokenRef.current !== requestToken || activeChatIdRef.current !== chatId) {
        return;
      }
      if (result.success) {
        const mapped = result.messages.map(mapDbMessage);
        if (mapped.length > 0) {
          skipNextAutoScrollRef.current = true;
          dispatch(prependMessages(mapped));
          offsetRef.current += mapped.length;

          // Restore scroll position after DOM update
          requestAnimationFrame(() => {
            if (container) {
              const newScrollHeight = container.scrollHeight;
              container.scrollTop = newScrollHeight - prevScrollHeight;
            }
          });
        }
        if (mapped.length < LOAD_MORE_MESSAGES_LIMIT) {
          setHasMore(false);
        }
      }
    } catch (err) {
      console.error('[MessagesContainer] Failed to load more messages:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [activeChat?.id, hasMore, dispatch]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasMore || isLoadingMoreRef.current) return;
    const thresholdPx = Math.min(120, Math.max(24, container.clientHeight * 0.08));
    if (container.scrollTop <= thresholdPx) {
      console.log("LOADING MORE")
      void loadMore();
    }
  }, [hasMore, loadMore]);

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
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const isTrustedOutOfBand = activeChat?.trusted_out_of_band;
  let previousSenderPeerId: string | null = null;
  let senderStreak = 0;

  const handleRetryFailedMessage = useCallback(async (message: ChatMessage) => {
    if (!activeChat) return;
    const retryBlockedByRekeyCooldown =
      message.failedReason === 'group_rekeying' &&
      !!message.retryAfterTs &&
      Date.now() < message.retryAfterTs;
    if (retryBlockedByRekeyCooldown) {
      const seconds = Math.ceil((message.retryAfterTs! - Date.now()) / 1000);
      toast.info(`Group is rekeying. Retry available in ${seconds}s.`);
      return;
    }
    dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'sending' }));

    try {
      if (activeChat.type === 'group') {
        const { success, error, warning, offlineBackupRetry, message: sentMessage, messageSentStatus } = await window.kiyeovoAPI.sendGroupMessage(
          activeChat.id,
          message.content,
          { rekeyRetryHint: message.failedReason === 'group_rekeying' },
        );
        if (!success) {
          const isRekeyFailure =
            (error || '').includes('is not active') &&
            activeChat.groupStatus === 'rekeying';
          dispatch(updateLocalMessageSendState({
            messageId: message.id,
            state: 'failed',
            failedReason: isRekeyFailure ? 'group_rekeying' : 'other',
            retryAfterTs: isRekeyFailure ? Date.now() + 30_000 : undefined,
          }));
          toast.error(error || 'Failed to resend group message');
          return;
        }
        if (warning && offlineBackupRetry) {
          toast.warningAction(
            warning,
            'Retry offline backup',
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
  }, [activeChat, dispatch, toast]);

  return <div ref={scrollContainerRef} onScroll={handleScroll} className={`flex-1 overflow-y-auto p-6 space-y-2`}>
    {/* Sentinel for loading older messages */}
    {hasMore && !showEmptyState && (
      <div className="flex justify-center py-2">
        {isLoadingMore && (
          <span className="text-xs text-muted-foreground">Loading older messages...</span>
        )}
      </div>
    )}
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
      const isSystemMessage = message.messageType === 'system';
      if (isSystemMessage) {
        // Break sender grouping across system events.
        previousSenderPeerId = null;
        senderStreak = 0;
      }

      const senderChanged =
        !isSystemMessage && (previousSenderPeerId === null || previousSenderPeerId !== message.senderPeerId);
      if (!isSystemMessage) {
        senderStreak = senderChanged ? 1 : senderStreak + 1;
        previousSenderPeerId = message.senderPeerId;
      }

      const hasPendingSendState = !!message.localSendState;
      const showTimestamp =
        hasPendingSendState ||
        senderChanged ||
        (index > 0 && message.timestamp - messages[index - 1].timestamp > SHOW_TIMESTAMP_INTERVAL);
      const showSenderLabel =
        !isSystemMessage &&
        message.senderPeerId !== myPeerId &&
        !!activeChat?.groupId &&
        (senderChanged || senderStreak % 10 === 0);
      return (
        <MessageRow
          key={message.id}
          message={message}
          myPeerId={myPeerId}
          hasActivePendingKeyExchange={!!activePendingKeyExchange}
          showSenderLabel={showSenderLabel}
          showTimestamp={showTimestamp}
          membershipInfoTooltip={getMembershipInfoTooltip(message)}
          onRetry={handleRetryFailedMessage}
        />
      );
    })}
    <div ref={messagesEndRef} />
  </div>
}
