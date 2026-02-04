import { useState, type FC } from "react";
import { Button } from "../../ui/Button";
import { Loader2, Paperclip, Send } from "lucide-react";
import { Input } from "../../ui/Input";
import { useToast } from "../../ui/use-toast";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { SendFileDialog } from "./SendFileDialog";
import { addMessage, updateFileTransferStatus } from "../../../state/slices/chatSlice";
import { FILE_ACCEPTANCE_TIMEOUT } from "../../../constants";

export const ChatInput: FC = () => {
    const { toast } = useToast();
    const dispatch = useDispatch();
    const [inputQuery, setInputQuery] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);
    const myUsername = useSelector((state: RootState) => state.user.username);
    const isBlocked = activeChat?.blocked || false;

    const handleSendMessage = async (peerIdOrUsername: string, messageContent: string) => {
        try {
            const { success, error } = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, messageContent);

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

    const handleSendFile = async (filePath: string, fileName: string, fileSize: number) => {
        if (!activeChat?.peerId) {
            toast.error('No active chat selected');
            return;
        }

        const pendingMessageId = `pending-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const transferExpiresAt = Date.now() + FILE_ACCEPTANCE_TIMEOUT;
        try {
            dispatch(addMessage({
                id: pendingMessageId,
                chatId: activeChat.id,
                senderPeerId: myPeerId || '',
                senderUsername: myUsername || 'You',
                content: `${fileName} (${fileSize} bytes)`,
                timestamp: Date.now(),
                messageType: 'file',
                messageSentStatus: 'online',
                currentUserPeerId: myPeerId,
                fileName: fileName,
                fileSize: fileSize,
                transferStatus: 'pending',
                transferProgress: 0,
                transferExpiresAt
            }));

            const result = await window.kiyeovoAPI.sendFile(activeChat.peerId, filePath);
            if (!result.success) {
                console.log("RESULT ERROR:", result.error);
                if (result.error?.toLowerCase().includes('dial request has no valid addresses')) {
                    toast.error('Cannot send file to offline user');
                } else if (!result.error?.toLowerCase().includes('timeout waiting for file acceptance') && !result.error?.toLowerCase().includes('rejected')) {
                    toast.error(result.error || 'Failed to send file');
                }
                dispatch(updateFileTransferStatus({
                    messageId: pendingMessageId,
                    status: 'rejected',
                    transferError: result.error || 'Offer rejected'
                }));
            } else {
                toast.success('File transfer started');
            }
        } catch (error) {
            console.error('Error sending file:', error);
            toast.error(error instanceof Error ? error.message : 'Failed to send file');
            dispatch(updateFileTransferStatus({
                messageId: pendingMessageId,
                status: 'rejected',
                transferError: error instanceof Error ? error.message : 'Offer rejected'
            }));
        }
    }

    return <>
        <form
            onSubmit={handleSubmit}
            className={`h-20 px-4 flex items-center justify-between border-t border-border gap-4`}
        >
            <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={isSending || isBlocked}
                onClick={() => setFileDialogOpen(true)}
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

        <SendFileDialog
            open={fileDialogOpen}
            onOpenChange={setFileDialogOpen}
            onSend={handleSendFile}
        />
    </>
}
