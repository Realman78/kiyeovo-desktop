import type { FC } from "react";
import type { Chat } from "../../../state/slices/chatSlice";

type ChatPreviewProps = {
    chat: Chat;
    onSelectChat: (chatId: number) => void;
    selectedChatId: number | null;
}
export const ChatPreview: FC<ChatPreviewProps> = ({ chat, onSelectChat, selectedChatId }) => {
    return (
        <button
            key={chat.id}
            onClick={() => onSelectChat(chat.id)}
            className={`w-full p-3 cursor-pointer flex items-start gap-3 transition-colors text-left hover:bg-sidebar-accent ${selectedChatId === chat.id ? "bg-sidebar-accent border-l-2 border-primary" : ""}`}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-sm text-sidebar-foreground truncate">
                        {chat.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                        {chat.lastMessageTimestamp}
                    </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                    {chat.lastMessage}
                </p>
            </div>

            {/* Unread badge */}
            {/* {chat.unread > 0 && (
                  <div className="shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-mono flex items-center justify-center">
                    {chat.unread}
                  </div>
                )} */}
        </button>
    );
}
