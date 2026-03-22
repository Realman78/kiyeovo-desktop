import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../state/store';

const INCOMING_RING_SRC = '/sounds/call-incoming-placeholder.wav';
const OUTGOING_RING_SRC = '/sounds/call-outgoing-placeholder.wav';

function stopAudio(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

async function playLoop(audio: HTMLAudioElement | null): Promise<void> {
  if (!audio) return;
  if (!audio.paused) return;
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch (error) {
    console.warn('[CALL] Failed to play ringtone:', error);
  }
}

export const useCallRingtone = () => {
  const incomingCall = useSelector((state: RootState) => state.call.incomingCall);
  const activeCall = useSelector((state: RootState) => state.call.activeCall);

  const incomingAudioRef = useRef<HTMLAudioElement | null>(null);
  const outgoingAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const incoming = new Audio(INCOMING_RING_SRC);
    incoming.loop = true;
    incoming.preload = 'auto';
    incomingAudioRef.current = incoming;

    const outgoing = new Audio(OUTGOING_RING_SRC);
    outgoing.loop = true;
    outgoing.preload = 'auto';
    outgoingAudioRef.current = outgoing;

    return () => {
      stopAudio(incomingAudioRef.current);
      stopAudio(outgoingAudioRef.current);
      incomingAudioRef.current = null;
      outgoingAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const shouldPlayIncoming = Boolean(incomingCall);
    const shouldPlayOutgoing = activeCall?.state === 'ringing_out';

    if (shouldPlayIncoming) {
      void playLoop(incomingAudioRef.current);
    } else {
      stopAudio(incomingAudioRef.current);
    }

    if (shouldPlayOutgoing) {
      void playLoop(outgoingAudioRef.current);
    } else {
      stopAudio(outgoingAudioRef.current);
    }
  }, [incomingCall?.callId, activeCall?.callId, activeCall?.state]);
};

