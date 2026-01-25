import { useState, useEffect } from "react";
import { useDispatch } from "react-redux";
import { Button } from "../../ui/Button";
import { addChat, removeContactAttempt, setActiveChat, type Chat } from "../../../state/slices/chatSlice";

type InvitationManagerProps = {
    peerId: string;
}

export const InvitationManager = ({peerId}: InvitationManagerProps) => {
    const dispatch = useDispatch();
    const [error, setError] = useState<string | undefined>(undefined);
    const [isAccepting, setIsAccepting] = useState(false);

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
                setIsAccepting(false);
            }
        });

        return cleanup;
    }, [peerId, dispatch]);

    const handleAccept = async () => {
        setError(undefined);
        setIsAccepting(true);

        try {
            const result = await window.kiyeovoAPI.acceptContactRequest(peerId);

            if (!result.success) {
                setError(result.error || 'Failed to accept contact request');
                setIsAccepting(false);
            }
            // If successful, we wait for the chat-created event
        } catch (err) {
            console.error('Failed to accept contact request:', err);
            setError(err instanceof Error ? err.message : 'Unexpected error occurred');
            setIsAccepting(false);
        }
    }
    return <div className={`h-20 px-4 flex flex-col justify-center border-t border-border`}>
        <div className="flex items-center justify-evenly">
            <Button variant="outline" onClick={handleAccept} disabled={isAccepting}>
                {isAccepting ? 'Accepting...' : 'Accept'}
            </Button>

            <div className="flex items-center gap-4">
                <Button variant="destructive" className="bg-transparent border border-destructive/50 text-destructive hover:bg-destructive/50!" disabled={isAccepting}>
                    Reject
                </Button>
                <Button variant="destructive" className="bg-transparent border border-destructive/50 text-destructive" disabled={isAccepting}>
                    Reject & Block
                </Button>
            </div>
        </div>
        {error && <div className="text-destructive text-sm text-center mt-2">{error}</div>}
    </div>
}
