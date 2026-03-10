WebRTC.md
libp2p's Circuit Relay v2 is NOT suitable for calls. Your relay.ts server enforces bandwidth and duration limits by design (that's the v2 spec). Media streams need sustained ~50-100+ kbps for audio and ~500kbps+ for video — relay v2 will kill those connections.

libp2p doesn't have a media solution. There's no libp2p service for real-time audio/video. libp2p handles connectivity and data streams, not media codecs, jitter buffers, echo cancellation, etc.

WebRTC is the answer, and you have a few options for NAT traversal:

1. Direct WebRTC (no TURN) — If both peers already have a direct TCP connection (same LAN or both have open ports), you can exchange SDP offers over your existing chat protocol and establish a WebRTC peer
connection. ICE with STUN (free, e.g. Google's STUN servers) handles many NAT scenarios. This works for a surprising number of cases.
2. TURN server — For symmetric NAT / carrier-grade NAT where STUN fails, you need TURN to relay media. This is a separate server from your circuit relay — different protocol entirely (TURN uses UDP relay, your
relay.ts uses libp2p streams over TCP). You'd run something like coturn on your VPS.
3. DCUtR as a stepping stone — Your app already uses DCUtR for hole-punching TCP connections. Once a direct connection exists (post-hole-punch), you could use that connectivity knowledge to inform WebRTC ICE
candidates, improving the chance of direct media without TURN.

Practical approach for your app:

- Use your existing libp2p chat protocol to exchange WebRTC signaling (SDP offer/answer, ICE candidates) — no separate signaling server needed
- Use free STUN servers for the common case
- Run coturn on your VPS for the fallback case (TURN)
- Electron gives you full WebRTC via Chromium — RTCPeerConnection works out of the box
- Audio/video capture via getUserMedia

Bottom line: You need WebRTC + STUN + TURN (coturn). Your existing libp2p infrastructure handles signaling, but the media path is entirely WebRTC. The circuit relay server cannot substitute for TURN.