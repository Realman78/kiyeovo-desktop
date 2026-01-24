import type { FC } from "react";
import { Button } from "../../ui/Button";

export const InvitationManager: FC = () => {
    return <div className={`h-20 px-4 flex items-center justify-evenly border-t border-border`}>
        <Button variant="outline">
            Accept
        </Button>

        <div className="flex items-center gap-4">
            <Button variant="destructive" className="bg-transparent border border-destructive/50 text-destructive hover:bg-destructive/50!">
                Reject
            </Button>
            <Button variant="destructive" className="bg-transparent border border-destructive/50 text-destructive">
                Reject & Block
            </Button>
        </div>
    </div>
}
