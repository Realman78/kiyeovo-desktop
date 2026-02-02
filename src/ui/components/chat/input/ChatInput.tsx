import { useState, type FC } from "react";
import { Button } from "../../ui/Button";
import { Loader2, Paperclip, Send } from "lucide-react";
import { Input } from "../../ui/Input";
import { useToast } from "../../ui/use-toast";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";

export const ChatInput: FC = () => {
    const {toast} = useToast();
    const [inputQuery, setInputQuery] = useState("");
    const [isSending, setIsSending] = useState(false);
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    const isBlocked = activeChat?.blocked || false;

    const handleSendMessage = async (peerIdOrUsername: string, messageContent: string) => {
        try {
            const {success, error} = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, messageContent);

            if (!success) {
                toast.error(error || 'Failed to send message');
            }
            // Note: Message will be added to Redux via onMessageReceived event in Main.tsx
            // This ensures single source of truth and correct sender information
        } catch (err) {
            console.error('Failed to send message:', err);
            toast.error(err instanceof Error ? err.message : 'Unexpected error occurred');
        } finally {
            setIsSending(false);
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!activeChat) {
            toast.error('No active chat selected');
            return;
        }
        if (!activeChat.peerId) {
            toast.error('No peer ID found for active chat');
            return;
        }
        if (!inputQuery.trim()) {
            return;
        }
        setIsSending(true);

        await handleSendMessage(activeChat.peerId, inputQuery);
        setInputQuery('');
    }

    return <form
        onSubmit={handleSubmit}
        className={`h-20 px-4 flex items-center justify-between border-t border-border gap-4`}
    >
        <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={isSending || isBlocked}
            className="text-sidebar-foreground hover:text-foreground"
        >
            <Paperclip className="w-4 h-4" />
        </Button>
        <Input
            placeholder={isBlocked ? "Cannot send messages to blocked users" : "Type a message..."}
            parentClassName="flex flex-1 w-full"
            value={inputQuery}
            disabled={isSending || isBlocked}
            onChange={(e) => setInputQuery(e.target.value)}
        />
        <Button
            type="submit"
            disabled={!inputQuery.trim() || isSending || isBlocked}
            size="icon"
        >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
    </form>
}
