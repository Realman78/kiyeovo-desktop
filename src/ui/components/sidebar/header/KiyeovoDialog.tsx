import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/Dialog";
import type { FC } from "react";
import { Logo } from "../../icons/Logo";

type KiyeovoDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const KiyeovoDialog: FC<KiyeovoDialogProps> = ({ open, onOpenChange }) => {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center justify-center gap-2 mb-6 text-2xl! cursor-default">
                        <div className="w-12 h-12 rounded-full border border-primary/50 flex items-center justify-center glow-border">
                            <Logo version="2" />
                        </div>
                        Kiyeovo
                    </DialogTitle>
                    <DialogDescription className="cursor-default">
                        Kiyeovo is a P2P decentralized messaging application that routes messages through the Tor network (optionally).
                    </DialogDescription>
                </DialogHeader>

                <DialogBody className="cursor-default">
                    PLACEHOLDER FOR CONTENT
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
