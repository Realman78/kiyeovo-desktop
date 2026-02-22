import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWrapper from '../components/chat/ChatWrapper';
import { setChats, addChat, removePendingKeyExchange, setActiveChat, markOfflineFetched, updateFileTransferProgress, updateFileTransferStatus, updateFileTransferError, setPendingFileStatus, updateChat, setActivePendingKeyExchange, setOfflineFetchStatus } from '../state/slices/chatSlice';
import { removeContactAttempt, setActiveContactAttempt, addMessage, type Chat } from '../state/slices/chatSlice';
import { useToast } from '../components/ui/use-toast';
import type { RootState } from '../state/store';
import { useNotifications } from '../hooks/useNotifications';
import { store } from '../state/store';

export const Main = () => {
  const dispatch = useDispatch();
  const { toast } = useToast();
  const isConnected = useSelector((state: RootState) => state.user.connected);

  useNotifications();

  useEffect(() => {
    const unsubKeyExchangeFailed = window.kiyeovoAPI.onKeyExchangeFailed((data) => {
      if (data.error.includes("ended pushable")) {
        toast.error(`${data.username} went offline`);
      } else if (data.error.includes("No pending acceptance found")) {
        toast.error(data.error);
      } else if (data.error.includes("rejected")) {
        toast.error(`${data.username} rejected your contact request`);
      } else {
        toast.error(`Key exchange with ${data.username} failed or timed out`);
      }

      const currentState = store.getState();
      const wasViewingPending = currentState.chat.activePendingKeyExchange?.peerId === data.peerId;
      const wasViewingContact = currentState.chat.activeContactAttempt?.peerId === data.peerId;

      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId));

      if (wasViewingPending) {
        dispatch(setActivePendingKeyExchange(null));
      }
      if (wasViewingContact) {
        dispatch(setActiveContactAttempt(null));
      }
    });

    const unsubMessageReceived = window.kiyeovoAPI.onMessageReceived((data) => {
      console.log(`Message received`);
      console.log(data);
      const currentPeerId = store.getState().user.peerId;

      dispatch(addMessage({
        id: data.messageId,
        chatId: data.chatId,
        senderPeerId: data.senderPeerId,
        senderUsername: data.senderUsername,
        content: data.content,
        timestamp: data.timestamp,
        messageType: data.messageType || 'text',
        messageSentStatus: data.messageSentStatus,
        currentUserPeerId: currentPeerId,
        // File transfer fields (if present)
        fileName: data.fileName,
        fileSize: data.fileSize,
        filePath: data.filePath,
        transferStatus: data.transferStatus,
        transferProgress: data.transferProgress,
        transferError: data.transferError
      }));
    });

    // Group chat activated — receiver processed GROUP_WELCOME, update Redux so chat appears in sidebar
    const unsubGroupChatActivated = window.kiyeovoAPI.onGroupChatActivated((data) => {
      console.log(`[UI] Group chat activated: chatId=${data.chatId}`);
      const existing = store.getState().chat.chats.find(c => c.id === data.chatId);
      if (!existing) {
        // Chat may exist in DB but not in Redux yet (e.g. invite arrived while sidebar state was stale).
        // Upsert from DB so activation is reflected immediately without restart.
        void (async () => {
          try {
            const result = await window.kiyeovoAPI.getChatById(data.chatId);
            if (result.success && result.chat) {
              const dbChat = result.chat;
              const newChat: Chat = {
                id: dbChat.id,
                type: dbChat.type,
                name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
                peerId: dbChat.other_peer_id,
                lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
                lastMessageTimestamp: dbChat.last_message_timestamp
                  ? new Date(dbChat.last_message_timestamp).getTime()
                  : new Date(dbChat.updated_at).getTime(),
                unreadCount: 0,
                status: 'active',
                fetchedOffline: dbChat.type === 'group',
                isFetchingOffline: false,
                groupStatus: 'active',
              };
              dispatch(addChat(newChat));
            }
          } catch (error) {
            console.error(`[UI] Failed to upsert activated group chat ${data.chatId}:`, error);
          }
        })();
        return;
      }

      dispatch(updateChat({
        id: data.chatId,
        updates: { status: 'active', groupStatus: 'active' },
      }));
    });

    // Global listener for chat creation - always active regardless of UI state
    const unsubChatCreated = window.kiyeovoAPI.onChatCreated((data) => {
      console.log(`[UI] Chat created: ${data.chatId} for ${data.username} (peerId: ${data.peerId})`);

      // Read current state first so we can carry contact-attempt message into the new chat preview/UI.
      const currentState = store.getState();
      const sourceContactAttempt = currentState.chat.contactAttempts.find((attempt) => attempt.peerId === data.peerId);
      const sourcePendingExchange = currentState.chat.pendingKeyExchanges.find((pending) => pending.peerId === data.peerId);
      const initialMessage = sourceContactAttempt?.messageBody || sourceContactAttempt?.message || sourcePendingExchange?.messageContent || '';
      const now = Date.now();

      const newChat: Chat = {
        id: data.chatId,
        type: 'direct',
        name: data.username,
        peerId: data.peerId,
        lastMessage: initialMessage,
        lastMessageTimestamp: now,
        unreadCount: 0,
        status: 'active',
        justCreated: true,
        fetchedOffline: true,
        isFetchingOffline: false,
      };

      const wasViewingContact = currentState.chat.activeContactAttempt?.peerId === data.peerId;
      const wasViewingPending = currentState.chat.activePendingKeyExchange?.peerId === data.peerId;

      dispatch(addChat(newChat));
      if (initialMessage) {
        const currentPeerId = store.getState().user.peerId;
        dispatch(addMessage({
          id: `contact-attempt-${data.chatId}-${now}`,
          chatId: data.chatId,
          senderPeerId: data.peerId,
          senderUsername: data.username,
          content: initialMessage,
          timestamp: now,
          messageType: 'text',
          messageSentStatus: 'online',
          currentUserPeerId: currentPeerId
        }));
      }
      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId));

      // Auto-open chat if user was actively viewing this contact attempt or pending key exchange
      if (wasViewingContact || wasViewingPending) {
        dispatch(setActiveChat(data.chatId));
      }
    });

    // File transfer event listeners
    const unsubFileTransferProgress = window.kiyeovoAPI.onFileTransferProgress((data) => {
      console.log(`[UI] File transfer progress: ${data.current}/${data.total} for message ${data.messageId}`);
      dispatch(updateFileTransferProgress({
        messageId: data.messageId,
        progress: Math.floor((data.current / data.total) * 100),
        chatId: data.chatId,
        filename: data.filename,
        size: data.size
      }));
    });

    const unsubFileTransferComplete = window.kiyeovoAPI.onFileTransferComplete((data) => {
      console.log(`[UI] File transfer complete for message ${data.messageId}`);
      dispatch(updateFileTransferStatus({
        messageId: data.messageId,
        status: 'completed',
        filePath: data.filePath
      }));
      toast.success('File transfer completed');
    });

    const unsubFileTransferFailed = window.kiyeovoAPI.onFileTransferFailed((data) => {
      console.log(`[UI] File transfer failed for message ${data.messageId}: ${data.error}`);
      dispatch(updateFileTransferError({
        messageId: data.messageId,
        error: data.error
      }));
      toast.error(`File transfer failed: ${data.error}`);
    });

    const unsubPendingFileReceived = window.kiyeovoAPI.onPendingFileReceived((data) => {
      console.log(`[UI] Pending file received: ${data.filename} from ${data.senderUsername}`);
      const currentPeerId = store.getState().user.peerId;
      dispatch(addMessage({
        id: data.fileId,
        chatId: data.chatId,
        senderPeerId: data.senderId,
        senderUsername: data.senderUsername,
        content: `${data.filename} (${data.size} bytes)`,
        timestamp: Date.now(),
        messageType: 'file',
        messageSentStatus: 'online',
        currentUserPeerId: currentPeerId,
        fileName: data.filename,
        fileSize: data.size,
        transferStatus: 'pending',
        transferProgress: 0,
        transferExpiresAt: data.expiresAt
      }));
      dispatch(updateChat({
        id: data.chatId,
        updates: {
          lastMessage: `File offer: ${data.filename}`,
          lastMessageTimestamp: Date.now()
        }
      }));
      // Unread count is handled by addMessage reducer for non-active chats.
      dispatch(setPendingFileStatus({ chatId: data.chatId, hasPendingFile: true }));
      toast.info(`${data.senderUsername} wants to send you a file: ${data.filename}`);

      const msUntilExpire = Math.max(0, data.expiresAt - Date.now());
      setTimeout(() => {
        const state = store.getState();
        const message = state.chat.messages.find(m => m.id === data.fileId);
        if (message && message.transferStatus === 'pending') {
          dispatch(updateFileTransferStatus({
            messageId: data.fileId,
            status: 'expired',
            transferError: 'Offer expired'
          }));
          const hasOtherPending = state.chat.messages.some(m => m.chatId === data.chatId && m.id !== data.fileId && m.transferStatus === 'pending');
          dispatch(setPendingFileStatus({ chatId: data.chatId, hasPendingFile: hasOtherPending }));
        }
      }, msUntilExpire);
    });

    return () => {
      unsubKeyExchangeFailed();
      unsubMessageReceived();
      unsubGroupChatActivated();
      unsubChatCreated();
      unsubFileTransferProgress();
      unsubFileTransferComplete();
      unsubFileTransferFailed();
      unsubPendingFileReceived();
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
            name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
            peerId: dbChat.other_peer_id,
            lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
            lastMessageTimestamp: dbChat.last_message_timestamp
              ? new Date(dbChat.last_message_timestamp).getTime()
              : new Date(dbChat.updated_at).getTime(),
            unreadCount: 0,
            status: dbChat.status,
            fetchedOffline: dbChat.type === 'group', // Groups don't need offline fetch
            isFetchingOffline: false,
            blocked: dbChat.blocked,
            muted: dbChat.muted,
            groupStatus: dbChat.group_status,
          }));

          dispatch(setChats(mappedChats));

          // After loading chats, check for offline messages for top 10 most recent direct chats
          const directChats = mappedChats.filter((c: any) => c.type === 'direct');
          if (directChats.length > 0 && isConnected) {
            // Sort by most recent activity (latest message) and take top 10
            const sortedChats = [...directChats].sort((a: any, b: any) => b.lastMessageTimestamp - a.lastMessageTimestamp);
            const top10ChatIds = sortedChats.slice(0, 10).map((chat: any) => chat.id);

            console.log(`[UI] Checking offline messages for ${top10ChatIds.length} most recent chats (IDs: ${top10ChatIds.join(', ')})...`);
            top10ChatIds.forEach((chatId) => {
              dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));
            });
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
                  const refreshedChats = refreshResult.chats.map((dbChat: any) => ({
                    id: dbChat.id,
                    type: dbChat.type,
                    name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
                    username: dbChat.username,
                    peerId: dbChat.other_peer_id,
                    lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
                    lastMessageTimestamp: dbChat.last_message_timestamp
                      ? new Date(dbChat.last_message_timestamp).getTime()
                      : new Date(dbChat.updated_at).getTime(),
                    unreadCount: result.unreadFromChats.get(dbChat.id) ?? 0,
                    status: dbChat.status,
                    fetchedOffline: dbChat.type === 'group' || result.checkedChatIds.includes(dbChat.id),
                    isFetchingOffline: false,
                    blocked: dbChat.blocked,
                    muted: dbChat.muted,
                    groupStatus: dbChat.group_status,
                  }));
                  dispatch(setChats(refreshedChats));
                  console.log('[UI] Chats refreshed successfully');
                }
              } else if (!result.success) {
                console.error('[UI] Failed to check offline messages:', result.error);
                top10ChatIds.forEach((chatId) => {
                  dispatch(setOfflineFetchStatus({ chatId, isFetching: false }));
                });
              }
            } catch (error) {
              console.error('[UI] Failed to check offline messages:', error);
              top10ChatIds.forEach((chatId) => {
                dispatch(setOfflineFetchStatus({ chatId, isFetching: false }));
              });
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
  }, [dispatch, isConnected]);

  return (
    <div className='h-screen w-screen flex overflow-hidden'>
      <Sidebar />
      <div className='flex-1'>
        <ChatWrapper />
      </div>
    </div>
  )
}
