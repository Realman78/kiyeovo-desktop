import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';

interface Contact {
  peerId: string;
  username: string;
}

export interface GroupInviteDeliveryView {
  peerId: string;
  username: string;
  status: 'sent' | 'queued_for_retry';
  reason?: string;
}

interface DisabledPeer {
  peerId: string;
  reason: string;
}

interface InviteUsersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: number;
  groupName: string;
  disabledPeers: DisabledPeer[];
  maxSelectable: number;
  onSuccess?: (inviteDeliveries: GroupInviteDeliveryView[]) => void;
}

export const InviteUsersDialog = ({
  open,
  onOpenChange,
  chatId,
  groupName,
  disabledPeers,
  maxSelectable,
  onSuccess,
}: InviteUsersDialogProps) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedPeerIds, setSelectedPeerIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      if (isSubmitting) return;
      setContacts([]);
      setSelectedPeerIds(new Set());
      setIsLoading(false);
      setError(null);
      setLoadError(null);
      return;
    }

    const loadContacts = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await window.kiyeovoAPI.getContacts();
        if (!result.success) {
          setLoadError(result.error || 'Failed to load contacts');
          return;
        }
        setContacts(result.contacts);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load contacts');
      } finally {
        setIsLoading(false);
      }
    };

    void loadContacts();
  }, [open, isSubmitting]);

  const disabledPeerReasons = useMemo(
    () => new Map(disabledPeers.map((peer) => [peer.peerId, peer.reason])),
    [disabledPeers],
  );

  const toggleContact = (peerId: string) => {
    setSelectedPeerIds((prev) => {
      const next = new Set(prev);
      const isDisabled = disabledPeerReasons.has(peerId);
      if (isDisabled) {
        return next;
      }
      if (next.has(peerId)) {
        next.delete(peerId);
      } else if (next.size < maxSelectable) {
        next.add(peerId);
      }
      return next;
    });
  };

  const selectedContacts = contacts.filter((c) => selectedPeerIds.has(c.peerId));
  const canSubmit = selectedPeerIds.size > 0 && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await window.kiyeovoAPI.inviteUsersToGroup(chatId, Array.from(selectedPeerIds));
      if (!result.success) {
        setError(result.error || 'Failed to invite users');
        return;
      }

      onOpenChange(false);
      onSuccess?.(result.inviteDeliveries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite users');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Invite Users</DialogTitle>
              <DialogDescription>
                Invite contacts to {groupName}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            {selectedContacts.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Selected ({selectedContacts.length})
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {selectedContacts.map((c) => (
                    <button
                      key={c.peerId}
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => toggleContact(c.peerId)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors"
                    >
                      {c.username}
                      <span className="text-primary/60">&times;</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Contacts
              </label>
              <div className="max-h-56 overflow-y-auto border border-border rounded-md">
                {isLoading ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    Loading contacts...
                  </div>
                ) : loadError ? (
                  <div className="p-4 text-center text-sm text-destructive flex items-center justify-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    {loadError}
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No eligible contacts to invite.
                  </div>
                ) : (
                  contacts.map((contact) => {
                    const isSelected = selectedPeerIds.has(contact.peerId);
                    const disabledReason = disabledPeerReasons.get(contact.peerId);
                    const selectionLimitReached = !isSelected && selectedPeerIds.size >= maxSelectable;
                    const isDisabled = isSubmitting || !!disabledReason || selectionLimitReached || maxSelectable <= 0;
                    return (
                      <button
                        key={contact.peerId}
                        type="button"
                        onClick={() => !isDisabled && toggleContact(contact.peerId)}
                        disabled={isDisabled}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-b border-border last:border-b-0 ${
                          isSelected
                            ? 'bg-primary/10'
                            : isDisabled
                              ? 'opacity-70 cursor-not-allowed'
                              : 'hover:bg-secondary/50 cursor-pointer'
                        }`}
                      >
                        {!disabledReason ? (
                          <div
                            className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                              isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                          </div>
                        ) : (
                          <div className="w-5 h-5 shrink-0" />
                        )}
                        <span className={`text-sm truncate ${disabledReason ? 'text-muted-foreground' : 'text-foreground'}`}>
                          {contact.username}
                        </span>
                        {disabledReason && (
                          <span className="ml-auto text-xs text-muted-foreground">{disabledReason}</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {Math.max(0, maxSelectable - selectedPeerIds.size) > 0
                  ? `You can invite up to ${Math.max(0, maxSelectable - selectedPeerIds.size)} more ${Math.max(0, maxSelectable - selectedPeerIds.size) === 1 ? 'user' : 'users'}.`
                  : 'Group member limit reached.'}
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? 'Sending invites...' : `Invite ${selectedPeerIds.size > 0 ? `(${selectedPeerIds.size})` : ''}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
