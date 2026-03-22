import { useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppDispatch, useAppSelector } from '../../state/hooks';
import { clearIncomingCall } from '../../state/slices/callSlice';
import { callService } from '../../lib/call/callService';

export const IncomingCallCard = () => {
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!incomingCall) return null;

  const handleAccept = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await callService.acceptIncomingCall({
        callId: incomingCall.callId,
        peerId: incomingCall.peerId,
        offerSdp: incomingCall.offerSdp,
      });
      if (!result.success) {
        toast.error(result.error || 'Failed to accept call');
        return;
      }
      dispatch(clearIncomingCall());
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await callService.rejectIncomingCall(
        incomingCall.peerId,
        incomingCall.callId,
        'rejected',
      );
      if (!result.success) {
        toast.error(result.error || 'Failed to reject call');
      }
      dispatch(clearIncomingCall());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed top-4 right-4 z-[110] w-[320px] rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl">
      <div className="text-sm font-semibold text-foreground">Incoming Call</div>
      <div className="mt-1 text-xs text-muted-foreground truncate">
        {incomingCall.peerName} ({incomingCall.peerId})
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={handleReject}
          disabled={isSubmitting}
        >
          <PhoneOff className="w-4 h-4" />
          Reject
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={handleAccept}
          disabled={isSubmitting}
        >
          <Phone className="w-4 h-4" />
          Accept
        </Button>
      </div>
    </div>
  );
};
