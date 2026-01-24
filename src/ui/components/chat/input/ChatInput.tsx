import type { FC } from "react";
import { Button } from "../../ui/Button";
import { Paperclip } from "lucide-react";

export const ChatInput: FC = () => {
    return <div className={`h-20 px-4 flex items-center justify-between border-t border-border`}>
        <Button
            variant="ghost"
            size="icon"
            // onClick={handleShowNewConversationDialog}
            className="text-sidebar-foreground hover:text-foreground"
        >
            <Paperclip className="w-4 h-4" />
        </Button>
    </div>
}
