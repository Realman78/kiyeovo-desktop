import { type FC, useState, useEffect, useCallback } from 'react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'
import { type ContactAttempt } from './contact-attempts/ContactAttemptItem'
import { useDispatch, useSelector } from 'react-redux';
import { addContactAttempt, removeContactAttempt, setContactAttempts } from '../../state/slices/chatSlice'
import type { RootState } from '../../state/store'
import { ContactAttemptList } from './contact-attempts/ContactAttemptList'
import { PendingKeyExchangeList } from './pending-key-exchange/PendingKeyExchangeList'
import { setConnected, setRegistered, setUsername } from '../../state/slices/userSlice'

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
    // Pull current user state on mount (solves race condition)
    const checkUserState = async () => {
      const userState = await window.kiyeovoAPI.getUserState();
      if (userState.username && userState.isRegistered) {
        console.log('[UI] Restored username from state:', userState.username);
        dispatch(setUsername(userState.username));
        dispatch(setRegistered(true));
        dispatch(setConnected(true));
      }
    };
    checkUserState();

    // Also listen for future username restoration events
    const unsubscribe = window.kiyeovoAPI.onContactRequestReceived((data) => {
      console.log('[UI] Contact request received:', data);
      dispatch(addContactAttempt(data))
    });

    const restoreUnsubscribe = window.kiyeovoAPI.onRestoreUsername((username) => {
      console.log('[UI] Restore username:', username);
      dispatch(setUsername(username));
      dispatch(setRegistered(true));
      dispatch(setConnected(true));
    });

    return () => {
      unsubscribe();
      restoreUnsubscribe();
    };
  }, []);

  return (
    <div className='w-96 h-full bg-sidebar border-r border-sidebar-border flex flex-col'>
      <SidebarHeader />

      {contactAttempts.length > 0 && <ContactAttemptList isLoadingContactAttempts={isLoadingContactAttempts} contactAttemptsError={contactAttemptsError} handleContactAttemptExpired={handleContactAttemptExpired} />}
      <PendingKeyExchangeList />
      <ChatList />
      <SidebarFooter />
    </div>
  )
}

export default Sidebar