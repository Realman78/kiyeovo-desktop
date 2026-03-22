import { PhoneOff, PhoneCall } from 'lucide-react';
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

  if (!activeCall) return null;
  if (activeCall.state === 'ringing_in' && incomingCall) return null;

  const handleHangup = async () => {
    const result = await callService.hangupCall(activeCall.peerId, activeCall.callId, 'hangup');
    if (!result.success) {
      toast.error(result.error || 'Failed to hang up');
    }
  };

  return (
    <div className="fixed top-4 right-4 z-[109] w-[320px] rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl">
      <div className="flex items-center gap-2">
        <PhoneCall className="w-4 h-4 text-primary" />
        <div className="text-sm font-semibold text-foreground">{stateLabel(activeCall.state)}</div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground truncate">
        {activeCall.peerName} ({activeCall.peerId})
      </div>
      <div className="mt-3 flex items-center justify-end">
        <Button variant="destructive" size="sm" onClick={handleHangup}>
          <PhoneOff className="w-4 h-4" />
          Hang up
        </Button>
      </div>
    </div>
  );
};
