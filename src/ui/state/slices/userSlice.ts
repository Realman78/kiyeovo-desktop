import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// Slice for your own user
export interface User {
  peerId: string;
  connected: boolean | null;
  registered: boolean;
  username?: string;
  torEnabled: boolean;
}

const initialState: User = {
  peerId: '',
  connected: null,
  registered: false,
  username: '',
  torEnabled: false,
};

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setPeerId: (state, action: PayloadAction<string>) => {
      state.peerId = action.payload;
    },
    setUsername: (state, action: PayloadAction<string>) => {
      state.username = action.payload;
    },
    setConnected: (state, action: PayloadAction<boolean>) => {
      state.connected = action.payload;
    },
    setRegistered: (state, action: PayloadAction<boolean>) => {
      state.registered = action.payload;
    },
    setTorEnabled: (state, action: PayloadAction<boolean>) => {
      state.torEnabled = action.payload;
    },
  },
});

export const {
  setPeerId,
  setUsername,
  setConnected,
  setRegistered,
  setTorEnabled,
} = userSlice.actions;

export default userSlice.reducer;
