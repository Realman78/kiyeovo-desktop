import { type FC, useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'
import { type ContactAttempt } from './contact-attempts/ContactAttemptItem'
import { useDispatch, useSelector } from 'react-redux';
import { addContactAttempt, removeContactAttempt, setContactAttempts } from '../../state/slices/chatSlice'
import type { RootState } from '../../state/store'
import { ContactAttemptList } from './contact-attempts/ContactAttemptList'
import { PendingKeyExchangeList } from './pending-key-exchange/PendingKeyExchangeList'
import { setConnected, setPeerId, setRegistered, setUsername } from '../../state/slices/userSlice'

export const Sidebar: FC = () => {
  const [isLoadingContactAttempts, setIsLoadingContactAttempts] = useState(true);
  const [contactAttemptsError, setContactAttemptsError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
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
      if (userState.peerId) {
        dispatch(setPeerId(userState.peerId));
      }
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
    <div className={`relative h-full bg-sidebar border-r border-sidebar-border flex flex-col transition-[width] duration-300 ease-in-out ${isCollapsed ? 'w-16' : 'w-96'}`}>
      <SidebarHeader collapsed={isCollapsed} />

      {!isCollapsed && contactAttempts.length > 0 && (
        <ContactAttemptList
          isLoadingContactAttempts={isLoadingContactAttempts}
          contactAttemptsError={contactAttemptsError}
          handleContactAttemptExpired={handleContactAttemptExpired}
        />
      )}
      {!isCollapsed && <PendingKeyExchangeList />}
      {!isCollapsed && <ChatList />}
      {isCollapsed && <div className="flex-1" />}
      <SidebarFooter collapsed={isCollapsed} />
      <button
        type="button"
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="absolute cursor-pointer top-1/2 right-0 -translate-y-1/2 translate-x-1/2 w-6 h-6 rounded-full border border-sidebar-border bg-sidebar-accent/70 hover:bg-sidebar-accent text-primary/80 hover:text-primary flex items-center justify-center transition-colors duration-200"
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </div>
  )
}

export default Sidebar
