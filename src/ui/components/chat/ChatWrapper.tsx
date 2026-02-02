import { useEffect, useMemo } from "react";
import { ChatHeader } from "./header/ChatHeader";
import { useSelector } from "react-redux";
import type { RootState } from "../../state/store";
import { MessagesContainer } from "./messages/MessagesContainer";
import { createPendingMessage } from "../../utils/general";
import { ChatInput } from "./input/ChatInput";
import { InvitationManager } from "./input/InvitationManager";
import { EmptyState } from "./messages/EmptyState";
import { PendingKxManager } from "./input/PendingKxManager";

interface ChatWrapperProps {
  //   chatName: string;
  //   chatOnline: boolean;
  //   messages: Message[];
  //   onSendMessage: (content: string) => void;
}

const ChatWrapper = ({

}: ChatWrapperProps) => {
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const messages = useSelector((state: RootState) => state.chat.messages);

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
    console.log("activeContactAttempt :>> ", activeContactAttempt);
    console.log("activePendingKeyExchange :>> ", activePendingKeyExchange);
    console.log("messages :>> ", messages);
  }, [activeChat, activeContactAttempt, activePendingKeyExchange, messages]);

  const messagesToDisplay = useMemo(() => {
    if (activeContactAttempt) {
      return [createPendingMessage(activeContactAttempt.messageBody ?? activeContactAttempt.message, -78, activeContactAttempt.peerId, activeContactAttempt.username)]
    }
    if (activePendingKeyExchange) {
      return [createPendingMessage(activePendingKeyExchange.messageContent ?? "Message not found.", -78, activePendingKeyExchange.peerId, activePendingKeyExchange.username)]
    }
    return activeChat ? messages.filter((m) => m.chatId === activeChat?.id) ?? [] : [];
  }, [activePendingKeyExchange, activeContactAttempt, activeChat, messages]);

  const FooterToDisplay = useMemo(() => {
    if (activeContactAttempt) {
      return <InvitationManager peerId={activeContactAttempt.peerId} />
    }
    if (activePendingKeyExchange) {
      return <PendingKxManager peerId={activePendingKeyExchange.peerId} />
    }
    if (activeChat) {
      return <ChatInput />;
    }
    return null;
  }, [activePendingKeyExchange, activeContactAttempt, activeChat]);

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {!activeChat && !activeContactAttempt && !activePendingKeyExchange ? (
        <EmptyState />
      ) : (
        <>
          <ChatHeader username={activeChat?.name ?? activeContactAttempt?.username ?? activePendingKeyExchange?.username ?? ''} peerId={activeChat?.peerId ?? activeContactAttempt?.peerId ?? activePendingKeyExchange?.peerId ?? ''} />
          <MessagesContainer
            messages={messagesToDisplay}
            isPending={!!activeContactAttempt || !!activePendingKeyExchange}
          />
          {FooterToDisplay}
        </>
      )}
    </div>
  );
};

export default ChatWrapper;
