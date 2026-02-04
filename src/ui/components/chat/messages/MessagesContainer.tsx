import { useEffect, useRef, useState } from "react";
import { setMessages, updateChat, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { PendingNotifications } from "./PendingNotifications";
import { FileMessage } from "./FileMessage";
import type { MessageSentStatus } from "../../../types";

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
                ? msg.timestamp.getTime() + 30 * 1000
                : undefined;

            return {
              id: msg.id,
              chatId: msg.chat_id,
              senderPeerId: msg.sender_peer_id,
              senderUsername: msg.sender_username || 'UNKNOWN',
              content: msg.content,
              timestamp: msg.timestamp.getTime(),
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
                If {activeChat?.username || activeChat.peerId || "the other user" } imported your profile, you can start sending messages. <br />
                If {activeChat?.username || activeChat.peerId || "the other user" } did not import your profile, any messages you send will be lost.
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
      const showTimestamp =
        index === 0 ||
        messages[index - 1].senderPeerId !== message.senderPeerId ||
        message.timestamp - messages[index - 1].timestamp > 15 * 60 * 1000;

      return (
        <div
          key={message.id}
          className={`flex flex-col animate-fade-in ${message.senderPeerId === myPeerId || !!activePendingKeyExchange ? "items-end" : "items-start"}`}
        >
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
            <span className="text-xs text-muted-foreground mt-1 font-mono">
              {formatTimestampToHourMinute(message.timestamp)}
              {message.messageSentStatus === 'offline' && " • offline"}
            </span>
          )}
        </div>
      );
    })}
    <div ref={messagesEndRef} />
  </div>
}
