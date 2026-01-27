import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ContactAttempt } from '../../components/sidebar/contact-attempts/ContactAttemptItem';

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
}

export interface Chat {
  id: number;
  type: 'direct' | 'group';
  name: string;
  peerId?: string; // optional because of potential group chats
  lastMessage: string;
  lastMessageTimestamp: number;
  unreadCount: number;
  status: 'active' | 'pending' | 'awaiting_acceptance';
  justCreated?: boolean; // Flag for newly created chats waiting for first message
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
      const { chatId } = action.payload;
      state.messages.push(action.payload);

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
        
        if (state.activeChat?.id !== chatId) {
          chat.unreadCount += 1;
        }
        
        // Move to top only if not already there
        if (chatIndex > 0) {
          state.chats.splice(chatIndex, 1);
          state.chats.unshift(chat);
        }
      }
    },
    setChats: (state, action: PayloadAction<Chat[]>) => {
      state.chats = action.payload;
    },
    addChat: (state, action: PayloadAction<Chat>) => {
      state.chats.push(action.payload);
    },
    updateChat: (state, action: PayloadAction<{ id: number; updates: Partial<Chat> }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.id);
      if (chat) {
        Object.assign(chat, action.payload.updates);
        if (state.activeChat?.id === action.payload.id) {
          Object.assign(state.activeChat, action.payload.updates);
        }
      }
    },
    removeChat: (state, action: PayloadAction<number>) => {
      state.chats = state.chats.filter((chat) => chat.id !== action.payload);
      delete state.messages[action.payload];
      if (state.activeChat?.id === action.payload) {
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
      state.messages = action.payload;
    },
    setPendingKeyExchanges: (state, action: PayloadAction<PendingKeyExchange[]>) => {
      state.pendingKeyExchanges = action.payload;
    },
    addPendingKeyExchange: (state, action: PayloadAction<PendingKeyExchange>) => {
      state.pendingKeyExchanges.push(action.payload);
    },
    removePendingKeyExchange: (state, action: PayloadAction<string>) => {
      state.pendingKeyExchanges = state.pendingKeyExchanges.filter((pk) => pk.peerId !== action.payload);
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
  removePendingKeyExchange
} = chatSlice.actions;

export default chatSlice.reducer;
