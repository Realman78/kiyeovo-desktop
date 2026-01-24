import { useRef } from "react";
import type { ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";

type MessagesContainerProps = {
    messages: ChatMessage[];
}
export const MessagesContainer= ({ messages }: MessagesContainerProps) => {
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);

    return <div className="flex-1 overflow-y-auto p-6 space-y-4">
    {messages.map((message, index) => {
      const showTimestamp = 
        index === 0 || 
        messages[index - 1].senderPeerId !== message.senderPeerId ||
        message.timestamp - messages[index - 1].timestamp > 15 * 60 * 1000;

      return (
        <div
          key={message.id}
          className={`flex flex-col animate-fade-in ${message.senderPeerId === myPeerId ? "items-end" : "items-start"}`}
        >
          <div
            className={`max-w-[70%] rounded-lg px-4 py-2.5 ${message.senderPeerId === myPeerId ? "bg-message-sent text-message-sent-foreground rounded-br-sm" : "bg-message-received text-message-received-foreground rounded-bl-sm"}`}
          >
            <p className="text-sm leading-relaxed">{message.content}</p>
          </div>
          {showTimestamp && (
            <span className="text-xs text-muted-foreground mt-1 font-mono">
              {formatTimestampToHourMinute(message.timestamp)}
              {/* {message.sent && message.status === "read" && " • read"} */}
            </span>
          )}
        </div>
      );
    })}
    <div ref={messagesEndRef} />
  </div>
}
