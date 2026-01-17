import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

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
  lastMessage?: string;
  lastMessageTimestamp?: number;
  unreadCount: number;
  status: 'active' | 'pending';
}

interface ChatState {
  chats: Chat[];
  activeChat: number | null;
  messages: Record<string, ChatMessage[]>;
  loading: boolean;
}

const initialState: ChatState = {
  chats: [
    {
      id: 1,
      type: 'direct',
      name: 'Alice',
      lastMessage: 'Hey, how are you?',
      lastMessageTimestamp: Date.now() - 3600000,
      unreadCount: 2,
      status: 'active',
    },
    {
      id: 2,
      type: 'direct',
      name: 'Bob',
      lastMessage: 'See you tomorrow!',
      lastMessageTimestamp: Date.now() - 7200000,
      unreadCount: 0,
      status: 'active',
    },
    {
      id: 3,
      type: 'group',
      name: 'Team Chat',
      lastMessage: 'Meeting at 3pm',
      lastMessageTimestamp: Date.now() - 1800000,
      unreadCount: 5,
      status: 'active',
    },
  ],
  activeChat: null,
  messages: {
    [crypto.randomUUID()]: [
      {
        id: 'msg-1',
        chatId: 1,
        senderPeerId: 'alice-peer-id',
        senderUsername: 'Alice',
        content: 'Hey, how are you?',
        timestamp: Date.now() - 3600000,
        messageType: 'text',
      },
      {
        id: 'msg-2',
        chatId: 1,
        senderPeerId: 'alice-peer-id',
        senderUsername: 'Alice',
        content: 'Are you free later?',
        timestamp: Date.now() - 3500000,
        messageType: 'text',
      },
    ],
    [crypto.randomUUID()]: [
      {
        id: 'msg-3',
        chatId: 2,
        senderPeerId: 'bob-peer-id',
        senderUsername: 'Bob',
        content: 'See you tomorrow!',
        timestamp: Date.now() - 7200000,
        messageType: 'text',
      },
    ],
    [crypto.randomUUID()]: [
      {
        id: 'msg-4',
        chatId: 3,
        senderPeerId: 'charlie-peer-id',
        senderUsername: 'Charlie',
        content: 'Meeting at 3pm',
        timestamp: Date.now() - 1800000,
        messageType: 'text',
      },
    ],
  },
  loading: false,
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setActiveChat: (state, action: PayloadAction<number>) => {
      state.activeChat = action.payload;
      const chat = state.chats.find((c) => c.id === action.payload);
      if (chat) {
        chat.unreadCount = 0;
      }
    },
    addMessage: (state, action: PayloadAction<ChatMessage>) => {
      const { chatId } = action.payload;
      if (!state.messages[chatId]) {
        state.messages[chatId] = [];
      }
      state.messages[chatId].push(action.payload);

      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) {
        chat.lastMessage = action.payload.content;
        chat.lastMessageTimestamp = action.payload.timestamp;
        if (state.activeChat !== chatId) {
          chat.unreadCount += 1;
        }
      }
    },
    addChat: (state, action: PayloadAction<Chat>) => {
      state.chats.push(action.payload);
    },
    removeChat: (state, action: PayloadAction<number>) => {
      state.chats = state.chats.filter((chat) => chat.id !== action.payload);
      delete state.messages[action.payload];
      if (state.activeChat === action.payload) {
        state.activeChat = null;
      }
    },
    clearMessages: (state, action: PayloadAction<string>) => {
      state.messages[action.payload] = [];
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
  },
});

export const {
  setActiveChat,
  addMessage,
  addChat,
  removeChat,
  clearMessages,
  setLoading,
} = chatSlice.actions;

export default chatSlice.reducer;
