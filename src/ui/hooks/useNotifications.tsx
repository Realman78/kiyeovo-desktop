import { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../state/store';
import type { MessageReceivedEvent } from '../../core/types';
import type { ContactRequestEvent } from '../../core/types';
import { setActiveChat } from '../state/slices/chatSlice';
import { store } from '../state/store';

export const useNotifications = () => {
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const dispatch = useDispatch();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Initialize audio
    audioRef.current = new Audio('/sounds/notification2.mp3');

    // Listen for message received events
    const unsubscribeMessages = window.kiyeovoAPI.onMessageReceived(async (data: MessageReceivedEvent) => {
      // Don't notify for own messages
      if (data.senderPeerId === myPeerId) {
        return;
      }

      // Don't notify for messages in just-created chats (from accepted contact requests/key exchanges)
      const currentState = store.getState();
      const chat = currentState.chat.chats.find(c => c.id === data.chatId);
      if (chat?.justCreated) {
        return;
      }

      // Don't notify if chat is muted
      if (chat?.muted) {
        return;
      }

      // Play sound
      try {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      } catch (error) {
        console.error('Failed to play notification sound:', error);
      }

      // Show notification if window not focused
      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (!focused) {
          await window.kiyeovoAPI.showNotification({
            title: `New message from ${data.senderUsername}`,
            body: data.content,
            chatId: data.chatId,
          });
        }
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
    });

    // Listen for contact request events
    const unsubscribeContactRequests = window.kiyeovoAPI.onContactRequestReceived(async (data: ContactRequestEvent) => {
      // Play sound
      try {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      } catch (error) {
        console.error('Failed to play notification sound:', error);
      }

      // Show notification if window not focused
      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (!focused) {
          await window.kiyeovoAPI.showNotification({
            title: 'New Contact Request',
            body: `${data.username} wants to connect`,
          });
        }
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
    });

    // Listen for notification clicks
    const unsubscribeNotificationClick = window.kiyeovoAPI.onNotificationClicked((chatId: number) => {
      // Navigate to the chat
      dispatch(setActiveChat(chatId));
    });

    return () => {
      unsubscribeMessages();
      unsubscribeContactRequests();
      unsubscribeNotificationClick();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [myPeerId, dispatch]);
};
