import { useState, useEffect, useRef, type FC } from "react";
import { Button } from "../../ui/Button";
import { Paperclip, Send } from "lucide-react";
import { Input } from "../../ui/Input";
import { useToast } from "../../ui/use-toast";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { SendFileDialog } from "./SendFileDialog";
import { addMessage, removeMessageById, updateChat, updateFileTransferStatus, updateLocalMessageSendState } from "../../../state/slices/chatSlice";
import { FILE_ACCEPTANCE_TIMEOUT, MAX_MESSAGE_CONTENT_LENGTH } from "../../../constants";

type PendingSendJob =
    | { type: 'direct'; chatId: number; peerId: string; content: string; localMessageId: string }
    | { type: 'group'; chatId: number; content: string; localMessageId: string };

export const ChatInput: FC = () => {
    const { toast } = useToast();
    const dispatch = useDispatch();
    const [draftByChatId, setDraftByChatId] = useState<Record<number, string>>({});
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);
    const myUsername = useSelector((state: RootState) => state.user.username);
    const isBlocked = activeChat?.blocked || false;
    const isGroupPending = activeChat?.type === 'group' && activeChat?.groupStatus !== 'active';
    const isDisabled = isBlocked || isGroupPending;
    const sendQueueRef = useRef<Record<number, PendingSendJob[]>>({});
    const processingQueueRef = useRef<Record<number, boolean>>({});
    const inputRef = useRef<HTMLInputElement>(null);

    // Auto-focus input when chat changes
    useEffect(() => {
        if (activeChat && !isDisabled) {
            inputRef.current?.focus();
        }
    }, [activeChat?.id, isDisabled]);

    const activeChatId = activeChat?.id;
    const inputQuery = activeChatId ? (draftByChatId[activeChatId] ?? "") : "";

    const setDraftForChat = (chatId: number, value: string) => {
        setDraftByChatId((prev) => ({ ...prev, [chatId]: value }));
    };

    const performSendMessage = async (peerIdOrUsername: string, messageContent: string): Promise<boolean> => {
        try {
            const { success, error } = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, messageContent);

            if (!success) {
                toast.error(error || 'Failed to send message');
                return false;
            }
            return true;
            // Note: Message will be added to Redux via onMessageReceived event in Main.tsx
            // This ensures single source of truth and correct sender information
        } catch (err) {
            console.error('Failed to send message:', err);
            toast.error(err instanceof Error ? err.message : 'Unexpected error occurred');
            return false;
        }
    };

    const performSendGroupMessage = async (chatId: number, messageContent: string): Promise<boolean> => {
        try {
            const { success, error, warning, offlineBackupRetry } = await window.kiyeovoAPI.sendGroupMessage(chatId, messageContent);
            if (!success) {
                toast.error(error || 'Failed to send group message');
                return false;
            } else if (warning && offlineBackupRetry) {
                toast.warningAction(
                    warning,
                    'Try again',
                    async () => {
                        const retry = await window.kiyeovoAPI.retryGroupOfflineBackup(
                            offlineBackupRetry.chatId,
                            offlineBackupRetry.messageId,
                        );
                        if (retry.success) {
                            toast.success('Group offline backup synced');
                        } else {
                            toast.error(retry.error || 'Failed to retry group offline backup');
                        }
                    },
                );
            }
            return true;
        } catch (err) {
            console.error('Failed to send group message:', err);
            toast.error(err instanceof Error ? err.message : 'Unexpected error occurred');
            return false;
        }
    };

    const processQueueForChat = async (chatId: number) => {
        if (processingQueueRef.current[chatId]) return;
        processingQueueRef.current[chatId] = true;

        try {
            while ((sendQueueRef.current[chatId]?.length ?? 0) > 0) {
                const next = sendQueueRef.current[chatId]!.shift()!;
                dispatch(updateLocalMessageSendState({ messageId: next.localMessageId, state: 'sending' }));

                let success = false;
                if (next.type === 'group') {
                    success = await performSendGroupMessage(next.chatId, next.content);
                } else {
                    success = await performSendMessage(next.peerId, next.content);
                }

                if (!success) {
                    dispatch(updateLocalMessageSendState({ messageId: next.localMessageId, state: 'failed' }));
                }
            }
        } finally {
            processingQueueRef.current[chatId] = false;
            setTimeout(() => {
                if (activeChat?.id === chatId) {
                    inputRef.current?.focus();
                }
            }, 200);
        }
    };

    const enqueueSendJob = (job: PendingSendJob) => {
        if (!sendQueueRef.current[job.chatId]) {
            sendQueueRef.current[job.chatId] = [];
        }
        sendQueueRef.current[job.chatId].push(job);
        void processQueueForChat(job.chatId);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!activeChat) {
            toast.error('No active chat selected');
            return;
        }
        const messageContent = inputQuery.trim();
        if (!messageContent) {
            return;
        }
        if (messageContent.length > MAX_MESSAGE_CONTENT_LENGTH) {
            toast.error(`Message too long. Max ${MAX_MESSAGE_CONTENT_LENGTH} characters`);
            return;
        }
        const chatId = activeChat.id;
        const localMessageId = `local-send-${chatId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        dispatch(addMessage({
            id: localMessageId,
            chatId,
            senderPeerId: myPeerId || '',
            senderUsername: myUsername || 'You',
            content: messageContent,
            timestamp: Date.now(),
            messageType: 'text',
            messageSentStatus: null,
            currentUserPeerId: myPeerId,
            localSendState: 'queued',
        }));

        if (activeChat.type === 'group') {
            enqueueSendJob({ type: 'group', chatId, content: messageContent, localMessageId });
        } else {
            if (!activeChat.peerId) {
                toast.error('No peer ID found for active chat');
                dispatch(updateLocalMessageSendState({ messageId: localMessageId, state: 'failed' }));
                return;
            }
            enqueueSendJob({ type: 'direct', chatId, peerId: activeChat.peerId, content: messageContent, localMessageId });
        }
        setDraftForChat(chatId, '');
    };

    const handleSendFile = async (filePath: string, fileName: string, fileSize: number) => {
        if (!activeChat?.peerId) {
            toast.error('No active chat selected');
            return;
        }

        const previousLastMessage = activeChat.lastMessage;
        const previousLastMessageTimestamp = activeChat.lastMessageTimestamp;
        const chatId = activeChat.id;
        const pendingMessageId = `pending-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const transferExpiresAt = Date.now() + FILE_ACCEPTANCE_TIMEOUT;
        try {
            dispatch(addMessage({
                id: pendingMessageId,
                chatId,
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
                const errorText = result.error?.toLowerCase() || '';
                console.log("RESULT ERROR:", result.error);
                const failedBeforePersist = errorText.includes('dial request has no valid addresses');
                if (failedBeforePersist) {
                    toast.error('Cannot send file to offline user');
                } else if (!errorText.includes('timeout waiting for file acceptance') && !errorText.includes('rejected')) {
                    toast.error(result.error || 'Failed to send file');
                }
                if (failedBeforePersist) {
                    dispatch(removeMessageById({ messageId: pendingMessageId, chatId }));
                    dispatch(updateChat({
                        id: chatId,
                        updates: {
                            lastMessage: previousLastMessage,
                            lastMessageTimestamp: previousLastMessageTimestamp
                        }
                    }));
                    return;
                }
                const status =
                    errorText.includes('timeout waiting for file acceptance') ? 'expired' :
                    errorText.includes('rejected') ? 'rejected' :
                    'failed';
                dispatch(updateFileTransferStatus({
                    messageId: pendingMessageId,
                    status,
                    transferError: result.error || (status === 'expired' ? 'Offer expired' : 'Offer rejected')
                }));
            } else {
                toast.success('File transfer started');
            }
        } catch (error) {
            console.error('Error sending file:', error);
            toast.error(error instanceof Error ? error.message : 'Failed to send file');
            const errorText = error instanceof Error ? error.message.toLowerCase() : '';
            const failedBeforePersist = errorText.includes('dial request has no valid addresses');
            if (failedBeforePersist) {
                dispatch(removeMessageById({ messageId: pendingMessageId, chatId }));
                dispatch(updateChat({
                    id: chatId,
                    updates: {
                        lastMessage: previousLastMessage,
                        lastMessageTimestamp: previousLastMessageTimestamp
                    }
                }));
                return;
            }
            const status =
                errorText.includes('timeout waiting for file acceptance') ? 'expired' :
                errorText.includes('rejected') ? 'rejected' :
                'failed';
            dispatch(updateFileTransferStatus({
                messageId: pendingMessageId,
                status,
                transferError: error instanceof Error ? error.message : (status === 'expired' ? 'Offer expired' : 'Offer rejected')
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
                disabled={isDisabled}
                onClick={() => setFileDialogOpen(true)}
                className="text-sidebar-foreground hover:text-foreground"
            >
                <Paperclip className="w-4 h-4" />
            </Button>
            <Input
                ref={inputRef}
                placeholder={isBlocked ? "Cannot send messages to blocked users" : isGroupPending ? "Waiting for members to join..." : "Type a message..."}
                parentClassName="flex flex-1 w-full"
                value={inputQuery}
                disabled={isDisabled}
                onChange={(e) => {
                    if (!activeChat) return;
                    setDraftForChat(activeChat.id, e.target.value);
                }}
            />
            <Button
                type="submit"
                disabled={!inputQuery.trim() || isDisabled}
                size="icon"
            >
                <Send className="w-4 h-4" />
            </Button>
        </form>

        <SendFileDialog
            open={fileDialogOpen}
            onOpenChange={setFileDialogOpen}
            onSend={handleSendFile}
        />
    </>
}
