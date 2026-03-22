import type { CallDirection, CallSignal, CallStateChangedEvent } from '../../types';

type CurrentCall = {
  callId: string;
  peerId: string;
  direction: CallDirection;
};

export type CallServiceEvent =
  | {
    type: 'state';
    callId: string;
    peerId: string;
    state: 'connecting' | 'active' | 'ended';
    reason?: string;
  }
  | {
    type: 'error';
    message: string;
  };

class CallService {
  private static readonly RING_TIMEOUT_MS = 30_000;
  private peerConnection: RTCPeerConnection | null = null;
  private currentCall: CurrentCall | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private sentDisconnectHangupCallId: string | null = null;
  private listeners = new Set<(event: CallServiceEvent) => void>();

  subscribe(listener: (event: CallServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CallServiceEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  private getIceServers(): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    const stunUrl = (import.meta.env.VITE_STUN_URL as string | undefined)?.trim();
    const turnUrl = (import.meta.env.VITE_TURN_URL as string | undefined)?.trim();
    const turnUsername = (import.meta.env.VITE_TURN_USERNAME as string | undefined)?.trim();
    const turnPassword = (import.meta.env.VITE_TURN_PASSWORD as string | undefined)?.trim();

    if (stunUrl) {
      servers.push({ urls: stunUrl });
    }
    if (turnUrl && turnUsername && turnPassword) {
      servers.push({
        urls: turnUrl,
        username: turnUsername,
        credential: turnPassword,
      });
    }
    return servers;
  }

  private createPeerConnection(context: CurrentCall): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      iceTransportPolicy: 'all',
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void window.kiyeovoAPI.sendCallSignal({
        type: 'CALL_ICE',
        callId: context.callId,
        toPeerId: context.peerId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        usernameFragment: event.candidate.usernameFragment ?? null,
      });
    };

    pc.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      event.streams.forEach((stream) => {
        stream.getTracks().forEach((track) => {
          if (!this.remoteStream?.getTracks().some((existing) => existing.id === track.id)) {
            this.remoteStream?.addTrack(track);
          }
        });
      });
      this.attachRemoteAudio();
    };

    pc.onconnectionstatechange = () => {
      if (this.currentCall?.callId !== context.callId) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearDisconnectTimer();
        this.emit({
          type: 'state',
          callId: context.callId,
          peerId: context.peerId,
          state: 'active',
        });
        return;
      }
      if (state === 'disconnected') {
        this.scheduleDisconnect(context);
        return;
      }
      if (state === 'failed' || state === 'closed') {
        this.clearDisconnectTimer();
        void this.endCallInternal(context, state === 'failed' ? 'failed' : 'disconnect', true);
      }
    };

    return pc;
  }

  private scheduleDisconnect(context: CurrentCall): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      void this.endCallInternal(context, 'disconnect', true);
    }, 5000);
  }

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private scheduleOutgoingRingTimeout(context: CurrentCall): void {
    this.clearRingTimeout();
    this.ringTimeoutTimer = setTimeout(() => {
      if (!this.currentCall) return;
      if (this.currentCall.callId !== context.callId || this.currentCall.peerId !== context.peerId) return;
      void this.endCallInternal(context, 'timeout', true);
    }, CallService.RING_TIMEOUT_MS);
  }

  private clearRingTimeout(): void {
    if (!this.ringTimeoutTimer) return;
    clearTimeout(this.ringTimeoutTimer);
    this.ringTimeoutTimer = null;
  }

  private attachRemoteAudio(): void {
    if (!this.remoteStream) return;
    if (!this.remoteAudio) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      audio.style.display = 'none';
      document.body.appendChild(audio);
      this.remoteAudio = audio;
    }
    this.remoteAudio.srcObject = this.remoteStream;
    void this.remoteAudio.play().catch(() => {
      // Playback can fail due to browser policy before user gesture.
    });
  }

  private async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream = stream;
    return stream;
  }

  private async addLocalAudioTracks(pc: RTCPeerConnection): Promise<void> {
    const stream = await this.getLocalStream();
    stream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
  }

  private async flushPendingRemoteIce(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    const queued = [...this.pendingRemoteIce];
    this.pendingRemoteIce = [];
    for (const candidate of queued) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  private async setRemoteAnswerSdp(answerSdp: string): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('No active peer connection for call answer');
    }
    await this.peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answerSdp,
    });
    await this.flushPendingRemoteIce();
  }

  private async addRemoteIce(signal: CallSignal): Promise<void> {
    if (!this.peerConnection || signal.type !== 'CALL_ICE' || !signal.candidate) return;
    const candidate: RTCIceCandidateInit = {
      candidate: signal.candidate,
      sdpMid: signal.sdpMid ?? null,
      sdpMLineIndex: signal.sdpMLineIndex ?? null,
      usernameFragment: signal.usernameFragment ?? null,
    };
    if (!this.peerConnection.remoteDescription) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  private stopStreams(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }
  }

  private closePeerConnection(): void {
    if (!this.peerConnection) return;
    try {
      this.peerConnection.close();
    } catch {
      // Best-effort close.
    }
    this.peerConnection = null;
    this.pendingRemoteIce = [];
  }

  private async endCallInternal(
    context: CurrentCall,
    reason: 'hangup' | 'disconnect' | 'failed' | 'rejected' | 'busy' | 'timeout',
    sendHangup: boolean,
  ): Promise<void> {
    let hangupError: string | null = null;
    if (sendHangup && this.sentDisconnectHangupCallId !== context.callId) {
      this.sentDisconnectHangupCallId = context.callId;
      const hangupReason = reason === 'disconnect' || reason === 'failed' ? reason : 'hangup';
      try {
        const response = await window.kiyeovoAPI.hangupCall(context.peerId, context.callId, hangupReason);
        if (!response.success) {
          hangupError = response.error || 'Failed to notify remote call end';
        }
      } catch (error: unknown) {
        hangupError = error instanceof Error ? error.message : 'Failed to notify remote call end';
      }
    }

    this.clearDisconnectTimer();
    this.clearRingTimeout();
    this.closePeerConnection();
    this.stopStreams();
    this.currentCall = null;
    this.emit({
      type: 'state',
      callId: context.callId,
      peerId: context.peerId,
      state: 'ended',
      reason,
    });
    if (hangupError) {
      this.emit({ type: 'error', message: hangupError });
    }
  }

  async startOutgoingCall(peerId: string): Promise<{ success: boolean; callId?: string; error?: string }> {
    if (this.currentCall) {
      return { success: false, error: 'Another call is already in progress' };
    }

    const callId = crypto.randomUUID();
    const context: CurrentCall = {
      callId,
      peerId,
      direction: 'outgoing',
    };

    try {
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);
      await this.addLocalAudioTracks(this.peerConnection);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      const offerSdp = this.peerConnection.localDescription?.sdp;
      if (!offerSdp) {
        throw new Error('Failed to create call offer');
      }

      const response = await window.kiyeovoAPI.startCall(peerId, callId, offerSdp);
      if (!response.success) {
        throw new Error(response.error || 'Failed to start call');
      }
      this.scheduleOutgoingRingTimeout(context);
      return { success: true, callId };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to start call';
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.currentCall = null;
      return { success: false, error: message };
    }
  }

  async acceptIncomingCall(params: {
    callId: string;
    peerId: string;
    offerSdp: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentCall && (this.currentCall.callId !== params.callId || this.currentCall.peerId !== params.peerId)) {
      return { success: false, error: 'Another call is already in progress' };
    }
    if (
      this.currentCall
      && this.currentCall.callId === params.callId
      && this.currentCall.peerId === params.peerId
      && this.peerConnection
    ) {
      return { success: false, error: 'Call accept already in progress' };
    }

    const context: CurrentCall = {
      callId: params.callId,
      peerId: params.peerId,
      direction: 'incoming',
    };

    try {
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);
      await this.addLocalAudioTracks(this.peerConnection);

      await this.peerConnection.setRemoteDescription({
        type: 'offer',
        sdp: params.offerSdp,
      });
      await this.flushPendingRemoteIce();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      const answerSdp = this.peerConnection.localDescription?.sdp;
      if (!answerSdp) {
        throw new Error('Failed to create call answer');
      }

      const response = await window.kiyeovoAPI.acceptCall(params.peerId, params.callId, answerSdp);
      if (!response.success) {
        throw new Error(response.error || 'Failed to accept call');
      }
      this.emit({
        type: 'state',
        callId: context.callId,
        peerId: context.peerId,
        state: 'connecting',
      });
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to accept call';
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.currentCall = null;
      return { success: false, error: message };
    }
  }

  async rejectIncomingCall(
    peerId: string,
    callId: string,
    reason: 'rejected' | 'timeout' | 'offline' | 'policy' = 'rejected',
  ): Promise<{ success: boolean; error?: string }> {
    const response = await window.kiyeovoAPI.rejectCall(peerId, callId, reason);
    if (!response.success) {
      const message = response.error || 'Failed to reject call';
      return { success: false, error: message };
    }
    if (this.currentCall?.callId === callId && this.currentCall.peerId === peerId) {
      this.clearDisconnectTimer();
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.currentCall = null;
    }
    this.emit({
      type: 'state',
      callId,
      peerId,
      state: 'ended',
      reason,
    });
    return { success: true };
  }

  async hangupCall(
    peerId: string,
    callId: string,
    reason: 'hangup' | 'disconnect' | 'failed' = 'hangup',
  ): Promise<{ success: boolean; error?: string }> {
    let response: { success: boolean; error?: string | null };
    try {
      response = await window.kiyeovoAPI.hangupCall(peerId, callId, reason);
    } catch (error: unknown) {
      response = {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to hang up call',
      };
    }

    const matchesCurrentCall = this.currentCall?.callId === callId && this.currentCall.peerId === peerId;
    if (matchesCurrentCall) {
      this.clearDisconnectTimer();
      this.clearRingTimeout();
      this.closePeerConnection();
      this.stopStreams();
      this.currentCall = null;
    }

    this.emit({
      type: 'state',
      callId,
      peerId,
      state: 'ended',
      reason,
    });
    if (!response.success) {
      const message = response.error ?? 'Failed to hang up call';
      return { success: false, error: message };
    }
    return { success: true };
  }

  async handleSignal(signal: CallSignal): Promise<void> {
    if (!this.currentCall) return;
    if (signal.callId !== this.currentCall.callId || signal.fromPeerId !== this.currentCall.peerId) return;

    try {
      switch (signal.type) {
        case 'CALL_ANSWER':
          if (!signal.answerSdp) return;
          this.clearRingTimeout();
          await this.setRemoteAnswerSdp(signal.answerSdp);
          this.emit({
            type: 'state',
            callId: signal.callId,
            peerId: signal.fromPeerId,
            state: 'connecting',
          });
          return;
        case 'CALL_ICE':
          await this.addRemoteIce(signal);
          return;
        case 'CALL_REJECT':
        case 'CALL_BUSY':
        case 'CALL_END': {
          const reason = signal.reason ?? (signal.type === 'CALL_BUSY' ? 'busy' : 'hangup');
          this.clearDisconnectTimer();
          this.clearRingTimeout();
          this.closePeerConnection();
          this.stopStreams();
          this.currentCall = null;
          this.emit({
            type: 'state',
            callId: signal.callId,
            peerId: signal.fromPeerId,
            state: 'ended',
            reason,
          });
          return;
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to process call signal';
      this.emit({ type: 'error', message });
      if (this.currentCall) {
        await this.endCallInternal(this.currentCall, 'failed', true);
      }
    }
  }

  syncWithCoreState(event: CallStateChangedEvent): void {
    if (
      this.currentCall
      && this.currentCall.callId === event.callId
      && this.currentCall.peerId === event.peerId
      && event.state !== 'ringing_out'
    ) {
      this.clearRingTimeout();
    }

    if (event.state === 'ended') {
      if (this.currentCall && this.currentCall.callId === event.callId && this.currentCall.peerId === event.peerId) {
        this.clearDisconnectTimer();
        this.clearRingTimeout();
        this.closePeerConnection();
        this.stopStreams();
        this.currentCall = null;
      }
      return;
    }

    if (!this.currentCall) {
      this.currentCall = {
        callId: event.callId,
        peerId: event.peerId,
        direction: event.direction,
      };
    }
  }

  dispose(): void {
    this.clearDisconnectTimer();
    this.clearRingTimeout();
    this.closePeerConnection();
    this.stopStreams();
    this.currentCall = null;
    if (this.remoteAudio) {
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
  }
}

export const callService = new CallService();
