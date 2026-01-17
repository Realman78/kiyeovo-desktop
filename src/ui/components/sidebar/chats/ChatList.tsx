import { useState, type FC } from "react";
import { Input } from "../../ui/Input";
import { Search } from "lucide-react";
import { ChatPreview } from "./ChatPreview";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { setActiveChat } from "../../../state/slices/chatSlice";

export const ChatList: FC = () => {
    const [searchQuery, setSearchQuery] = useState("");
    const chats = useSelector((state: RootState) => state.chat.chats);
    const selectedChatId = useSelector((state: RootState) => state.chat.activeChat);
    const dispatch = useDispatch();
    
    const onSelectChat = (chatId: number) => {
        dispatch(setActiveChat(chatId));
    }
    return (
        <div className="flex flex-col flex-1 overflow-y-auto">
            <div className="p-4 pt-0 border-b border-sidebar-border">
                <Input
                    placeholder="Search conversations..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    icon={<Search className="w-4 h-4" />}
                    className="bg-sidebar-accent border-sidebar-border"
                />
            </div>
            <div className="flex flex-col flex-1 overflow-y-auto">
                {chats.map((chat) => (
                    <ChatPreview key={chat.id} chat={chat} onSelectChat={onSelectChat} selectedChatId={selectedChatId} />
                ))}
            </div>
        </div>
    );
}
