import type { FC } from "react";
import type { Chat } from "../../../state/slices/chatSlice";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { Ban, BellOff } from "lucide-react";

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
                        {formatTimestampToHourMinute(chat.lastMessageTimestamp)}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground truncate flex-1">
                        {chat.lastMessage || "SYSTEM: No messages yet"}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        {chat.muted && (
                            <BellOff className="w-4 h-4 text-muted-foreground" />
                        )}
                        {chat.isFetchingOffline && !chat.blocked && (
                            <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" title="Checking for offline messages..." />
                        )}
                        {!chat.fetchedOffline && !chat.isFetchingOffline && !chat.blocked && (
                            <div className="w-2 h-2 rounded-full bg-yellow-500" title="Offline messages not checked" />
                        )}
                        {chat.unreadCount > 0 && (
                            <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs font-mono font-bold flex items-center justify-center">
                                {chat.unreadCount}
                            </div>
                        )}
                        {chat.blocked && (
                            <Ban className="w-4 h-4 text-destructive" />
                        )}
                    </div>
                </div>
            </div>
        </button>
    );
}
