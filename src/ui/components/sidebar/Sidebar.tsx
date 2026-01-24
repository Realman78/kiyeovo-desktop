import { type FC, useState, useEffect, useCallback } from 'react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'
import { ContactAttemptItem, type ContactAttempt } from './ContactAttemptItem'
import { useDispatch, useSelector } from 'react-redux';
import { addContactAttempt, removeContactAttempt, setContactAttempts } from '../../state/slices/chatSlice'
import type { RootState } from '../../state/store'

export const Sidebar: FC = () => {
  const [isLoadingContactAttempts, setIsLoadingContactAttempts] = useState(true);
  const [contactAttemptsError, setContactAttemptsError] = useState<string | null>(null);
  const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts)
  const dispatch = useDispatch();

  const handleContactAttemptExpired = useCallback((peerId: string) => {
    dispatch(removeContactAttempt(peerId))
  }, []);

  useEffect(() => {
    const fetchContactAttempts = async () => {
      setIsLoadingContactAttempts(true);
      setContactAttemptsError(null);

      try {
        const result = await window.kiyeovoAPI.getContactAttempts();
        console.log('[UI] Contact attempts:', result);
        if (result.success) {
          dispatch(setContactAttempts(result.contactAttempts as ContactAttempt[]));
        } else {
          setContactAttemptsError(result.error || 'Failed to fetch contact attempts');
        }
      } catch (error) {
        setContactAttemptsError(error instanceof Error ? error.message : 'Failed to fetch contact attempts');
      } finally {
        setIsLoadingContactAttempts(false);
      }
    };
    fetchContactAttempts();
  }, []);

  useEffect(() => {
    const unsubscribe = window.kiyeovoAPI.onContactRequestReceived((data) => {
      console.log('[UI] Contact request received:', data);
      dispatch(addContactAttempt(data))

      // const id = Math.random() * 1000000
      // // id will be a random number
      // dispatch(addChat({
      //   id,
      //   type: 'direct',
      //   name: data.username,
      //   peerId: data.peerId,
      //   lastMessage: data.messageBody ?? data.message,
      //   lastMessageTimestamp: data.receivedAt,
      //   unreadCount: 0,
      //   status: 'pending',
      // }));
      // dispatch(addMessage({
      //   id: crypto.randomUUID(),
      //   chatId: id,
      //   content: data.messageBody ?? data.message,
      //   messageType: 'text',
      //   senderPeerId: data.peerId,
      //   senderUsername: data.username,
      //   timestamp: data.receivedAt
      // }))
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className='w-96 h-full bg-sidebar border-r border-sidebar-border flex flex-col'>
      <SidebarHeader />

      {/* Contact Attempts Section */}
      {contactAttempts.length > 0 && (
        <div className="border-b border-sidebar-border mb-4">
          <div className="text-xs text-muted-foreground px-4 py-2 font-medium uppercase tracking-wider">
            Contact Requests
          </div>
          {isLoadingContactAttempts ? (
            <div className="text-center text-muted-foreground">Loading contact attempts...</div>
          ) : contactAttemptsError ? (
            <div className="text-center text-red-500">{contactAttemptsError}</div>
          ) : (
            contactAttempts.map(attempt => (
              <ContactAttemptItem
                key={attempt.peerId}
                attempt={attempt}
                onExpired={handleContactAttemptExpired}
              />
            ))
          )}
        </div>
      )}

      <ChatList />
      <SidebarFooter />
    </div>
  )
}

export default Sidebar