import { useState, useEffect, useRef, type FC } from "react";
import { Input } from "../../ui/Input";
import { Search } from "lucide-react";
import { ChatPreview } from "./ChatPreview";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { setActiveChat, setOfflineFetchStatus, markOfflineFetched, markOfflineFetchFailed } from "../../../state/slices/chatSlice";
import { EmptyChatList } from "./EmptyChatList";

export const ChatList: FC = () => {
    const [searchQuery, setSearchQuery] = useState("");
    const [matchingChatIds, setMatchingChatIds] = useState<Set<number> | null>(null);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRequestSeqRef = useRef(0);
    const chats = useSelector((state: RootState) => state.chat.chats);
    const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts);
    const selectedChatId = useSelector((state: RootState) => state.chat.activeChat);
    const isConnected = useSelector((state: RootState) => state.user.connected);
    const dispatch = useDispatch();

    useEffect(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

        const trimmed = searchQuery.trim();
        const requestSeq = ++searchRequestSeqRef.current;
        if (!trimmed) {
            setMatchingChatIds(null);
            return;
        }

        searchTimerRef.current = setTimeout(async () => {
            try {
                const result = await window.kiyeovoAPI.searchChats(trimmed);
                if (requestSeq !== searchRequestSeqRef.current) return;
                if (result.success) {
                    setMatchingChatIds(new Set(result.chatIds));
                } else {
                    setMatchingChatIds(new Set());
                }
            } catch (error) {
                if (requestSeq !== searchRequestSeqRef.current) return;
                setMatchingChatIds(new Set());
                console.error('[UI] Chat search failed:', error);
            }
        }, 300);

        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [searchQuery]);

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
                if (chat.type === 'group') {
                    const result = await window.kiyeovoAPI.checkGroupOfflineMessagesForChat(chatId);
                    if (result.success && (result.failedChatIds ?? []).includes(chatId)) {
                        console.log(`[UI] Offline fetch failed for group chat ${chatId}`);
                        dispatch(markOfflineFetchFailed(chatId));
                    } else if (result.success) {
                        if (result.checkedChatIds.length > 0) {
                            console.log(`[UI] Offline messages fetched for chat(s): ${result.checkedChatIds.join(', ')}`);
                        } else {
                            console.log(`[UI] No offline messages for chat ${chatId}`);
                        }
                        dispatch(markOfflineFetched(chatId));
                    } else {
                        console.log(`[UI] Offline fetch failed for chat ${chatId}`);
                        dispatch(markOfflineFetchFailed(chatId));
                    }
                } else {
                    const result = await window.kiyeovoAPI.checkOfflineMessagesForChat(chatId);
                    if (result.success) {
                        if (result.checkedChatIds.length > 0) {
                            console.log(`[UI] Offline messages fetched for chat(s): ${result.checkedChatIds.join(', ')}`);
                        } else {
                            console.log(`[UI] No offline messages for chat ${chatId}`);
                        }
                        dispatch(markOfflineFetched(chatId));
                    } else {
                        console.log(`[UI] Offline fetch failed for chat ${chatId}`);
                        dispatch(markOfflineFetchFailed(chatId));
                    }
                }
            } catch (error) {
                console.error(`[UI] Failed to fetch offline messages for chat ${chatId}:`, error);
                dispatch(markOfflineFetchFailed(chatId));
            }
        }
    }

    const activeChats = chats.filter((chat) => {
        if (chat.status !== 'pending') return true;
        return chat.type === 'group' && chat.groupStatus === 'awaiting_activation';
    });

    const filteredChats = matchingChatIds !== null
        ? activeChats.filter((chat) => matchingChatIds.has(chat.id))
        : activeChats;

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
                    filteredChats.map((chat) => (
                        <ChatPreview key={chat.id} chat={chat} onSelectChat={onSelectChat} selectedChatId={selectedChatId?.id ?? null} />
                    ))
                )}
            </div>
        </div>
    );
}
