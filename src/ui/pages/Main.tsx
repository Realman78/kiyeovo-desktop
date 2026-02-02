import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWrapper from '../components/chat/ChatWrapper';
import { setChats, addChat, removePendingKeyExchange, setActiveChat, markOfflineFetched } from '../state/slices/chatSlice';
import { removeContactAttempt, setActiveContactAttempt, addMessage, type Chat } from '../state/slices/chatSlice';
import { useToast } from '../components/ui/use-toast';
import type { RootState } from '../state/store';
import { useNotifications } from '../hooks/useNotifications';
import { store } from '../state/store';

export const Main = () => {
  const dispatch = useDispatch();
  const { toast } = useToast();
  const myPeerId = useSelector((state: RootState) => state.user.peerId);

  useNotifications();

  useEffect(() => {
    const unsubKeyExchangeFailed = window.kiyeovoAPI.onKeyExchangeFailed((data) => {
      if (data.error.includes("ended pushable")) {
        toast.error(`${data.username} went offline`);
      } else if (data.error.includes("No pending acceptance found")) {
        toast.error(data.error);
      } else {
        toast.error(`Key exchange with ${data.username} failed or timed out`);
      }
      dispatch(removeContactAttempt(data.peerId));
      dispatch(setActiveContactAttempt(null));
    });

    const unsubMessageReceived = window.kiyeovoAPI.onMessageReceived((data) => {
      console.log(`Message received`);
      console.log(data);

      dispatch(addMessage({
        id: data.messageId,
        chatId: data.chatId,
        senderPeerId: data.senderPeerId,
        senderUsername: data.senderUsername,
        content: data.content,
        timestamp: data.timestamp,
        messageType: 'text',
        messageSentStatus: data.messageSentStatus,
        currentUserPeerId: myPeerId
      }));
    });

    // Global listener for chat creation - always active regardless of UI state
    const unsubChatCreated = window.kiyeovoAPI.onChatCreated((data) => {
      console.log(`[UI] Chat created: ${data.chatId} for ${data.username} (peerId: ${data.peerId})`);

      const newChat: Chat = {
        id: data.chatId,
        type: 'direct',
        name: data.username,
        peerId: data.peerId,
        lastMessage: '',
        lastMessageTimestamp: Date.now(),
        unreadCount: 0,
        status: 'active',
        justCreated: true,
        fetchedOffline: true,
        isFetchingOffline: false,
      };

      // Read current state to check if user was viewing this contact/pending
      const currentState = store.getState();
      const wasViewingContact = currentState.chat.activeContactAttempt?.peerId === data.peerId;
      const wasViewingPending = currentState.chat.activePendingKeyExchange?.peerId === data.peerId;

      dispatch(addChat(newChat));
      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId));

      // Auto-open chat if user was actively viewing this contact attempt or pending key exchange
      if (wasViewingContact || wasViewingPending) {
        dispatch(setActiveChat(data.chatId));
      }
    });

    return () => {
      unsubKeyExchangeFailed();
      unsubMessageReceived();
      unsubChatCreated();
    };
  }, [])

  useEffect(() => {
    const fetchChats = async () => {
      try {
        console.log('[UI] Fetching chats from database...');
        const result = await window.kiyeovoAPI.getChats();

        console.log('[UI] Chats:', result.chats);

        if (result.success) {
          console.log(`[UI] Loaded ${result.chats.length} chats`);

          const mappedChats = result.chats.filter((dbChat: any) => dbChat.other_peer_id !== undefined).map((dbChat: any) => ({
            id: dbChat.id,
            type: dbChat.type,
            name: dbChat.username || dbChat.name,
            peerId: dbChat.other_peer_id,
            lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
            lastMessageTimestamp: dbChat.last_message_timestamp
              ? new Date(dbChat.last_message_timestamp).getTime()
              : new Date(dbChat.updated_at).getTime(),
            unreadCount: 0,
            status: dbChat.status,
            fetchedOffline: false,
            isFetchingOffline: false,
            blocked: dbChat.blocked,
            muted: dbChat.muted,
          }));

          dispatch(setChats(mappedChats));

          // After loading chats, check for offline messages for top 10 most recent
          if (mappedChats.length > 0) {
            // Sort by most recent activity (latest message) and take top 10
            const sortedChats = [...mappedChats].sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
            const top10ChatIds = sortedChats.slice(0, 10).map(chat => chat.id);

            console.log(`[UI] Checking offline messages for ${top10ChatIds.length} most recent chats (IDs: ${top10ChatIds.join(', ')})...`);
            try {
              const result = await window.kiyeovoAPI.checkOfflineMessages(top10ChatIds);
              if (result.success && result.checkedChatIds.length > 0) {
                console.log(`[UI] Offline message check complete - checked ${result.checkedChatIds.length} chats (IDs: ${result.checkedChatIds.join(', ')})`);
                dispatch(markOfflineFetched(result.checkedChatIds));

                // Refresh chats to pick up new offline messages (unread counts, last message, etc.)
                console.log('[UI] Refreshing chats to show offline messages...');
                console.log(`[UI] Unread from chats: ${JSON.stringify(result.unreadFromChats)}`);
                const refreshResult = await window.kiyeovoAPI.getChats();
                if (refreshResult.success) {
                  const refreshedChats = refreshResult.chats.filter((dbChat: any) => dbChat.other_peer_id !== undefined).map((dbChat: any) => ({
                    id: dbChat.id,
                    type: dbChat.type,
                    name: dbChat.username || dbChat.name,
                    peerId: dbChat.other_peer_id,
                    lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
                    lastMessageTimestamp: dbChat.last_message_timestamp
                      ? new Date(dbChat.last_message_timestamp).getTime()
                      : new Date(dbChat.updated_at).getTime(),
                    unreadCount: result.unreadFromChats.get(dbChat.id) ?? 0,
                    status: dbChat.status,
                    fetchedOffline: result.checkedChatIds.includes(dbChat.id),
                    isFetchingOffline: false,
                    blocked: dbChat.blocked,
                    muted: dbChat.muted,
                  }));
                  dispatch(setChats(refreshedChats));
                  console.log('[UI] Chats refreshed successfully');
                }
              } else if (!result.success) {
                console.error('[UI] Failed to check offline messages:', result.error);
              }
            } catch (error) {
              console.error('[UI] Failed to check offline messages:', error);
            }
          }
        } else {
          console.error('[UI] Failed to fetch chats:', result.error);
        }
      } catch (error) {
        console.error('[UI] Error fetching chats:', error);
      }
    };

    fetchChats();
  }, [dispatch]);

  return (
    <div className='h-screen w-screen flex overflow-hidden'>
      <Sidebar />
      <div className='flex-1'>
        <ChatWrapper />
      </div>
    </div>
  )
}
