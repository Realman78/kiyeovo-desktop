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
import { getGroupCreatorLinkState, type GroupCreatorLinkState } from "../../utils/groupCreatorLinkHealth";

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
  const sendingMessages = useSelector((state: RootState) => state.chat.sendingMessages);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);

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
    if (!activeChat) return [];
    const persisted = messages.filter((m) => m.chatId === activeChat.id);
    const sending = sendingMessages.filter((m) => m.chatId === activeChat.id);
    return [...persisted, ...sending].sort((a, b) => a.timestamp - b.timestamp);
  }, [activePendingKeyExchange, activeContactAttempt, activeChat, messages, sendingMessages]);

  const FooterToDisplay = useMemo(() => {
    if (activeContactAttempt) {
      return <InvitationManager key={activeContactAttempt.peerId} peerId={activeContactAttempt.peerId} />
    }
    if (activePendingKeyExchange) {
      return <PendingKxManager peerId={activePendingKeyExchange.peerId} />
    }
    if (activeChat) {
      return <ChatInput />;
    }
    return null;
  }, [activePendingKeyExchange, activeContactAttempt, activeChat]);

  const groupCreatorLinkState = useMemo<GroupCreatorLinkState>(() => {
    if (!activeChat) return { broken: false };
    return getGroupCreatorLinkState(activeChat, chats, myPeerId);
  }, [activeChat, chats, myPeerId]);

  const creatorLabel = groupCreatorLinkState.creatorName
    ? `${groupCreatorLinkState.creatorName} (${groupCreatorLinkState.creatorPeerId})`
    : groupCreatorLinkState.creatorPeerId;

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {!activeChat && !activeContactAttempt && !activePendingKeyExchange ? (
        <EmptyState />
      ) : (
        <>
          <ChatHeader
            username={activeChat?.name ?? activeContactAttempt?.username ?? activePendingKeyExchange?.username ?? ''}
            peerId={activeChat?.peerId ?? activeContactAttempt?.peerId ?? activePendingKeyExchange?.peerId ?? ''}
            chatType={activeChat?.type}
            groupStatus={activeChat?.groupStatus}
            chatId={activeChat?.id}
          />
          {groupCreatorLinkState.broken && (
            <div className="mx-6 mb-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              You do not have a direct chat with {creatorLabel || 'the group creator'}, so you cannot receive future group updates.
              Existing messages may still work until the next group update.
              To fix this: make sure {groupCreatorLinkState.creatorName || 'the creator'} also deletes you, then establish a new conversation.
            </div>
          )}
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
