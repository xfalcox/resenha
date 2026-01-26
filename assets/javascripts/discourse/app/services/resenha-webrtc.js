import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";

export default class ResenhaWebrtcService extends Service {
  @service currentUser;
  @service messageBus;
  @service siteSettings;
  @service("resenha-rooms") resenhaRooms;

  @tracked localStream;
  @tracked audioEnabled = true;
  @tracked remoteStreamsRevision = 0;

  #peerConnections = new Map();
  #offerRetryTimers = new Map();
  #remoteStreams = new Map();
  #peerReconnectTimers = new Map();
  #roomSubscriptions = new Map();
  #activeRoomIds = new Set();
  #speakingMonitors = new Map();
  #pendingPlaybackElements = new WeakSet();
  #heartbeatTimers = new Map();
  #signalQueues = new Map();
  #signalFlushTimers = new Map();
  #httpSignalQueues = new Map();
  #httpSignalFlushTimers = new Map();
  #pendingCandidates = new Map();
  #restartAttempts = new Map();
  #offerRetryAttempts = new Map();
  #connectionTimeouts = new Map();

  static #candidateBatchDelayMs = 75;
  static #candidateBatchSize = 5;
  static #httpBatchDelayMs = 25;
  static #maxRestartAttempts = 5;
  static #maxOfferRetries = 3;
  static #connectionTimeoutMs = 30000;

  willDestroy() {
    super.willDestroy(...arguments);
    this.#stopLocalStream();
    this.#roomSubscriptions.forEach((callback, channel) => {
      this.messageBus.unsubscribe(channel, callback);
    });
    this.#speakingMonitors.forEach((monitor) => monitor?.stop?.());
    this.#speakingMonitors.clear();
    this.#heartbeatTimers.forEach((timer) => clearInterval(timer));
    this.#heartbeatTimers.clear();
    this.#peerReconnectTimers.forEach((timer) => clearTimeout(timer));
    this.#peerReconnectTimers.clear();
    this.#signalFlushTimers.forEach((timer) => clearTimeout(timer));
    this.#signalFlushTimers.clear();
    this.#httpSignalFlushTimers.forEach((timer) => clearTimeout(timer));
    this.#httpSignalFlushTimers.clear();
    this.#httpSignalQueues.forEach((entry) => {
      entry?.pending?.forEach((pending) => pending.resolve?.());
    });
    this.#httpSignalQueues.clear();
    this.#signalQueues.clear();
    this.#pendingCandidates.clear();
    this.#restartAttempts.clear();
    this.#offerRetryAttempts.clear();
    this.#connectionTimeouts.forEach((timer) => clearTimeout(timer));
    this.#connectionTimeouts.clear();
  }

  /**
   * Parse ICE servers from site settings (STUN and TURN)
   * @returns {Array<{urls: string, username?: string, credential?: string}>} Array of ICE server configurations
   */
  get iceServers() {
    const servers = [];

    // Add STUN servers
    const stunServers = this.siteSettings.resenha_stun_servers;
    if (stunServers) {
      stunServers
        .split("|")
        .map((url) => url.trim())
        .filter(Boolean)
        .forEach((url) => {
          servers.push({ urls: url });
        });
    }

    // Add TURN servers with credentials
    const turnServers = this.siteSettings.resenha_turn_servers;
    if (turnServers) {
      const username = this.siteSettings.resenha_turn_username;
      const credential = this.siteSettings.resenha_turn_credential;

      turnServers
        .split("|")
        .map((url) => url.trim())
        .filter(Boolean)
        .forEach((url) => {
          const server = { urls: url };
          if (username) {
            server.username = username;
          }
          if (credential) {
            server.credential = credential;
          }
          servers.push(server);
        });
    }

    return servers;
  }

  get remoteStreams() {
    this.remoteStreamsRevision;
    return Array.from(this.#remoteStreams.values())
      .filter(Array.isArray)
      .flat()
      .map((entry) => entry.stream);
  }

  remoteStreamsFor(roomId) {
    this.remoteStreamsRevision;
    return (this.#remoteStreams.get(roomId) || []).map((entry) => entry.stream);
  }

  connectionStateFor(roomId) {
    return this.#activeRoomIds.has(roomId) ? "connected" : "idle";
  }

  async join(room) {
    if (!room?.id) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[resenha] joining room ${room.id}`);

    if (!this.localStream) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        // eslint-disable-next-line no-console
        console.log("[resenha] local stream obtained");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to obtain local stream", error);
        return;
      }
    }

    // Subscribe to MessageBus BEFORE joining to avoid missing the participant broadcast
    this.#subscribeToRoom(room.id);
    this.#activeRoomIds.add(room.id);

    const response = await ajax(`/resenha/rooms/${room.id}/join`, {
      type: "POST",
    });

    // eslint-disable-next-line no-console
    console.log(
      `[resenha] join response, active_participants:`,
      response?.room?.active_participants
    );

    this.#addLocalParticipant(room.id);
    this.#ensureAudioMonitor(room.id, this.currentUser?.id, this.localStream);
    this.#startHeartbeat(room.id);

    // Process the initial participant list from the join response
    if (response?.room?.active_participants) {
      await this.#handleParticipants(room.id, {
        participants: response.room.active_participants,
      });
    }
  }

  leave(room) {
    if (!room?.id) {
      return;
    }

    ajax(`/resenha/rooms/${room.id}/leave`, { type: "DELETE" });
    this.#activeRoomIds.delete(room.id);
    this.#removeLocalParticipant(room.id);
    this.#teardownAudioMonitor(room.id, this.currentUser?.id);
    this.#stopHeartbeat(room.id);
    this.#teardownRoom(room.id);
    this.#stopLocalStream();
  }

  @action
  attachStream(stream, element) {
    if (!element || !stream) {
      return;
    }

    if (element.srcObject === stream) {
      return;
    }

    element.srcObject = stream;
    element.autoplay = true;
    element.playsInline = true;
    element.muted = stream === this.localStream;
    if (element.muted) {
      element.volume = 0;
    }

    if (typeof element.play === "function") {
      try {
        const playPromise = element.play();
        playPromise?.catch?.((error) => {
          if (error?.name === "NotAllowedError") {
            this.#schedulePlaybackResume(element);
          } else {
            // eslint-disable-next-line no-console
            console.warn("[resenha] audio element failed to play", error);
          }
        });
      } catch (error) {
        if (error?.name === "NotAllowedError") {
          this.#schedulePlaybackResume(element);
        } else {
          // eslint-disable-next-line no-console
          console.warn("[resenha] audio element failed to play", error);
        }
      }
    }
  }

  remotePeerKey(roomId, userId) {
    return `${roomId}:${userId}`;
  }

  #subscribeToRoom(roomId) {
    if (this.#roomSubscriptions.has(roomId)) {
      // eslint-disable-next-line no-console
      console.log(`[resenha] already subscribed to room ${roomId}`);
      return;
    }

    const channel = `/resenha/rooms/${roomId}`;
    // eslint-disable-next-line no-console
    console.log(`[resenha] subscribing to MessageBus channel: ${channel}`);
    const callback = (payload) => this.#handleRoomMessage(roomId, payload);
    this.messageBus.subscribe(channel, callback);
    this.#roomSubscriptions.set(roomId, callback);
  }

  #teardownRoom(roomId) {
    const channel = `/resenha/rooms/${roomId}`;
    if (this.#roomSubscriptions.has(roomId)) {
      this.messageBus.unsubscribe(channel, this.#roomSubscriptions.get(roomId));
      this.#roomSubscriptions.delete(roomId);
    }

    const peers = this.#peerConnections.get(roomId) || new Map();
    peers.forEach((pc, remoteUserId) => {
      pc.close();
      this.#clearOfferRetry(roomId, remoteUserId);
      this.#clearPeerRestart(roomId, remoteUserId);
      this.#clearConnectionTimeout(roomId, remoteUserId);
      this.#clearPendingCandidates(roomId, remoteUserId);
    });
    this.#peerConnections.delete(roomId);
    this.#removeAllRemoteStreams(roomId);
    this.#teardownRoomMonitors(roomId);
    this.#clearSignalQueuesForRoom(roomId);
    this.#clearHttpSignalQueue(roomId);
  }

  #clearPendingCandidates(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    this.#pendingCandidates.delete(key);
  }

  async #createPeerConnection(roomId, remoteUserId) {
    let roomPeers = this.#peerConnections.get(roomId);
    if (!roomPeers) {
      roomPeers = new Map();
      this.#peerConnections.set(roomId, roomPeers);
    }

    if (roomPeers.has(remoteUserId)) {
      return roomPeers.get(remoteUserId);
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    roomPeers.set(remoteUserId, pc);

    this.localStream?.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.#registerRemoteStream(roomId, remoteUserId, stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidatePayload =
          typeof event.candidate.toJSON === "function"
            ? event.candidate.toJSON()
            : {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              };

        this.#sendSignal(roomId, remoteUserId, {
          type: "candidate",
          candidate: candidatePayload,
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn("[resenha] failed to send candidate", error);
        });
      } else {
        this.#flushQueuedSignals(roomId, remoteUserId).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn("[resenha] failed to flush signal queue", error);
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.#clearOfferRetry(roomId, remoteUserId);
        this.#clearPeerRestart(roomId, remoteUserId);
        this.#clearConnectionTimeout(roomId, remoteUserId);
        return;
      }

      if (pc.connectionState === "failed") {
        this.#clearOfferRetry(roomId, remoteUserId);
        this.#clearConnectionTimeout(roomId, remoteUserId);
        this.#schedulePeerRestart(roomId, remoteUserId, { immediate: true });
        return;
      }

      if (pc.connectionState === "disconnected") {
        this.#schedulePeerRestart(roomId, remoteUserId);
        return;
      }

      if (pc.connectionState === "closed") {
        this.#clearOfferRetry(roomId, remoteUserId);
        this.#clearPeerRestart(roomId, remoteUserId);
        this.#clearConnectionTimeout(roomId, remoteUserId);
        this.#removeRemoteStream(roomId, remoteUserId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        this.#schedulePeerRestart(roomId, remoteUserId, { immediate: true });
      } else if (pc.iceConnectionState === "disconnected") {
        this.#schedulePeerRestart(roomId, remoteUserId);
      }
    };

    // Start connection establishment timeout
    this.#startConnectionTimeout(roomId, remoteUserId, pc);

    return pc;
  }

  #startConnectionTimeout(roomId, remoteUserId, pc) {
    const key = this.remotePeerKey(roomId, remoteUserId);

    if (this.#connectionTimeouts.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#connectionTimeouts.delete(key);

      if (
        pc.connectionState !== "connected" &&
        pc.connectionState !== "closed"
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] connection timeout (${ResenhaWebrtcService.#connectionTimeoutMs}ms) for user ${remoteUserId}, state: ${pc.connectionState}`
        );
        this.#schedulePeerRestart(roomId, remoteUserId, { immediate: true });
      }
    }, ResenhaWebrtcService.#connectionTimeoutMs);

    this.#connectionTimeouts.set(key, timer);
  }

  #clearConnectionTimeout(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#connectionTimeouts.get(key);

    if (timer) {
      clearTimeout(timer);
      this.#connectionTimeouts.delete(key);
    }
  }

  async #handleRoomMessage(roomId, payload) {
    // eslint-disable-next-line no-console
    console.log(
      `[resenha] 📨 MessageBus message: room=${roomId}, type=${payload.type}, active=${this.#activeRoomIds.has(roomId)}`
    );

    if (!this.#activeRoomIds.has(roomId)) {
      return;
    }

    if (payload.type === "signal") {
      await this.#handleSignal(roomId, payload);
    } else if (payload.type === "participants") {
      await this.#handleParticipants(roomId, payload);
    }
  }

  async #handleSignal(roomId, payload) {
    const remoteUserId = Number(payload.sender_id);
    const data = payload.data;
    // eslint-disable-next-line no-console
    console.log(
      `[resenha] 📥 received ${data.type} from user ${remoteUserId} in room ${roomId}`
    );
    const pc = await this.#createPeerConnection(roomId, remoteUserId);

    if (data.type === "offer") {
      this.#clearOfferRetry(roomId, remoteUserId);

      // Handle glare condition: both peers send offers simultaneously
      if (pc.signalingState === "have-local-offer") {
        // Use polite peer pattern: lower user ID yields
        if (this.currentUser?.id < remoteUserId) {
          // eslint-disable-next-line no-console
          console.log(
            `[resenha] glare detected, rolling back local offer for user ${remoteUserId}`
          );
          await pc.setLocalDescription({ type: "rollback" });
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[resenha] glare detected, ignoring remote offer from user ${remoteUserId}`
          );
          return;
        }
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        await this.#flushPendingCandidates(roomId, remoteUserId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#sendSignal(roomId, remoteUserId, answer).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn("[resenha] failed to send answer", error);
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] failed to handle offer from user ${remoteUserId}`,
          error
        );
      }
    } else if (data.type === "answer") {
      this.#clearOfferRetry(roomId, remoteUserId);

      if (pc.signalingState !== "have-local-offer") {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] ignoring answer in state ${pc.signalingState} from user ${remoteUserId}`
        );
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        await this.#flushPendingCandidates(roomId, remoteUserId, pc);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] failed to handle answer from user ${remoteUserId}`,
          error
        );
      }
    } else if (data.type === "candidate") {
      this.#clearOfferRetry(roomId, remoteUserId);

      // Queue candidates if remote description not yet set
      if (!pc.remoteDescription) {
        this.#queuePendingCandidate(roomId, remoteUserId, data.candidate);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] failed to add ICE candidate from user ${remoteUserId}`,
          error
        );
      }
    }
  }

  #queuePendingCandidate(roomId, remoteUserId, candidate) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const queue = this.#pendingCandidates.get(key) || [];
    queue.push(candidate);
    this.#pendingCandidates.set(key, queue);
    // eslint-disable-next-line no-console
    console.log(
      `[resenha] queued ICE candidate for user ${remoteUserId} (${queue.length} pending)`
    );
  }

  async #flushPendingCandidates(roomId, remoteUserId, pc) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const candidates = this.#pendingCandidates.get(key);

    if (!candidates?.length) {
      return;
    }

    this.#pendingCandidates.delete(key);
    // eslint-disable-next-line no-console
    console.log(
      `[resenha] flushing ${candidates.length} queued ICE candidates for user ${remoteUserId}`
    );

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resenha] failed to add queued ICE candidate for user ${remoteUserId}`,
          error
        );
      }
    }
  }

  async #sendSignal(roomId, recipientId, payload) {
    if (!roomId || !recipientId || !payload) {
      return Promise.resolve();
    }

    if (payload.type === "candidate") {
      this.#queueSignal(roomId, recipientId, payload);
      return Promise.resolve();
    }

    await this.#flushQueuedSignals(roomId, recipientId);
    await this.#postSignals(roomId, recipientId, [payload]);
  }

  #queueSignal(roomId, recipientId, payload) {
    const key = this.remotePeerKey(roomId, recipientId);
    const queue = this.#signalQueues.get(key) || [];
    queue.push(payload);
    this.#signalQueues.set(key, queue);

    if (queue.length >= ResenhaWebrtcService.#candidateBatchSize) {
      this.#flushQueuedSignals(roomId, recipientId).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to flush signal queue", error);
      });
      return;
    }

    const existingTimer = this.#signalFlushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.#signalFlushTimers.delete(key);
      this.#flushQueuedSignals(roomId, recipientId).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to flush signal queue", error);
      });
    }, ResenhaWebrtcService.#candidateBatchDelayMs);

    this.#signalFlushTimers.set(key, timer);
  }

  async #flushQueuedSignals(roomId, recipientId) {
    const key = this.remotePeerKey(roomId, recipientId);
    const queue = this.#signalQueues.get(key);

    if (!queue?.length) {
      return;
    }

    this.#signalQueues.delete(key);

    const timer = this.#signalFlushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.#signalFlushTimers.delete(key);
    }

    await this.#postSignals(roomId, recipientId, queue);
  }

  async #postSignals(roomId, recipientId, events) {
    if (!events?.length || !this.#activeRoomIds.has(roomId)) {
      return;
    }

    await this.#enqueueHttpSignals(roomId, recipientId, events);
  }

  async #handleParticipants(roomId, payload) {
    const participantIds = new Set(
      (payload.participants || []).map((participant) => Number(participant.id))
    );

    // eslint-disable-next-line no-console
    console.log(
      `[resenha] handleParticipants room=${roomId}, participants=[${Array.from(participantIds)}], currentUser=${this.currentUser?.id}`
    );

    let peers = this.#peerConnections.get(roomId);
    peers?.forEach((pc, remoteUserId) => {
      if (!participantIds.has(remoteUserId)) {
        pc.close();
        peers.delete(remoteUserId);
        this.#removeRemoteStream(roomId, remoteUserId);
        this.#clearPeerRestart(roomId, remoteUserId);
        this.#clearOfferRetry(roomId, remoteUserId);
        this.#clearConnectionTimeout(roomId, remoteUserId);
        this.#clearPendingCandidates(roomId, remoteUserId);
        this.#clearSignalQueue(roomId, remoteUserId);
      }
    });

    for (const participantId of participantIds) {
      if (participantId === this.currentUser?.id) {
        continue;
      }

      if (!peers?.has(participantId)) {
        // eslint-disable-next-line no-console
        console.log(
          `[resenha] creating peer connection to user ${participantId}`
        );
        await this.#createPeerConnection(roomId, participantId);
        peers = this.#peerConnections.get(roomId);

        if (this.currentUser?.id <= participantId) {
          // eslint-disable-next-line no-console
          console.log(`[resenha] initiating offer to user ${participantId}`);
          await this.#initiateOffer(roomId, participantId);
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[resenha] scheduling offer retry for user ${participantId}`
          );
          this.#scheduleOfferRetry(roomId, participantId);
        }
      }
    }
  }

  #currentUserParticipant() {
    if (!this.currentUser) {
      return null;
    }

    return {
      id: this.currentUser.id,
      username: this.currentUser.username,
      name: this.currentUser.name,
      avatar_template: this.currentUser.avatar_template,
    };
  }

  #addLocalParticipant(roomId) {
    const participant = this.#currentUserParticipant();
    if (!participant) {
      return;
    }

    this.resenhaRooms?.addParticipant(roomId, participant);
  }

  #removeLocalParticipant(roomId) {
    if (!this.currentUser) {
      return;
    }

    this.resenhaRooms?.removeParticipant(roomId, this.currentUser.id);
  }

  async #initiateOffer(roomId, remoteUserId) {
    const peers = this.#peerConnections.get(roomId);
    const pc = peers?.get(remoteUserId);

    if (!pc || pc.signalingState !== "stable") {
      return;
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.#sendSignal(roomId, remoteUserId, offer).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to send offer", error);
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[resenha] failed to create offer", error);
    }
  }

  #scheduleOfferRetry(roomId, remoteUserId, delay = 2000) {
    const key = this.remotePeerKey(roomId, remoteUserId);

    if (this.#offerRetryTimers.has(key)) {
      return;
    }

    const attempts = this.#offerRetryAttempts.get(key) || 0;

    if (attempts >= ResenhaWebrtcService.#maxOfferRetries) {
      // eslint-disable-next-line no-console
      console.warn(
        `[resenha] max offer retries (${ResenhaWebrtcService.#maxOfferRetries}) reached for user ${remoteUserId}`
      );
      return;
    }

    // Exponential backoff: 2s → 4s → 8s
    const actualDelay = delay * Math.pow(2, attempts);

    // eslint-disable-next-line no-console
    console.log(
      `[resenha] scheduling offer retry for user ${remoteUserId} (attempt ${attempts + 1}/${ResenhaWebrtcService.#maxOfferRetries}, delay ${actualDelay}ms)`
    );

    const timer = setTimeout(async () => {
      this.#offerRetryTimers.delete(key);
      this.#offerRetryAttempts.set(key, attempts + 1);
      await this.#initiateOffer(roomId, remoteUserId);
    }, actualDelay);

    this.#offerRetryTimers.set(key, timer);
  }

  #clearOfferRetry(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#offerRetryTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.#offerRetryTimers.delete(key);
    }

    // Reset retry attempts on successful signal
    this.#offerRetryAttempts.delete(key);
  }

  #ensureAudioMonitor(roomId, userId, stream) {
    if (!roomId || !userId || !stream) {
      return;
    }

    const audioContextClass =
      typeof window !== "undefined" &&
      (window.AudioContext || window.webkitAudioContext);

    if (!audioContextClass) {
      return;
    }

    const key = this.remotePeerKey(roomId, userId);
    const existing = this.#speakingMonitors.get(key);
    if (existing?.stream === stream) {
      return;
    }

    if (existing) {
      this.#teardownAudioMonitor(roomId, userId);
    }

    try {
      const audioContext = new audioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let rafId = null;
      let speaking = false;
      let stopSpeakingTimer = null;

      const sample = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const deviation = dataArray[i] - 128;
          sum += deviation * deviation;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const isSpeaking = rms > 8;

        if (isSpeaking && !speaking) {
          // Start speaking immediately
          if (stopSpeakingTimer) {
            clearTimeout(stopSpeakingTimer);
            stopSpeakingTimer = null;
          }
          speaking = true;
          this.resenhaRooms?.setParticipantSpeaking(roomId, userId, true);
        } else if (!isSpeaking && speaking && !stopSpeakingTimer) {
          // Delay stopping to avoid flickering
          stopSpeakingTimer = setTimeout(() => {
            speaking = false;
            stopSpeakingTimer = null;
            this.resenhaRooms?.setParticipantSpeaking(roomId, userId, false);
          }, 500);
        }

        rafId =
          typeof window !== "undefined"
            ? window.requestAnimationFrame(sample)
            : null;
      };

      sample();

      this.#speakingMonitors.set(key, {
        stream,
        stop() {
          if (rafId && typeof window !== "undefined") {
            window.cancelAnimationFrame(rafId);
          }

          if (stopSpeakingTimer) {
            clearTimeout(stopSpeakingTimer);
            stopSpeakingTimer = null;
          }

          try {
            source.disconnect();
          } catch {
            // ignore
          }

          audioContext.close();
        },
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[resenha] failed to initialize audio monitor", error);
    }
  }

  #teardownAudioMonitor(roomId, userId) {
    if (!roomId || !userId) {
      return;
    }

    const key = this.remotePeerKey(roomId, userId);
    const monitor = this.#speakingMonitors.get(key);
    if (!monitor) {
      return;
    }

    monitor.stop?.();
    this.#speakingMonitors.delete(key);
    this.resenhaRooms?.setParticipantSpeaking(roomId, userId, false);
  }

  #teardownRoomMonitors(roomId) {
    Array.from(this.#speakingMonitors.keys()).forEach((key) => {
      if (key.startsWith(`${roomId}:`)) {
        const [, userId] = key.split(":");
        this.#teardownAudioMonitor(roomId, Number(userId));
      }
    });
  }

  #removeAllRemoteStreams(roomId) {
    const entries = this.#remoteStreams.get(roomId);
    if (!entries?.length) {
      if (this.#remoteStreams.delete(roomId)) {
        this.#bumpRemoteStreamsRevision();
      }
      return;
    }

    entries.forEach((entry) =>
      this.#teardownAudioMonitor(roomId, Number(entry.userId))
    );
    this.#remoteStreams.delete(roomId);
    this.#bumpRemoteStreamsRevision();
  }

  #registerRemoteStream(roomId, remoteUserId, stream) {
    if (!roomId || !remoteUserId || !stream) {
      return;
    }

    const roomStreams = this.#remoteStreams.get(roomId) || [];
    const existingIndex = roomStreams.findIndex(
      (entry) => Number(entry?.userId) === Number(remoteUserId)
    );

    if (existingIndex >= 0 && roomStreams[existingIndex]?.stream === stream) {
      return;
    }

    const next = [...roomStreams];
    if (existingIndex >= 0) {
      next[existingIndex] = { userId: remoteUserId, stream };
    } else {
      next.push({ userId: remoteUserId, stream });
    }

    this.#remoteStreams.set(roomId, next);
    this.#bumpRemoteStreamsRevision();
    this.#ensureAudioMonitor(roomId, remoteUserId, stream);
  }

  #removeRemoteStream(roomId, remoteUserId) {
    if (!roomId || !remoteUserId) {
      return;
    }

    const roomStreams = this.#remoteStreams.get(roomId);
    if (!roomStreams?.length) {
      return;
    }

    const filtered = roomStreams.filter(
      (entry) => Number(entry?.userId) !== Number(remoteUserId)
    );

    if (filtered.length === roomStreams.length) {
      return;
    }

    if (filtered.length) {
      this.#remoteStreams.set(roomId, filtered);
    } else {
      this.#remoteStreams.delete(roomId);
    }

    this.#bumpRemoteStreamsRevision();
    this.#teardownAudioMonitor(roomId, remoteUserId);
  }

  #bumpRemoteStreamsRevision() {
    this.remoteStreamsRevision++;
  }

  #schedulePlaybackResume(element) {
    if (
      !element ||
      typeof document === "undefined" ||
      this.#pendingPlaybackElements.has(element)
    ) {
      return;
    }

    this.#pendingPlaybackElements.add(element);

    const resume = () => {
      try {
        element.play?.();
      } catch {
        // ignore subsequent failures
      }

      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
      this.#pendingPlaybackElements.delete(element);
    };

    document.addEventListener("pointerdown", resume, { once: true });
    document.addEventListener("keydown", resume, { once: true });
  }

  #startHeartbeat(roomId) {
    if (this.#heartbeatTimers.has(roomId)) {
      return;
    }

    // Send heartbeat every 10 seconds (TTL is 30 seconds, so this gives us buffer)
    const timer = setInterval(async () => {
      if (!this.#activeRoomIds.has(roomId)) {
        this.#stopHeartbeat(roomId);
        return;
      }

      try {
        await ajax(`/resenha/rooms/${roomId}/join`, {
          type: "POST",
        });
        // eslint-disable-next-line no-console
        console.log(`[resenha] heartbeat sent for room ${roomId}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[resenha] heartbeat failed for room ${roomId}`, error);
      }
    }, 10000);

    this.#heartbeatTimers.set(roomId, timer);
  }

  #stopHeartbeat(roomId) {
    const timer = this.#heartbeatTimers.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.#heartbeatTimers.delete(roomId);
      // eslint-disable-next-line no-console
      console.log(`[resenha] heartbeat stopped for room ${roomId}`);
    }
  }

  #stopLocalStream() {
    if (!this.localStream) {
      return;
    }

    this.localStream.getTracks().forEach((track) => track.stop());
    this.localStream = null;
  }

  #schedulePeerRestart(roomId, remoteUserId, options = {}) {
    if (!this.#activeRoomIds.has(roomId)) {
      return;
    }

    const key = this.remotePeerKey(roomId, remoteUserId);

    if (this.#peerReconnectTimers.has(key)) {
      return;
    }

    const attempts = this.#restartAttempts.get(key) || 0;

    if (attempts >= ResenhaWebrtcService.#maxRestartAttempts) {
      // eslint-disable-next-line no-console
      console.warn(
        `[resenha] max restart attempts (${ResenhaWebrtcService.#maxRestartAttempts}) reached for user ${remoteUserId}`
      );
      return;
    }

    // Exponential backoff: 200ms → 400ms → 800ms → 1600ms → 3200ms (capped at 5000ms)
    const baseDelay = options.immediate ? 200 : 1500;
    const delay = Math.min(baseDelay * Math.pow(2, attempts), 5000);

    // eslint-disable-next-line no-console
    console.log(
      `[resenha] scheduling peer restart for user ${remoteUserId} (attempt ${attempts + 1}/${ResenhaWebrtcService.#maxRestartAttempts}, delay ${delay}ms)`
    );

    const timer = setTimeout(() => {
      this.#peerReconnectTimers.delete(key);
      this.#restartAttempts.set(key, attempts + 1);
      this.#restartPeerConnection(roomId, remoteUserId).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to restart peer connection", error);
      });
    }, delay);

    this.#peerReconnectTimers.set(key, timer);
  }

  #clearPeerRestart(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#peerReconnectTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.#peerReconnectTimers.delete(key);
    }

    // Reset restart attempts on successful connection
    this.#restartAttempts.delete(key);
  }

  #clearSignalQueuesForRoom(roomId) {
    const prefix = `${roomId}:`;

    Array.from(this.#signalQueues.keys()).forEach((key) => {
      if (!key.startsWith(prefix)) {
        return;
      }

      const timer = this.#signalFlushTimers.get(key);

      if (timer) {
        clearTimeout(timer);
        this.#signalFlushTimers.delete(key);
      }

      this.#signalQueues.delete(key);
    });
  }

  #clearSignalQueue(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#signalFlushTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.#signalFlushTimers.delete(key);
    }

    this.#signalQueues.delete(key);
  }

  #clearHttpSignalQueue(roomId) {
    const timer = this.#httpSignalFlushTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.#httpSignalFlushTimers.delete(roomId);
    }

    const entry = this.#httpSignalQueues.get(roomId);
    if (!entry) {
      return;
    }

    entry.recipients?.clear?.();
    entry.pending?.forEach((pending) => pending.resolve?.());
    entry.pending = [];
    this.#httpSignalQueues.delete(roomId);
  }

  #enqueueHttpSignals(roomId, recipientId, events) {
    if (!roomId || !recipientId || !events?.length) {
      return Promise.resolve();
    }

    let entry = this.#httpSignalQueues.get(roomId);

    if (!entry) {
      entry = {
        recipients: new Map(),
        pending: [],
      };

      this.#httpSignalQueues.set(roomId, entry);
    }

    const roomQueue = entry.recipients;
    const existingEvents = roomQueue.get(recipientId);

    if (existingEvents) {
      existingEvents.push(...events);
    } else {
      roomQueue.set(recipientId, [...events]);
    }

    const promise = new Promise((resolve, reject) => {
      entry.pending.push({ resolve, reject });
    });

    this.#scheduleHttpFlush(roomId);

    return promise;
  }

  #scheduleHttpFlush(roomId) {
    if (this.#httpSignalFlushTimers.has(roomId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#httpSignalFlushTimers.delete(roomId);
      this.#flushHttpSignals(roomId).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to flush HTTP signal queue", error);
      });
    }, ResenhaWebrtcService.#httpBatchDelayMs);

    this.#httpSignalFlushTimers.set(roomId, timer);
  }

  async #flushHttpSignals(roomId) {
    const entry = this.#httpSignalQueues.get(roomId);
    if (!entry) {
      return;
    }

    if (!this.#activeRoomIds.has(roomId)) {
      entry.recipients?.clear?.();
      entry.pending.splice(0).forEach((pending) => pending.resolve?.());
      this.#httpSignalQueues.delete(roomId);
      return;
    }

    const roomQueue = entry.recipients;
    if (!roomQueue?.size) {
      entry.pending.splice(0).forEach((pending) => pending.resolve?.());
      return;
    }

    const messages = [];

    roomQueue.forEach((events, recipientId) => {
      if (!events?.length) {
        return;
      }

      messages.push({
        recipient_id: recipientId,
        events,
      });
    });

    roomQueue.clear();

    if (!messages.length) {
      entry.pending.splice(0).forEach((pending) => pending.resolve?.());
      return;
    }

    const payload = this.#buildSignalPayload(messages);

    // eslint-disable-next-line no-console
    console.log(
      `[resenha] 🚀 sending ${messages.length} batched signal recipient(s) in room ${roomId}`
    );

    try {
      await ajax(`/resenha/rooms/${roomId}/signal`, {
        type: "POST",
        data: { payload },
      });

      entry.pending.splice(0).forEach((pending) => pending.resolve?.());
    } catch (error) {
      entry.pending.splice(0).forEach((pending) => pending.reject?.(error));
      throw error;
    }
  }

  #buildSignalPayload(messages) {
    if (messages.length === 1) {
      const [message] = messages;

      if (message.events.length === 1) {
        return {
          ...message.events[0],
          recipient_id: message.recipient_id,
        };
      }

      return {
        recipient_id: message.recipient_id,
        events: message.events,
      };
    }

    return {
      messages: messages.map((message) => ({
        recipient_id: message.recipient_id,
        events: message.events,
      })),
    };
  }

  async #restartPeerConnection(roomId, remoteUserId) {
    if (!this.#activeRoomIds.has(roomId)) {
      return;
    }

    const peers = this.#peerConnections.get(roomId);
    const existing = peers?.get(remoteUserId);
    if (existing) {
      try {
        existing.ontrack = null;
        existing.onicecandidate = null;
        existing.onconnectionstatechange = null;
        existing.close();
      } catch {
        // ignore close errors
      }
      peers.delete(remoteUserId);
    }

    this.#removeRemoteStream(roomId, remoteUserId);
    this.#clearOfferRetry(roomId, remoteUserId);
    this.#clearConnectionTimeout(roomId, remoteUserId);
    this.#clearPendingCandidates(roomId, remoteUserId);

    await this.#createPeerConnection(roomId, remoteUserId);

    if (this.currentUser?.id <= remoteUserId) {
      await this.#initiateOffer(roomId, remoteUserId);
    } else {
      this.#scheduleOfferRetry(roomId, remoteUserId, 0);
    }
  }
}
