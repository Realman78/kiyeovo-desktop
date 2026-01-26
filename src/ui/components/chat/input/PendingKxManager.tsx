import { useState, useEffect } from "react";
import { useDispatch } from "react-redux";
import { Button } from "../../ui/Button";
import { addChat, removeContactAttempt, setActiveChat, setActivePendingKeyExchange, type Chat } from "../../../state/slices/chatSlice";

type PendingKxManagerProps = {
    peerId: string;
}

export const PendingKxManager = ({ peerId }: PendingKxManagerProps) => {
    const dispatch = useDispatch();
    const [error, setError] = useState<string | undefined>(undefined);
    const [isCancelling, setIsCancelling] = useState(false);

    useEffect(() => {
        const cleanup = window.kiyeovoAPI.onChatCreated((data) => {
            // Only handle if it's for this peer
            if (data.peerId === peerId) {
                // Create chat object and add to Redux
                const newChat: Chat = {
                    id: data.chatId,
                    type: 'direct',
                    name: data.username,
                    peerId: data.peerId,
                    lastMessage: '',
                    lastMessageTimestamp: Date.now(),
                    unreadCount: 0,
                    status: 'active',
                    justCreated: true, // Mark as newly created
                };

                dispatch(addChat(newChat));
                dispatch(removeContactAttempt(peerId));
                dispatch(setActiveChat(data.chatId));
                setIsCancelling(false);
            }
        });

        return cleanup;
    }, [peerId, dispatch]);

    const handleCancel = async () => {
        setError(undefined);
        setIsCancelling(true);

        try {
            const result = await window.kiyeovoAPI.cancelPendingKeyExchange(peerId);

            if (!result.success) {
                setError(result.error || 'Failed to cancel key exchange');
                setIsCancelling(false);
            }
            dispatch(setActivePendingKeyExchange(null))
        } catch (err) {
            console.error('Failed to cancel key exchange:', err);
            setError(err instanceof Error ? err.message : 'Unexpected error occurred');
            setIsCancelling(false);
        }
    }
    return <div className={`h-20 px-4 flex flex-col justify-center border-t border-border`}>
        <div className="flex items-center justify-evenly">
            <Button onClick={handleCancel} variant="destructive" className="bg-transparent border border-destructive/50 text-destructive hover:bg-destructive/50!" disabled={isCancelling}>
                Cancel Key Exchange
            </Button>
        </div>
        {error && <div className="text-destructive text-sm text-center mt-2">{error}</div>}
    </div>
}
