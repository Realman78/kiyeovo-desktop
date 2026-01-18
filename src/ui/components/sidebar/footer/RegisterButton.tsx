import { Settings, UserPlus } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import RegisterDialog from "./RegisterDialog";
import { Button } from "../../ui/Button";

export const RegisterButton: FC = () => {
    const [showDialog, setShowDialog] = useState(false);

    const handleShowDialog = () => {
        setShowDialog(true);
    }

    const handleRegister = (username: string) => {
        console.log(username);
        setShowDialog(false);
    }

    const handleSettings = () => {
        console.log("settings");
    }

    return <>
        <div className="flex items-center gap-3">
            <button
                onClick={handleShowDialog}
                className="w-full cursor-pointer flex items-center gap-3 p-2 rounded-md bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors group"
            >
                <div className="w-9 h-9 rounded-full border border-primary/50 flex items-center justify-center group-hover:border-primary transition-colors">
                    <UserPlus className="w-4 h-4 text-primary" />
                </div>
                <div className="text-left">
                    <p className="text-sm font-mono font-medium text-primary">
                        Register Identity
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Register with a unique username
                    </p>
                </div>
            </button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSettings}
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="w-4 h-4" />
            </Button>
        </div>
        <RegisterDialog open={showDialog} onOpenChange={setShowDialog} onRegister={handleRegister} />
    </>
}
