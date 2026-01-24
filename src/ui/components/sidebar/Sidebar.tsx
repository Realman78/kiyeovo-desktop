import { type FC, useState, useEffect, useCallback } from 'react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'
import { ContactAttemptItem, type ContactAttempt } from './ContactAttemptItem'

export const Sidebar: FC = () => {
  const [contactAttempts, setContactAttempts] = useState<ContactAttempt[]>([]);
  const [isLoadingContactAttempts, setIsLoadingContactAttempts] = useState(true);
  const [contactAttemptsError, setContactAttemptsError] = useState<string | null>(null);

  const handleContactAttemptExpired = useCallback((peerId: string) => {
    setContactAttempts(prev => prev.filter(attempt => attempt.peerId !== peerId));
  }, []);

  useEffect(() => {
    const fetchContactAttempts = async () => {
      setIsLoadingContactAttempts(true);
      setContactAttemptsError(null);

      try {
        const result = await window.kiyeovoAPI.getContactAttempts();
        console.log('[UI] Contact attempts:', result);
        if (result.success) {
          setContactAttempts(result.contactAttempts as ContactAttempt[]);
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

      const newAttempt: ContactAttempt = {
        peerId: data.senderPeerId,
        username: data.senderUsername,
        message: data.message,
        messageBody: data.messageBody,
        receivedAt: Date.now(),
        expiresAt: data.expiresAt
      };

      setContactAttempts(prev => {
        const exists = prev.some(a => a.peerId === newAttempt.peerId);
        if (exists) {
          return prev;
        }
        return [...prev, newAttempt];
      });
    });

    return () => unsubscribe();
  }, []);

  const handleContactAttemptClick = (attempt: ContactAttempt) => {
    // TODO: When clicked, this should open the contact request in the main chat area
    // For now, just log it
    console.log('[UI] Contact attempt clicked:', attempt);
  };

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
                onClick={() => handleContactAttemptClick(attempt)}
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