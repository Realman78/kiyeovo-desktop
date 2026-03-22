import type { CallDirection, CallSignal, CallStateChangedEvent } from '../../types';
import { DEFAULT_WEBRTC_ICE_SERVERS } from '../../../core/default-bootstrap-nodes';

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
  private static readonly ICE_STATS_LOG_INTERVAL_MS = 2_500;
  private peerConnection: RTCPeerConnection | null = null;
  private currentCall: CurrentCall | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private iceStatsTimer: ReturnType<typeof setInterval> | null = null;
  private lastLoggedSelectedPairKey: string | null = null;
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
    return DEFAULT_WEBRTC_ICE_SERVERS.map((server) => ({ ...server }));
  }

  private log(context: CurrentCall | null, message: string): void {
    const callTag = context
      ? `call=${context.callId.slice(0, 8)} peer=${context.peerId.slice(-8)} dir=${context.direction}`
      : 'call=none';
    console.log(`[CALL][RTC] ${callTag} ${message}`);
  }

  private describeIceServer(server: RTCIceServer): string {
    const urls = Array.isArray(server.urls) ? server.urls.join(',') : server.urls;
    const auth = server.username && server.credential ? 'auth=yes' : 'auth=no';
    return `${urls} ${auth}`;
  }

  private describeCandidateLine(candidateLine: string): string {
    const tokens = candidateLine.trim().split(/\s+/);
    const protocol = tokens[2] ?? 'unknown';
    const address = tokens[4] ?? 'unknown';
    const port = tokens[5] ?? 'unknown';
    const typeIdx = tokens.indexOf('typ');
    const type = typeIdx !== -1 ? (tokens[typeIdx + 1] ?? 'unknown') : 'unknown';
    const tcpTypeIdx = tokens.indexOf('tcptype');
    const tcpType = tcpTypeIdx !== -1 ? (tokens[tcpTypeIdx + 1] ?? 'unknown') : null;
    const relatedAddrIdx = tokens.indexOf('raddr');
    const relatedPortIdx = tokens.indexOf('rport');
    const related = relatedAddrIdx !== -1 && relatedPortIdx !== -1
      ? `${tokens[relatedAddrIdx + 1]}:${tokens[relatedPortIdx + 1]}`
      : null;

    return `type=${type} proto=${protocol}${tcpType ? ` tcp=${tcpType}` : ''} addr=${address}:${port}${related ? ` related=${related}` : ''}`;
  }

  private formatCandidateStat(candidate: unknown): string {
    if (!candidate || typeof candidate !== 'object') return 'n/a';
    const stat = candidate as Record<string, unknown>;
    const type = typeof stat.candidateType === 'string' ? stat.candidateType : 'unknown';
    const protocol = typeof stat.protocol === 'string' ? stat.protocol : 'unknown';
    const relayProtocol = typeof stat.relayProtocol === 'string' ? `/relay:${stat.relayProtocol}` : '';
    const address = typeof stat.address === 'string'
      ? stat.address
      : (typeof stat.ip === 'string' ? stat.ip : 'unknown');
    const port = typeof stat.port === 'number' ? String(stat.port) : 'unknown';
    return `${type}/${protocol}${relayProtocol}@${address}:${port}`;
  }

  private async logSelectedCandidatePair(pc: RTCPeerConnection, context: CurrentCall): Promise<void> {
    try {
      const stats = await pc.getStats();
      let selectedPair: unknown = null;

      for (const report of stats.values()) {
        const transport = report as unknown as Record<string, unknown>;
        if (transport.type !== 'transport') continue;
        const selectedCandidatePairId = transport.selectedCandidatePairId;
        if (typeof selectedCandidatePairId !== 'string') continue;
        selectedPair = stats.get(selectedCandidatePairId);
        if (selectedPair) break;
      }

      if (!selectedPair) {
        for (const report of stats.values()) {
          const pair = report as unknown as Record<string, unknown>;
          if (pair.type !== 'candidate-pair') continue;
          const isSelected = pair.selected === true
            || (pair.nominated === true && pair.state === 'succeeded');
          if (isSelected) {
            selectedPair = pair;
            break;
          }
        }
      }

      if (!selectedPair || typeof selectedPair !== 'object') return;
      const pair = selectedPair as Record<string, unknown>;
      const localCandidateId = typeof pair.localCandidateId === 'string' ? pair.localCandidateId : null;
      const remoteCandidateId = typeof pair.remoteCandidateId === 'string' ? pair.remoteCandidateId : null;
      const localCandidate = localCandidateId ? stats.get(localCandidateId) : null;
      const remoteCandidate = remoteCandidateId ? stats.get(remoteCandidateId) : null;

      const localDesc = this.formatCandidateStat(localCandidate);
      const remoteDesc = this.formatCandidateStat(remoteCandidate);
      const state = typeof pair.state === 'string' ? pair.state : 'unknown';
      const nominated = pair.nominated === true ? 'true' : (pair.nominated === false ? 'false' : 'n/a');
      const rttMs = typeof pair.currentRoundTripTime === 'number'
        ? Math.round(pair.currentRoundTripTime * 1000)
        : null;
      const pairKey = `${state}|${nominated}|${localDesc}|${remoteDesc}|${rttMs ?? 'n/a'}`;
      if (pairKey === this.lastLoggedSelectedPairKey) return;
      this.lastLoggedSelectedPairKey = pairKey;

      this.log(
        context,
        `[ICE][SELECTED_PAIR] state=${state} nominated=${nominated} rttMs=${rttMs ?? 'n/a'} local=${localDesc} remote=${remoteDesc}`,
      );
    } catch (error: unknown) {
      this.log(context, `[ICE][STATS_ERROR] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startIceStatsMonitor(pc: RTCPeerConnection, context: CurrentCall): void {
    this.stopIceStatsMonitor();
    this.iceStatsTimer = setInterval(() => {
      if (!this.currentCall) {
        this.stopIceStatsMonitor();
        return;
      }
      if (this.currentCall.callId !== context.callId || this.currentCall.peerId !== context.peerId) {
        this.stopIceStatsMonitor();
        return;
      }
      void this.logSelectedCandidatePair(pc, context);
    }, CallService.ICE_STATS_LOG_INTERVAL_MS);
    void this.logSelectedCandidatePair(pc, context);
  }

  private stopIceStatsMonitor(): void {
    if (!this.iceStatsTimer) return;
    clearInterval(this.iceStatsTimer);
    this.iceStatsTimer = null;
    this.lastLoggedSelectedPairKey = null;
  }

  private createPeerConnection(context: CurrentCall): RTCPeerConnection {
    const iceServers = this.getIceServers();
    this.log(
      context,
      `[PC][CREATE] iceTransportPolicy=all iceServers=${iceServers.map((server) => this.describeIceServer(server)).join(' | ') || 'none'}`,
    );
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.log(context, `[ICE][LOCAL_CANDIDATE] gathering_complete state=${pc.iceGatheringState}`);
        return;
      }
      this.log(
        context,
        `[ICE][LOCAL_CANDIDATE] mid=${event.candidate.sdpMid ?? 'n/a'} mline=${event.candidate.sdpMLineIndex ?? 'n/a'} ${this.describeCandidateLine(event.candidate.candidate)}`,
      );
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
      let remoteTrackCount = 0;
      event.streams.forEach((stream) => {
        remoteTrackCount += stream.getTracks().length;
      });
      this.log(
        context,
        `[MEDIA][REMOTE_TRACK] streams=${event.streams.length} tracks=${remoteTrackCount}`,
      );
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

    pc.onicegatheringstatechange = () => {
      this.log(context, `[ICE][GATHERING_STATE] ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      this.log(context, `[ICE][CONNECTION_STATE] ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.startIceStatsMonitor(pc, context);
      } else if (pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
        this.stopIceStatsMonitor();
      }
    };

    pc.onsignalingstatechange = () => {
      this.log(context, `[PC][SIGNALING_STATE] ${pc.signalingState}`);
    };

    pc.onconnectionstatechange = () => {
      if (this.currentCall?.callId !== context.callId) return;
      const state = pc.connectionState;
      this.log(context, `[PC][CONNECTION_STATE] ${state}`);
      if (state === 'connected') {
        this.clearDisconnectTimer();
        this.startIceStatsMonitor(pc, context);
        this.emit({
          type: 'state',
          callId: context.callId,
          peerId: context.peerId,
          state: 'active',
        });
        return;
      }
      if (state === 'disconnected') {
        this.log(context, '[PC][CONNECTION_STATE] disconnected, waiting 5s before forced end');
        this.scheduleDisconnect(context);
        return;
      }
      if (state === 'failed' || state === 'closed') {
        this.stopIceStatsMonitor();
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
    this.log(this.currentCall, '[MEDIA][LOCAL] requesting microphone stream');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.log(this.currentCall, `[MEDIA][LOCAL] stream ready tracks=${stream.getAudioTracks().length}`);
    this.localStream = stream;
    return stream;
  }

  private async addLocalAudioTracks(pc: RTCPeerConnection): Promise<void> {
    const stream = await this.getLocalStream();
    this.log(this.currentCall, `[MEDIA][LOCAL] attaching ${stream.getAudioTracks().length} audio track(s)`);
    stream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
  }

  private async flushPendingRemoteIce(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    const queued = [...this.pendingRemoteIce];
    this.pendingRemoteIce = [];
    this.log(this.currentCall, `[ICE][REMOTE_CANDIDATE] flushing queued=${queued.length}`);
    for (const candidate of queued) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  private async setRemoteAnswerSdp(answerSdp: string): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('No active peer connection for call answer');
    }
    this.log(this.currentCall, `[SDP][REMOTE_ANSWER] set start len=${answerSdp.length}`);
    await this.peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answerSdp,
    });
    this.log(this.currentCall, '[SDP][REMOTE_ANSWER] set success');
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
    this.log(
      this.currentCall,
      `[ICE][REMOTE_CANDIDATE] mid=${candidate.sdpMid ?? 'n/a'} mline=${candidate.sdpMLineIndex ?? 'n/a'} ${this.describeCandidateLine(signal.candidate)}`,
    );
    if (!this.peerConnection.remoteDescription) {
      this.log(this.currentCall, '[ICE][REMOTE_CANDIDATE] queued (remote description missing)');
      this.pendingRemoteIce.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
    this.log(this.currentCall, '[ICE][REMOTE_CANDIDATE] applied');
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
    this.stopIceStatsMonitor();
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
    this.log(context, '[FLOW][OUTGOING] start');

    try {
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);
      await this.addLocalAudioTracks(this.peerConnection);
      const offer = await this.peerConnection.createOffer();
      this.log(context, `[SDP][LOCAL_OFFER] created len=${offer.sdp?.length ?? 0}`);
      await this.peerConnection.setLocalDescription(offer);
      const offerSdp = this.peerConnection.localDescription?.sdp;
      if (!offerSdp) {
        throw new Error('Failed to create call offer');
      }
      this.log(context, `[SDP][LOCAL_OFFER] set success len=${offerSdp.length}`);

      const response = await window.kiyeovoAPI.startCall(peerId, callId, offerSdp);
      if (!response.success) {
        throw new Error(response.error || 'Failed to start call');
      }
      this.log(context, '[FLOW][OUTGOING] offer sent to core');
      this.scheduleOutgoingRingTimeout(context);
      return { success: true, callId };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to start call';
      this.log(context, `[FLOW][OUTGOING] failed reason=${message}`);
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
    this.log(context, '[FLOW][INCOMING] accept start');

    try {
      this.currentCall = context;
      this.sentDisconnectHangupCallId = null;
      this.peerConnection = this.createPeerConnection(context);
      await this.addLocalAudioTracks(this.peerConnection);

      this.log(context, `[SDP][REMOTE_OFFER] set start len=${params.offerSdp.length}`);
      await this.peerConnection.setRemoteDescription({
        type: 'offer',
        sdp: params.offerSdp,
      });
      this.log(context, '[SDP][REMOTE_OFFER] set success');
      await this.flushPendingRemoteIce();

      const answer = await this.peerConnection.createAnswer();
      this.log(context, `[SDP][LOCAL_ANSWER] created len=${answer.sdp?.length ?? 0}`);
      await this.peerConnection.setLocalDescription(answer);
      const answerSdp = this.peerConnection.localDescription?.sdp;
      if (!answerSdp) {
        throw new Error('Failed to create call answer');
      }
      this.log(context, `[SDP][LOCAL_ANSWER] set success len=${answerSdp.length}`);

      const response = await window.kiyeovoAPI.acceptCall(params.peerId, params.callId, answerSdp);
      if (!response.success) {
        throw new Error(response.error || 'Failed to accept call');
      }
      this.log(context, '[FLOW][INCOMING] answer sent to core');
      this.emit({
        type: 'state',
        callId: context.callId,
        peerId: context.peerId,
        state: 'connecting',
      });
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to accept call';
      this.log(context, `[FLOW][INCOMING] accept failed reason=${message}`);
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
    this.log(this.currentCall, `[SIGNAL][IN] type=${signal.type} ts=${signal.timestamp}`);

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
      this.log(this.currentCall, `[SIGNAL][ERROR] ${message}`);
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
    this.stopIceStatsMonitor();
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
