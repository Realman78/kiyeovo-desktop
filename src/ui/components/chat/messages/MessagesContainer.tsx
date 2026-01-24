import { useEffect, useRef, useState } from "react";
import { setActiveChat, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { Check, Copy } from "lucide-react";
import { TimeToRespond } from "./TimeToRespond";

type MessagesContainerProps = {
  messages: ChatMessage[];
  isPending: boolean;
}
export const MessagesContainer = ({ messages, isPending }: MessagesContainerProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);

  const [isCopied, setIsCopied] = useState(false);
  
  const handleCopyPeerId = () => {
    setIsCopied(true);
    navigator.clipboard.writeText(messages[0].senderPeerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  

  return <div className={`flex-1 overflow-y-auto p-6 space-y-4`}>
    {isPending && <div className="w-full flex justify-center">
      <div className="text-foreground relative text-center w-1/2 border p-6 rounded-lg border-warning/50 bg-warning/20" style={{ wordBreak: "break-word" }}>
        <div onClick={handleCopyPeerId} className="absolute right-2 top-2 cursor-pointer hover:text-foreground/80">
          {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </div>
        User <b>{messages[0].senderUsername}</b> with Peer ID <b onClick={handleCopyPeerId} className="cursor-pointer hover:text-foreground/80">{messages[0].senderPeerId}</b> has requested to contact you.
      </div>
    </div>}
    {isPending && activeContactAttempt?.expiresAt && <TimeToRespond expiresAt={activeContactAttempt.expiresAt} />}
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
