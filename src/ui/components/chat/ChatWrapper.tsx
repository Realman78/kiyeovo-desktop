import { useState, useRef, useEffect } from "react";
import { Send, Paperclip, MoreVertical, Shield, Phone, Video } from "lucide-react";
import { ChatHeader } from "./header/ChatHeader";

interface Message {
  id: string;
  content: string;
  timestamp: string;
  sent: boolean;
  status?: "sending" | "sent" | "delivered" | "read";
}

interface ChatWrapperProps {
//   chatName: string;
//   chatOnline: boolean;
//   messages: Message[];
//   onSendMessage: (content: string) => void;
}

const ChatWrapper = ({

}: ChatWrapperProps) => {
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

//   useEffect(() => {
//     messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
//   }, [messages]);

//   const handleSubmit = (e: React.FormEvent) => {
//     e.preventDefault();
//     if (inputValue.trim()) {
//       onSendMessage(inputValue.trim());
//       setInputValue("");
//     }
//   };

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      <ChatHeader username={"John Doe"} peerId={"1234567890"} />
    </div>
  );
};

export default ChatWrapper;
