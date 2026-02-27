import { useState, type FC } from "react";
import { Input } from "../../ui/Input";
import { Search } from "lucide-react";
import { ChatPreview } from "./ChatPreview";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { setActiveChat, setOfflineFetchStatus, markOfflineFetched } from "../../../state/slices/chatSlice";
import { EmptyChatList } from "./EmptyChatList";

export const ChatList: FC = () => {
    const [searchQuery, setSearchQuery] = useState("");
    const chats = useSelector((state: RootState) => state.chat.chats);
    const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts);
    const selectedChatId = useSelector((state: RootState) => state.chat.activeChat);
    const isConnected = useSelector((state: RootState) => state.user.connected);
    const dispatch = useDispatch();

    const onSelectChat = async (chatId: number) => {
        dispatch(setActiveChat(chatId));

        // Check if we need to fetch offline messages for this chat
        // Skip offline message fetching for blocked chats
        const chat = chats.find(c => c.id === chatId);
        if (chat && !chat.fetchedOffline && !chat.isFetchingOffline && !chat.blocked) {
            if (!isConnected) {
                return;
            }
            console.log(`[UI] Fetching offline messages for chat ${chatId}...`);
            dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));

            try {
                const result = chat.type === 'group'
                    ? await window.kiyeovoAPI.checkGroupOfflineMessagesForChat(chatId)
                    : await window.kiyeovoAPI.checkOfflineMessagesForChat(chatId);
                if (result.success && result.checkedChatIds.length > 0) {
                    console.log(`[UI] Offline messages fetched for chat(s): ${result.checkedChatIds.join(', ')}`);
                    dispatch(markOfflineFetched(result.checkedChatIds));
                    // Messages will be added via onMessageReceived event
                } else {
                    console.log(`[UI] No offline messages for chat ${chatId}`);
                    dispatch(markOfflineFetched(chatId));
                }
            } catch (error) {
                console.error(`[UI] Failed to fetch offline messages for chat ${chatId}:`, error);
                // Still mark as fetched to avoid retry loops on error
                dispatch(markOfflineFetched(chatId));
            }
        }
    }

    const activeChats = chats.filter((chat) => {
        if (chat.status !== 'pending') return true;
        return chat.type === 'group' && chat.groupStatus === 'awaiting_activation';
    });
    const hasNoConversations = activeChats.length === 0 && contactAttempts.length === 0;

    return (
        <div className="flex flex-col flex-1 overflow-y-auto">
            {!hasNoConversations && (
                <div className="p-4 pt-0 border-b border-sidebar-border">
                    <Input
                        placeholder="Search conversations..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        icon={<Search className="w-4 h-4" />}
                        className="bg-sidebar-accent border-sidebar-border"
                    />
                </div>
            )}
            <div className="flex flex-col flex-1 overflow-y-auto">
                {hasNoConversations ? (
                    <EmptyChatList />
                ) : (
                    activeChats.map((chat) => (
                        <ChatPreview key={chat.id} chat={chat} onSelectChat={onSelectChat} selectedChatId={selectedChatId?.id ?? null} />
                    ))
                )}
            </div>
        </div>
    );
}
