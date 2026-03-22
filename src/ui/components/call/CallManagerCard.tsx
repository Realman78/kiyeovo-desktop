import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Mic, MicOff, PhoneCall, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { callService } from '../../lib/call/callService';
import { useCallCardAnchor } from './useCallCardAnchor';

function stateLabel(state: string): string {
  switch (state) {
    case 'ringing_out':
      return 'Ringing...';
    case 'ringing_in':
      return 'Incoming call';
    case 'connecting':
      return 'Connecting...';
    case 'active':
      return 'In call';
    default:
      return state;
  }
}

function formatCallDuration(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const CallManagerCard = () => {
  const { toast } = useToast();
  const activeCall = useAppSelector((state) => state.call.activeCall);
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const { positionClassName, snapToClosestCorner } = useCallCardAnchor();

  useEffect(() => {
    if (!activeCall) return;
    const audioState = callService.getAudioControlState();
    setIsMuted(audioState.muted);
    setIsDeafened(audioState.deafened);
  }, [activeCall?.callId]);

  useEffect(() => {
    if (!activeCall) {
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - activeCall.startedAt) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [activeCall?.callId, activeCall?.startedAt]);

  if (!activeCall) return null;
  if (activeCall.state === 'ringing_in' && incomingCall) return null;
  const showTimer = activeCall.state === 'active';
  const timerText = showTimer ? formatCallDuration(elapsedSeconds) : null;

  const handleHangup = async () => {
    const result = await callService.hangupCall(activeCall.peerId, activeCall.callId, 'hangup');
    if (!result.success) {
      toast.error(result.error || 'Failed to hang up');
    }
  };

  const handleToggleMute = () => {
    setIsMuted(callService.toggleMute());
  };

  const handleToggleDeafen = () => {
    setIsDeafened(callService.toggleDeafen());
  };

  const handleAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    setIsDraggingAnchor(true);

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // no-op: pointer capture can fail on some environments, snap still works via window listener
    }

    const cleanup = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // no-op: if capture was never set, release can throw
      }
      setIsDraggingAnchor(false);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      cleanup();
      snapToClosestCorner(upEvent.clientX, upEvent.clientY);
    };

    const onPointerCancel = () => {
      cleanup();
    };

    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  return (
    <div className={`fixed ${positionClassName} z-109 w-fit rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl`}>
      <button
        type="button"
        className={`absolute top-1 left-1 z-10 h-5 w-5 rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground cursor-move ${isDraggingAnchor ? 'bg-accent/80 text-foreground' : ''}`}
        title="Drag to snap card position"
        aria-label="Drag to snap card position"
        onPointerDown={handleAnchorPointerDown}
      >
        <GripVertical className="mx-auto h-3.5 w-3.5" />
      </button>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-primary" />
          <div className="text-sm font-semibold text-foreground">
            {activeCall.state === "active"
              ? `${activeCall.peerName}${timerText ? ` • ${timerText}` : ''}`
              : stateLabel(activeCall.state)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant={isMuted ? 'secondary' : 'outline'} size="sm" onClick={handleToggleMute}>
          {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </Button>
        <Button variant={isDeafened ? 'secondary' : 'outline'} size="sm" onClick={handleToggleDeafen}>
          {isDeafened ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleHangup}>
          <PhoneOff className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};
