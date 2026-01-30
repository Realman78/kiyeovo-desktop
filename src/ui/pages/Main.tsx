import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWrapper from '../components/chat/ChatWrapper';
import { setChats, addChat, removePendingKeyExchange, setActiveChat } from '../state/slices/chatSlice';
import { removeContactAttempt, setActiveContactAttempt, addMessage, type Chat } from '../state/slices/chatSlice';
import { useToast } from '../components/ui/use-toast';

export const Main = () => {
  const dispatch = useDispatch();
  const { toast } = useToast();

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
      console.log(`Message received in chat ${data.chatId} from ${data.senderUsername}`);

      dispatch(addMessage({
        id: data.messageId,
        chatId: data.chatId,
        senderPeerId: data.senderPeerId,
        senderUsername: data.senderUsername,
        content: data.content,
        timestamp: data.timestamp,
        messageType: 'text'
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
      };

      dispatch(addChat(newChat));
      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId)); // Remove from pending key exchanges
      dispatch(setActiveChat(data.chatId));
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

          const mappedChats = result.chats.map((dbChat: any) => ({
            id: dbChat.id,
            type: dbChat.type,
            name: dbChat.username || dbChat.name,
            peerId: dbChat.name,
            lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
            lastMessageTimestamp: dbChat.last_message_timestamp 
              ? new Date(dbChat.last_message_timestamp).getTime() 
              : new Date(dbChat.updated_at).getTime(),
            unreadCount: 0,
            status: dbChat.status,
          }));

          dispatch(setChats(mappedChats));
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
