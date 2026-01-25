import { useState, useRef, useEffect } from "react";
import { ChatHeader } from "./header/ChatHeader";
import { useSelector } from "react-redux";
import type { RootState } from "../../state/store";
import { MessagesContainer } from "./messages/MessagesContainer";
import { createPendingMessage } from "../../utils/general";
import { ChatInput } from "./input/ChatInput";
import { InvitationManager } from "./input/InvitationManager";
import { EmptyState } from "./messages/EmptyState";

interface Message {
  id: string;
  content: string;
  timestamp: string;
  sent: boolean;
  status?: "sending" | "sent" | "delivered" | "read";
}

interface ChatWrapperProps {
  //   chatName: string;
  //   chatOnline: boolean;
  //   messages: Message[];
  //   onSendMessage: (content: string) => void;
}

const ChatWrapper = ({

}: ChatWrapperProps) => {
  const [inputValue, setInputValue] = useState("");
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
  const messages = useSelector((state: RootState) => state.chat.messages);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  //   useEffect(() => {
  //     messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  //   }, [messages]);

  //   const handleSubmit = (e: React.FormEvent) => {
  //     e.preventDefault();
  //     if (inputValue.trim()) {
  //       onSendMessage(inputValue.trim());
  //       setInputValue("");
  //     }
  //   };

  useEffect(() => {
    console.log("activeChat :>> ", activeChat);
    console.log("messages :>> ", messages);
  }, [activeChat, messages]);

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {!activeChat && !activeContactAttempt ? (
        <EmptyState />
      ) : (
        <>
          <ChatHeader username={activeChat?.name ?? activeContactAttempt?.username ?? ''} peerId={activeChat?.peerId ?? activeContactAttempt?.peerId ?? ''} />
          <MessagesContainer
            messages={!!activeContactAttempt ?
              [createPendingMessage(activeContactAttempt.messageBody ?? activeContactAttempt.message, -78, activeContactAttempt.peerId, activeContactAttempt.username)]
              : messages.filter((m) => m.chatId === activeChat?.id) ?? []}
            isPending={!!activeContactAttempt}
          />
          {!!activeContactAttempt ? (
            <InvitationManager peerId={activeContactAttempt.peerId} />
          ) : <ChatInput />
          }
        </>
      )}
    </div>
  );
};

export default ChatWrapper;
