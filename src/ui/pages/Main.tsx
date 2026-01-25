import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWrapper from '../components/chat/ChatWrapper';
import { setChats } from '../state/slices/chatSlice';
import { removeContactAttempt, setActiveContactAttempt, addMessage } from '../state/slices/chatSlice';
import { useToast } from '../components/ui/use-toast';

export const Main = () => {
  const dispatch = useDispatch();
  const { toast } = useToast();

  useEffect(() => {
    const unsubKeyExchangeFailed = window.kiyeovoAPI.onKeyExchangeFailed((data) => {
      console.log(`Key exchange failed with ${data.username}: ${data.error}`);

      // Show error toast
      toast.error(`Key exchange with ${data.username} failed`);

      // Remove contact attempt from Redux
      dispatch(removeContactAttempt(data.peerId));

      // Clear active contact attempt if it was this one
      dispatch(setActiveContactAttempt(null));
    });

    const unsubMessageReceived = window.kiyeovoAPI.onMessageReceived((data) => {
      console.log(`Message received in chat ${data.chatId} from ${data.senderUsername}`);

      // Add message to Redux
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

    return () => {
      unsubKeyExchangeFailed();
      unsubMessageReceived();
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

          // Map database Chat to Redux Chat type
          const mappedChats = result.chats.map((dbChat: any) => ({
            id: dbChat.id,
            type: dbChat.type,
            name: dbChat.username || dbChat.name, // Use username for direct chats, fallback to name
            peerId: dbChat.name, // For direct chats, this is the peer's ID
            lastMessage: dbChat.last_message_content || 'No messages yet', // From database
            lastMessageTimestamp: dbChat.last_message_timestamp 
              ? new Date(dbChat.last_message_timestamp).getTime() 
              : new Date(dbChat.updated_at).getTime(), // Use last_message_timestamp if available, otherwise updated_at
            unreadCount: 0, // Will be calculated based on message read status later
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
