import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../ui/Dialog";
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
                </DialogHeader>

                <DialogBody className="cursor-default space-y-6">
                    {/* Key Features */}
                    <div className="space-y-3">
                        <div className="text-justify mb-5">
                        Kiyeovo is a P2P decentralized messaging application that routes messages through the Tor network (optionally).
                        Built with privacy and security at its core, Kiyeovo uses DHT for peer discovery and end-to-end encryption for all conversations.
                        </div>
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Key Features</h3>
                        <div className="grid gap-2">
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🔒</span>
                                <span>End-to-end encrypted conversations with XChaCha20-Poly1305</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🌐</span>
                                <span>Decentralized architecture with Kademlia DHT - no central servers</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🧅</span>
                                <span>Optional Tor integration for anonymous communication</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">💾</span>
                                <span>Offline message delivery with RSA encryption via DHT</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">👥</span>
                                <span>Group chat with automatic key rotation</span>
                            </div>
                        </div>
                    </div>

                    {/* Links */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Resources</h3>
                        <div className="flex flex-wrap gap-3 text-sm">
                            <a href="https://github.com/mastermarin/kiyeovo" target="_blank" rel="noopener noreferrer"
                               className="text-primary hover:underline flex items-center gap-1">
                                💻 Source Code
                            </a>
                            <a href="https://github.com/mastermarin/kiyeovo/blob/main/kiyeovo/Kiyeovo_tehnicka_dokumentacija.md" target="_blank" rel="noopener noreferrer"
                               className="text-primary hover:underline flex items-center gap-1">
                                📖 Documentation
                            </a>
                            <a href="https://github.com/mastermarin/kiyeovo/issues" target="_blank" rel="noopener noreferrer"
                               className="text-primary hover:underline flex items-center gap-1">
                                🐛 Report Issue
                            </a>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="pt-4 border-t border-border text-center text-sm text-muted-foreground">
                        <p>Built with by Marin Dedic</p>
                        <p className="text-xs mt-1">© 2026 Kiyeovo. All rights reserved.</p>
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
