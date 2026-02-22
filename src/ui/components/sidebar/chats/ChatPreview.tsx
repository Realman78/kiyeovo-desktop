import type { FC } from "react";
import type { Chat } from "../../../state/slices/chatSlice";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { Ban, BellOff, Paperclip, Users } from "lucide-react";

type ChatPreviewProps = {
    chat: Chat;
    onSelectChat: (chatId: number) => void;
    selectedChatId: number | null;
}
export const ChatPreview: FC<ChatPreviewProps> = ({ chat, onSelectChat, selectedChatId }) => {
    const isAwaitingActivation = chat.type === 'group' && chat.groupStatus === 'awaiting_activation';
    const previewText = isAwaitingActivation
        ? 'Waiting for creator activation...'
        : (chat.lastMessage || "SYSTEM: No messages yet");

    return (
        <button
            key={chat.id}
            onClick={() => onSelectChat(chat.id)}
            className={`w-full p-3 cursor-pointer flex items-start gap-3 transition-colors text-left hover:bg-sidebar-accent ${selectedChatId === chat.id ? "bg-sidebar-accent border-l-2 border-primary" : ""}`}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-sm text-sidebar-foreground truncate flex items-center gap-1.5">
                        {chat.type === 'group' && <Users className="w-3.5 h-3.5 text-primary shrink-0" />}
                        <span className="truncate max-w-45">{chat.name}</span>
                        {isAwaitingActivation && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                                Awaiting Activation
                            </span>
                        )}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                        {formatTimestampToHourMinute(chat.lastMessageTimestamp)}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground truncate flex-1">
                        {previewText}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        {chat.muted && (
                            <BellOff className="w-4 h-4 text-muted-foreground" />
                        )}
                        {chat.hasPendingFile && (
                            <Paperclip className="w-4 h-4 text-primary"/>
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
