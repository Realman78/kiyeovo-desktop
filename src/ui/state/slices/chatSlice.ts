import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ContactAttempt } from '../../components/sidebar/contact-attempts/ContactAttemptItem';
import type { MessageSentStatus } from '../../types';

// PendingKeyExchange is used for showing messages on the UI (Key Exchange) 
// that are sent, but not accepted by the recipient
export interface PendingKeyExchange {
  username: string;
  peerId: string;
  messageContent?: string;
  expiresAt: number;
}
export interface ChatMessage {
  id: string;
  chatId: number;
  senderPeerId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
  messageType: 'text' | 'file' | 'image' | 'system';
  messageSentStatus: MessageSentStatus;
  currentUserPeerId?: string; // For determining if message is from current user
  // File transfer fields
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  transferStatus?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'rejected';
  transferProgress?: number; // Percentage 0-100
  transferError?: string;
  transferExpiresAt?: number;
  localSendState?: 'queued' | 'sending' | 'failed';
}

export interface Chat {
  id: number;
  type: 'direct' | 'group';
  name: string;
  groupId?: string;
  peerId?: string; // optional because of potential group chats
  lastMessage: string;
  lastMessageTimestamp: number;
  unreadCount: number;
  status: 'active' | 'pending' | 'awaiting_acceptance';
  justCreated?: boolean; // Flag for newly created chats waiting for first message
  fetchedOffline?: boolean; // Whether offline messages have been checked for this chat
  isFetchingOffline?: boolean; // Whether offline messages are currently being fetched
  username?: string; // optional because of potential group chats
  trusted_out_of_band?: boolean; // Whether chat was established via out-of-band profile import
  muted?: boolean; // Whether notifications and sounds are muted for this chat
  blocked?: boolean; // Whether the other user is blocked
  hasPendingFile?: boolean; // Whether chat has a pending file request
  groupStatus?: string; // Group-specific status (invited_pending, active, etc.)
}

interface ChatState {
  chats: Chat[];
  contactAttempts: ContactAttempt[];
  activeChat: Chat | null;
  activeContactAttempt: ContactAttempt | null;
  activePendingKeyExchange: PendingKeyExchange | null;
  pendingKeyExchanges: PendingKeyExchange[];
  messages: ChatMessage[];
  loading: boolean;
}

const initialState: ChatState = {
  chats: [],
  contactAttempts: [],
  activeChat: null,
  activeContactAttempt: null,
  activePendingKeyExchange: null,
  pendingKeyExchanges: [],
  messages: [],
  loading: false,
};

const compareMessageOrder = (a: ChatMessage, b: ChatMessage): number => {
  return a.timestamp - b.timestamp;
};

const sortChatMessagesInPlace = (messages: ChatMessage[], chatId: number): void => {
  const chatIndexes: number[] = [];
  const chatMessages: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].chatId === chatId) {
      chatIndexes.push(i);
      chatMessages.push(messages[i]);
    }
  }

  if (chatMessages.length <= 1) return;
  chatMessages.sort(compareMessageOrder);

  for (let i = 0; i < chatIndexes.length; i++) {
    messages[chatIndexes[i]] = chatMessages[i];
  }
};

const getLastChatMessage = (messages: ChatMessage[], chatId: number, excludeId?: string): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.chatId !== chatId) continue;
    if (excludeId && msg.id === excludeId) continue;
    return msg;
  }
  return null;
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setActiveChat: (state, action: PayloadAction<number | null>) => {
      if (action.payload === null) {
        state.activeChat = null
        return
      }
      const chat = state.chats.find((c) => c.id === action.payload);
      if (chat) {
        chat.unreadCount = 0;
        state.activeContactAttempt = null;
        state.activePendingKeyExchange = null;
        state.activeChat = chat;
      }
    },
    // set active chat by using peer id from contact attempt
    setActiveContactAttempt: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null) {
        state.activeContactAttempt = null
        return
      }
      const contactAttempt = state.contactAttempts.find((ca) => ca.peerId === action.payload);
      if (contactAttempt) {
        state.activeChat = null;
        state.activePendingKeyExchange = null;
        state.activeContactAttempt = contactAttempt;
      }
    },
    setActivePendingKeyExchange: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null) {
        state.activePendingKeyExchange = null
        return
      }
      const pendingKeyExchange = state.pendingKeyExchanges.find((pk) => pk.peerId === action.payload);
      if (pendingKeyExchange) {
        state.activeChat = null;
        state.activeContactAttempt = null;
        state.activePendingKeyExchange = pendingKeyExchange;
      }
    },
    addMessage: (state, action: PayloadAction<ChatMessage>) => {
      const { chatId, id } = action.payload;
      const isFromCurrentUser = action.payload.currentUserPeerId &&
                                 action.payload.senderPeerId === action.payload.currentUserPeerId;
      let insertedOrUpdated = false;
      let shouldSortForChat = false;

      // Check if message already exists (prevent duplicates)
      const isDuplicate = state.messages.some(msg => msg.id === id);

      // Reconcile optimistic local message with authoritative sender-echo message.
      // Match only the currently in-flight local message ("sending") to avoid
      // ambiguity when same content is queued multiple times.
      if (!isDuplicate && isFromCurrentUser) {
        const pendingIndex = state.messages.findIndex((msg) =>
          msg.chatId === chatId &&
          msg.senderPeerId === action.payload.senderPeerId &&
          msg.content === action.payload.content &&
          msg.localSendState === 'sending' &&
          msg.id.startsWith('local-send-')
        );

        if (pendingIndex !== -1) {
          state.messages[pendingIndex] = {
            ...state.messages[pendingIndex],
            ...action.payload,
            localSendState: undefined,
          };
          insertedOrUpdated = true;
          shouldSortForChat = true; // replacement can shift timestamp/order
        } else {
          state.messages.push(action.payload);
          insertedOrUpdated = true;
        }
      } else if (isDuplicate) {
        console.log(`[Redux] Message ${id} already exists, skipping duplicate but updating chat metadata`);
      } else {
        // Only add to array if not duplicate
        state.messages.push(action.payload);
        insertedOrUpdated = true;
      }

      if (insertedOrUpdated) {
        const chat = state.chats.find((c) => c.id === chatId);
        const lastMessageBeforeInsert = getLastChatMessage(state.messages, chatId, id);
        const isOutOfOrder =
          !!lastMessageBeforeInsert && compareMessageOrder(lastMessageBeforeInsert, action.payload) > 0;

        if (chat?.isFetchingOffline || shouldSortForChat || isOutOfOrder) {
          sortChatMessagesInPlace(state.messages, chatId);
        }
      }

      // ALWAYS update chat metadata (even for duplicates)
      const chatIndex = state.chats.findIndex((c) => c.id === chatId);
      if (chatIndex !== -1) {
        const chat = state.chats[chatIndex];

        // Update chat properties
        chat.lastMessage = action.payload.content;
        chat.lastMessageTimestamp = action.payload.timestamp;

        // Clear justCreated flag when first message arrives
        if (chat.justCreated) {
          chat.justCreated = false;
        }

        // Only increment unread count if:
        // - Not a duplicate (already counted)
        // - Chat is not active
        // - Message is not from current user
        if (!isDuplicate && state.activeChat?.id !== chatId && !isFromCurrentUser) {
          chat.unreadCount += 1;
        }

        // Sort chats by lastMessageTimestamp (most recent first)
        state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
      }
    },
    removeMessageById: (state, action: PayloadAction<{ messageId: string; chatId: number }>) => {
      const { messageId, chatId } = action.payload;
      const initialLength = state.messages.length;
      state.messages = state.messages.filter((m) => m.id !== messageId);

      if (state.messages.length === initialLength) {
        return;
      }

      const chatIndex = state.chats.findIndex((c) => c.id === chatId);
      if (chatIndex !== -1) {
        const lastMessage = [...state.messages]
          .filter((m) => m.chatId === chatId)
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        if (lastMessage) {
          state.chats[chatIndex].lastMessage = lastMessage.content;
          state.chats[chatIndex].lastMessageTimestamp = lastMessage.timestamp;
        } else {
          state.chats[chatIndex].lastMessage = 'SYSTEM: No messages yet';
        }
      }
    },
    setChats: (state, action: PayloadAction<Chat[]>) => {
      state.chats = action.payload;
    },
    addChat: (state, action: PayloadAction<Chat>) => {
      state.chats.push(action.payload);
      state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
    },
    updateChat: (state, action: PayloadAction<{ id: number; updates: Partial<Chat> }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.id);
      if (chat) {
        Object.assign(chat, action.payload.updates);
        if (state.activeChat?.id === action.payload.id) {
          Object.assign(state.activeChat, action.payload.updates);
        }
        if (action.payload.updates.lastMessageTimestamp !== undefined) {
          state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
        }
      }
    },
    removeChat: (state, action: PayloadAction<number>) => {
      state.chats = state.chats.filter((chat) => chat.id !== action.payload);
      delete state.messages[action.payload];
      if (state.activeChat?.id === action.payload) {
        state.messages = [];
        state.activeChat = null;
      }
    },
    // clear messages for a specific chat
    clearMessages: (state, action: PayloadAction<number>) => {
      state.messages = state.messages.filter((m) => m.chatId !== action.payload);
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    setContactAttempts: (state, action: PayloadAction<ContactAttempt[]>) => {
      state.contactAttempts = action.payload
    },
    addContactAttempt: (state, action: PayloadAction<ContactAttempt>) => {
      state.contactAttempts.push(action.payload)
    },
    removeContactAttempt: (state, action: PayloadAction<string>) => {
      state.contactAttempts = state.contactAttempts.filter((ca) => ca.peerId !== action.payload);
      if (state.activeContactAttempt?.peerId === action.payload) {
        state.activeContactAttempt = null;
      }
    },
    setMessages: (state, action: PayloadAction<ChatMessage[]>) => {
      state.messages = [...action.payload].sort(compareMessageOrder);
    },
    setPendingKeyExchanges: (state, action: PayloadAction<PendingKeyExchange[]>) => {
      state.pendingKeyExchanges = action.payload;
    },
    addPendingKeyExchange: (state, action: PayloadAction<PendingKeyExchange>) => {
      state.pendingKeyExchanges.push(action.payload);
    },
    removePendingKeyExchange: (state, action: PayloadAction<string>) => {
      state.pendingKeyExchanges = state.pendingKeyExchanges.filter((pk) => pk.peerId !== action.payload);
      if (state.activePendingKeyExchange?.peerId === action.payload) {
        state.activePendingKeyExchange = null;
      }
    },
    setOfflineFetchStatus: (state, action: PayloadAction<{ chatId: number; isFetching: boolean }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.chatId);
      if (chat) {
        chat.isFetchingOffline = action.payload.isFetching;
      }
    },
    markOfflineFetched: (state, action: PayloadAction<number | number[]>) => {
      const chatIds = Array.isArray(action.payload) ? action.payload : [action.payload];
      chatIds.forEach(chatId => {
        const chat = state.chats.find((c) => c.id === chatId);
        if (chat) {
          chat.fetchedOffline = true;
          chat.isFetchingOffline = false;
        }
      });
    },
    // File transfer actions
    updateFileTransferProgress: (state, action: PayloadAction<{ messageId: string; progress: number; chatId: number; filename: string; size: number }>) => {
      let message = state.messages.find((m) => m.id === action.payload.messageId);
      if (!message) {
        message = state.messages.find((m) =>
          m.chatId === action.payload.chatId &&
          m.messageType === 'file' &&
          m.fileName === action.payload.filename &&
          (m.transferStatus === 'pending' || m.transferStatus === 'in_progress')
        );
        if (message) {
          message.id = action.payload.messageId;
        }
      }
      if (message) {
        message.fileName = action.payload.filename;
        message.fileSize = action.payload.size;
        message.transferProgress = action.payload.progress;
        if (message.transferStatus === 'pending') {
          message.transferStatus = 'in_progress';
        }
      }
    },
    updateFileTransferStatus: (state, action: PayloadAction<{
      messageId: string;
      status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'rejected';
      filePath?: string;
      transferError?: string;
    }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.transferStatus = action.payload.status;
        if (action.payload.status === 'completed' && action.payload.filePath) {
          message.filePath = action.payload.filePath;
        }
        if (action.payload.status === 'completed') {
          message.transferProgress = 100;
        }
        if (action.payload.transferError) {
          message.transferError = action.payload.transferError;
        }
      }
    },
    updateFileTransferError: (state, action: PayloadAction<{ messageId: string; error: string }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.transferStatus = 'failed';
        message.transferError = action.payload.error;
      }
    },
    updateLocalMessageSendState: (state, action: PayloadAction<{ messageId: string; state: 'queued' | 'sending' | 'failed' }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.localSendState = action.payload.state;
      }
    },
    setPendingFileStatus: (state, action: PayloadAction<{ chatId: number; hasPendingFile: boolean }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.chatId);
      if (chat) {
        chat.hasPendingFile = action.payload.hasPendingFile;
      }
    },
  },
});

export const {
  setActiveChat,
  setActiveContactAttempt,
  setActivePendingKeyExchange,
  addMessage,
  setChats,
  addChat,
  updateChat,
  removeChat,
  clearMessages,
  setLoading,
  setContactAttempts,
  addContactAttempt,
  removeContactAttempt,
  setMessages,
  setPendingKeyExchanges,
  addPendingKeyExchange,
  removePendingKeyExchange,
  setOfflineFetchStatus,
  markOfflineFetched,
  updateFileTransferProgress,
  updateFileTransferStatus,
  updateFileTransferError,
  updateLocalMessageSendState,
  setPendingFileStatus,
  removeMessageById
} = chatSlice.actions;

export default chatSlice.reducer;
