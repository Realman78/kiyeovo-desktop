import { useEffect, useState } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, PhoneCall, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { callService } from '../../lib/call/callService';

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

export const CallManagerCard = () => {
  const { toast } = useToast();
  const activeCall = useAppSelector((state) => state.call.activeCall);
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  useEffect(() => {
    if (!activeCall) return;
    const audioState = callService.getAudioControlState();
    setIsMinimized(false);
    setIsMuted(audioState.muted);
    setIsDeafened(audioState.deafened);
  }, [activeCall?.callId]);

  if (!activeCall) return null;
  if (activeCall.state === 'ringing_in' && incomingCall) return null;

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

  if (isMinimized) {
    return (
      <div className="fixed bottom-24 right-4 z-109 w-[320px] rounded-lg border border-border bg-card/95 backdrop-blur px-3 py-2 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-foreground uppercase tracking-wide">
              {activeCall.state === "active" ? activeCall.peerName : stateLabel(activeCall.state)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={isMuted ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={handleToggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </Button>
            <Button
              variant={isDeafened ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={handleToggleDeafen}
              title={isDeafened ? 'Undeafen' : 'Deafen'}
            >
              {isDeafened ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setIsMinimized(false)}
              title="Expand"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
            <Button
              variant="destructive"
              size="icon"
              className="h-8 w-8"
              onClick={handleHangup}
              title="Hang up"
            >
              <PhoneOff className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-24 right-4 z-109 w-[320px] rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-primary" />
          <div className="text-sm font-semibold text-foreground">{activeCall.state === "active" ? activeCall.peerName : stateLabel(activeCall.state)}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setIsMinimized(true)}
          title="Minimize"
        >
          <Minimize2 className="w-4 h-4" />
        </Button>
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
          Hang up
        </Button>
      </div>
    </div>
  );
};
