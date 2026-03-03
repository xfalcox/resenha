import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";

export default class ResenhaWebrtcService extends Service {
  @service currentUser;
  @service siteSettings;
  @service("resenha-rooms") resenhaRooms;

  @tracked localStream;
  @tracked audioEnabled = true;
  @tracked deafened = false;
  @tracked noiseSuppressionEnabled = false;
  @tracked remoteStreamsRevision = 0;
  @tracked connectionRevision = 0;

  #connectingRoomIds = new Set();
  #peerConnections = new Map();
  #offerRetryTimers = new Map();
  #remoteStreams = new Map();
  #peerReconnectTimers = new Map();
  #roomHandlerCallbacks = new Map();
  #activeRoomIds = new Set();
  #speakingMonitors = new Map();
  #pendingPlaybackElements = new WeakSet();
  #heartbeatTimers = new Map();
  #heartbeatInFlight = new Set();
  #signalQueues = new Map();
  #signalFlushTimers = new Map();
  #httpSignalQueues = new Map();
  #httpSignalFlushTimers = new Map();
  #pendingCandidates = new Map();
  #restartAttempts = new Map();
  #offerRetryAttempts = new Map();
  #connectionTimeouts = new Map();
  #participantVolumes = new Map();
  #participantMuted = new Map();
  #audioElements = new Map();
  #streamToParticipant = new WeakMap();

  #rawLocalStream = null;
  #noiseSuppressionContext = null;
  #noiseSuppressionNode = null;
  #noiseSuppressionSource = null;

  static #candidateBatchDelayMs = 75;
  static #candidateBatchSize = 5;
  static #httpBatchDelayMs = 25;
  static #maxRestartAttempts = 5;
  static #maxOfferRetries = 3;
  static #connectionTimeoutMs = 30000;

  willDestroy() {
    super.willDestroy(...arguments);
    this.#stopLocalStream();
    this.#roomHandlerCallbacks.forEach((callback, roomId) => {
      this.resenhaRooms?.unregisterRoomHandler(roomId, callback);
    });
    this.#roomHandlerCallbacks.clear();
    this.#speakingMonitors.forEach((monitor) => monitor?.stop?.());
    this.#speakingMonitors.clear();
    this.#heartbeatTimers.forEach((timer) => clearInterval(timer));
    this.#heartbeatTimers.clear();
    this.#heartbeatInFlight.clear();
    this.#connectingRoomIds.clear();
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
    this.connectionRevision;
    if (this.#connectingRoomIds.has(roomId)) {
      return "connecting";
    }
    if (this.#activeRoomIds.has(roomId)) {
      return "connected";
    }
    return "idle";
  }

  async join(room) {
    if (!room?.id) {
      return;
    }

    this.audioEnabled = true;
    this.#connectingRoomIds.add(room.id);
    this.#bumpConnectionRevision();

    // Leave any other active rooms first (rooms are mutually exclusive)
    for (const activeRoomId of this.#activeRoomIds) {
      if (activeRoomId !== room.id) {
        this.leave({ id: activeRoomId }, { keepLocalStream: true });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[resenha] joining room ${room.id}`);

    if (!this.localStream) {
      try {
        const rawStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        // eslint-disable-next-line no-console
        console.log("[resenha] local stream obtained");

        this.#rawLocalStream = rawStream;

        if (
          this.siteSettings.resenha_noise_suppression &&
          this.#isNoiseSuppressionPreferred()
        ) {
          try {
            await this.#setupNoiseSuppression(rawStream);
            this.noiseSuppressionEnabled = true;
            // eslint-disable-next-line no-console
            console.log("[resenha] noise suppression enabled");
          } catch (nsError) {
            // eslint-disable-next-line no-console
            console.warn(
              "[resenha] noise suppression setup failed, using raw stream",
              nsError
            );
            this.localStream = rawStream;
          }
        } else {
          this.localStream = rawStream;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to obtain local stream", error);
        this.#connectingRoomIds.delete(room.id);
        this.#bumpConnectionRevision();
        return;
      }
    }

    // Register handler BEFORE joining to avoid missing the participant broadcast
    this.#registerRoomHandler(room.id);
    this.#activeRoomIds.add(room.id);

    let response;

    try {
      response = await ajax(`/resenha/rooms/${room.id}/join`, {
        type: "POST",
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[resenha] failed to join room", error);
      this.#handleJoinFailure(room.id);
      return;
    }

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

    this.#connectingRoomIds.delete(room.id);
    this.#bumpConnectionRevision();
    this.#playConnectedSound();
  }

  leave(room, options = {}) {
    if (!room?.id) {
      return;
    }

    const keepLocalStream = options.keepLocalStream === true;
    const wasConnected = this.#activeRoomIds.has(room.id);

    ajax(`/resenha/rooms/${room.id}/leave`, { type: "DELETE" });
    this.#connectingRoomIds.delete(room.id);
    this.#activeRoomIds.delete(room.id);
    this.#bumpConnectionRevision();

    if (wasConnected && !keepLocalStream) {
      this.#playDisconnectedSound();
    }
    this.#removeLocalParticipant(room.id);
    this.#teardownAudioMonitor(room.id, this.currentUser?.id);
    this.#stopHeartbeat(room.id);
    this.#teardownRoom(room.id);

    if (!keepLocalStream && this.#activeRoomIds.size === 0) {
      this.#stopLocalStream();
    }
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

    const isLocal = stream === this.localStream;
    if (isLocal) {
      element.muted = true;
      element.volume = 0;
    } else {
      const participant = this.#streamToParticipant.get(stream);
      if (participant) {
        const { roomId, userId } = participant;
        this.#trackAudioElement(roomId, userId, element);
        this.#applyAudioSettings(roomId, userId);
      }
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

  setParticipantVolume(roomId, userId, volume) {
    const key = this.remotePeerKey(roomId, userId);
    const clampedVolume = Math.max(0, Math.min(1, volume));
    this.#participantVolumes.set(key, clampedVolume);
    this.#applyAudioSettings(roomId, userId);
  }

  @action
  toggleDeafen() {
    this.deafened = !this.deafened;
    this.#audioElements.forEach((element, key) => {
      const [roomId, userId] = key.split(":");
      this.#applyAudioSettings(roomId, Number(userId));
    });
  }

  getParticipantVolume(roomId, userId) {
    const key = this.remotePeerKey(roomId, userId);
    return this.#participantVolumes.get(key) ?? 1;
  }

  toggleParticipantMute(roomId, userId) {
    const key = this.remotePeerKey(roomId, userId);
    const currentlyMuted = this.#participantMuted.get(key) ?? false;
    const newMutedState = !currentlyMuted;
    this.#participantMuted.set(key, newMutedState);
    this.#applyAudioSettings(roomId, userId);
    this.resenhaRooms?.setParticipantMuted(roomId, userId, newMutedState);
    return newMutedState;
  }

  isParticipantMuted(roomId, userId) {
    const key = this.remotePeerKey(roomId, userId);
    return this.#participantMuted.get(key) ?? false;
  }

  #applyAudioSettings(roomId, userId) {
    const key = this.remotePeerKey(roomId, userId);
    const element = this.#audioElements.get(key);
    if (!element) {
      return;
    }

    const muted = this.deafened || (this.#participantMuted.get(key) ?? false);
    const volume = this.#participantVolumes.get(key) ?? 1;

    element.muted = muted;
    if (!muted) {
      element.volume = volume;
    }
  }

  #trackAudioElement(roomId, userId, element) {
    const key = this.remotePeerKey(roomId, userId);
    this.#audioElements.set(key, element);
  }

  #untrackAudioElement(roomId, userId) {
    const key = this.remotePeerKey(roomId, userId);
    this.#audioElements.delete(key);
  }

  #registerRoomHandler(roomId) {
    if (this.#roomHandlerCallbacks.has(roomId)) {
      return;
    }

    const callback = (payload) => this.#handleRoomMessage(roomId, payload);
    this.resenhaRooms.registerRoomHandler(roomId, callback);
    this.#roomHandlerCallbacks.set(roomId, callback);
  }

  #teardownRoom(roomId) {
    const callback = this.#roomHandlerCallbacks.get(roomId);
    if (callback) {
      this.resenhaRooms?.unregisterRoomHandler(roomId, callback);
      this.#roomHandlerCallbacks.delete(roomId);
    }

    const peers = this.#peerConnections.get(roomId);
    if (peers) {
      Array.from(peers.keys()).forEach((remoteUserId) => {
        this.#destroyPeerConnection(roomId, remoteUserId);
      });
      this.#peerConnections.delete(roomId);
    }
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

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        this.#flushQueuedSignals(roomId, remoteUserId).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn("[resenha] failed to flush signal queue", error);
        });
      }
    };

    pc.onicecandidateerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[resenha] ICE candidate error for user ${remoteUserId}`,
        event
      );
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
        this.#destroyPeerConnection(roomId, remoteUserId, {
          closeConnection: false,
        });
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
    } else if (payload.type === "kicked") {
      this.#handleKicked(roomId);
    }
  }

  async #handleSignal(roomId, payload) {
    const remoteUserId = Number(payload.sender_id);
    const data = payload.data;

    if (!Number.isFinite(remoteUserId) || remoteUserId <= 0) {
      return;
    }

    if (remoteUserId === this.currentUser?.id) {
      return;
    }
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

    if (!this.#activeRoomIds.has(roomId)) {
      return Promise.resolve();
    }

    const peers = this.#peerConnections.get(roomId);
    if (!peers || !peers.has(recipientId)) {
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

    const existingPeerIds = new Set(peers?.keys() || []);

    let hasPeerLeft = false;

    peers?.forEach((pc, remoteUserId) => {
      if (!participantIds.has(remoteUserId)) {
        hasPeerLeft = true;
        this.#destroyPeerConnection(roomId, remoteUserId);
      }
    });

    let hasNewPeer = false;

    for (const participantId of participantIds) {
      if (participantId === this.currentUser?.id) {
        continue;
      }

      if (!peers?.has(participantId)) {
        if (existingPeerIds.size > 0 || !this.#connectingRoomIds.has(roomId)) {
          hasNewPeer = true;
        }
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

    if (this.#activeRoomIds.has(roomId)) {
      if (hasNewPeer) {
        this.#playUserJoinedSound();
      } else if (hasPeerLeft) {
        this.#playUserLeftSound();
      }
    }
  }

  #handleKicked(roomId) {
    // eslint-disable-next-line no-console
    console.log(`[resenha] kicked from room ${roomId}`);
    this.leave({ id: roomId });
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

    this.resenhaRooms?.addParticipant(roomId, {
      ...participant,
      is_muted: !this.audioEnabled,
    });
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
    this.#streamToParticipant.set(stream, { roomId, userId: remoteUserId });
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
    this.#untrackAudioElement(roomId, remoteUserId);
  }

  #bumpRemoteStreamsRevision() {
    this.remoteStreamsRevision++;
  }

  #bumpConnectionRevision() {
    this.connectionRevision++;
  }

  #playConnectedSound() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.frequency.value = 523.25; // C5
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.connect(gain1).connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.frequency.value = 659.25; // E5
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.15, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.25);

      osc2.onended = () => ctx.close();
    } catch {
      // audio not available
    }
  }

  #playDisconnectedSound() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.frequency.value = 659.25; // E5
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.connect(gain1).connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.frequency.value = 523.25; // C5
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.15, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.25);

      osc2.onended = () => ctx.close();
    } catch {
      // audio not available
    }
  }

  #playUserJoinedSound() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 659.25; // E5
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);

      osc.onended = () => ctx.close();
    } catch {
      // audio not available
    }
  }

  #playUserLeftSound() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 523.25; // C5
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);

      osc.onended = () => ctx.close();
    } catch {
      // audio not available
    }
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

      if (this.#heartbeatInFlight.has(roomId)) {
        return;
      }

      this.#heartbeatInFlight.add(roomId);

      try {
        await ajax(`/resenha/rooms/${roomId}/heartbeat`, {
          type: "POST",
        });
        // eslint-disable-next-line no-console
        console.log(`[resenha] heartbeat sent for room ${roomId}`);
      } catch (error) {
        const status = error?.jqXHR?.status || error?.status;
        // eslint-disable-next-line no-console
        console.warn(`[resenha] heartbeat failed for room ${roomId}`, error);

        if (status === 403 || status === 404 || status === 410) {
          this.leave({ id: roomId });
        }
      } finally {
        this.#heartbeatInFlight.delete(roomId);
      }
    }, 10000);

    this.#heartbeatTimers.set(roomId, timer);
  }

  #stopHeartbeat(roomId) {
    const timer = this.#heartbeatTimers.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.#heartbeatTimers.delete(roomId);
      this.#heartbeatInFlight.delete(roomId);
      // eslint-disable-next-line no-console
      console.log(`[resenha] heartbeat stopped for room ${roomId}`);
    }
  }

  #stopLocalStream() {
    this.#teardownNoiseSuppression();

    if (this.#rawLocalStream) {
      this.#rawLocalStream.getTracks().forEach((track) => track.stop());
      this.#rawLocalStream = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
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
    this.#clearPeerRestartTimer(roomId, remoteUserId);

    // Reset restart attempts on successful connection
    this.#restartAttempts.delete(this.remotePeerKey(roomId, remoteUserId));
  }

  #clearPeerRestartTimer(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#peerReconnectTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.#peerReconnectTimers.delete(key);
    }
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

    this.#destroyPeerConnection(roomId, remoteUserId, {
      resetRestartAttempts: false,
    });

    await this.#createPeerConnection(roomId, remoteUserId);
    await this.#initiateOffer(roomId, remoteUserId);
  }

  #handleJoinFailure(roomId) {
    this.#connectingRoomIds.delete(roomId);
    this.#bumpConnectionRevision();
    this.#activeRoomIds.delete(roomId);
    this.#stopHeartbeat(roomId);
    this.#removeLocalParticipant(roomId);
    this.#teardownRoom(roomId);

    if (this.#activeRoomIds.size === 0) {
      this.#stopLocalStream();
    }
  }

  #destroyPeerConnection(
    roomId,
    remoteUserId,
    { resetRestartAttempts = true, closeConnection = true } = {}
  ) {
    const peers = this.#peerConnections.get(roomId);
    const pc = peers?.get(remoteUserId);

    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onicecandidateerror = null;

      if (closeConnection) {
        try {
          pc.close();
        } catch {
          // ignore close errors
        }
      }

      peers.delete(remoteUserId);
    }

    this.#clearOfferRetry(roomId, remoteUserId);
    if (resetRestartAttempts) {
      this.#clearPeerRestart(roomId, remoteUserId);
    } else {
      this.#clearPeerRestartTimer(roomId, remoteUserId);
    }
    this.#clearConnectionTimeout(roomId, remoteUserId);
    this.#clearPendingCandidates(roomId, remoteUserId);
    this.#clearSignalQueue(roomId, remoteUserId);
    this.#removeRemoteStream(roomId, remoteUserId);
  }

  async #setupNoiseSuppression(rawStream) {
    const audioContext = new AudioContext();

    await audioContext.audioWorklet.addModule(
      "/plugins/resenha/javascripts/dtln-worklet.js"
    );

    const source = audioContext.createMediaStreamSource(rawStream);
    const workletNode = new AudioWorkletNode(
      audioContext,
      "noise-suppression-processor"
    );
    const destination = audioContext.createMediaStreamDestination();

    source.connect(workletNode);
    workletNode.connect(destination);

    this.#noiseSuppressionContext = audioContext;
    this.#noiseSuppressionSource = source;
    this.#noiseSuppressionNode = workletNode;
    this.localStream = destination.stream;
  }

  #teardownNoiseSuppression() {
    if (this.#noiseSuppressionSource) {
      try {
        this.#noiseSuppressionSource.disconnect();
      } catch {
        // ignore
      }
      this.#noiseSuppressionSource = null;
    }

    if (this.#noiseSuppressionNode) {
      try {
        this.#noiseSuppressionNode.disconnect();
      } catch {
        // ignore
      }
      this.#noiseSuppressionNode = null;
    }

    if (this.#noiseSuppressionContext) {
      try {
        this.#noiseSuppressionContext.close();
      } catch {
        // ignore
      }
      this.#noiseSuppressionContext = null;
    }

    this.noiseSuppressionEnabled = false;
  }

  async toggleMute() {
    const newMutedState = this.audioEnabled; // If enabled, we're about to mute
    this.audioEnabled = !newMutedState;

    this.localStream?.getAudioTracks()?.forEach((track) => {
      track.enabled = this.audioEnabled;
    });

    for (const roomId of this.#activeRoomIds) {
      this.resenhaRooms?.setParticipantMuted(
        roomId,
        this.currentUser?.id,
        newMutedState
      );

      try {
        await ajax(`/resenha/rooms/${roomId}/toggle_mute`, {
          type: "POST",
          data: { muted: newMutedState },
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to toggle mute on server", error);
      }
    }
  }

  async toggleNoiseSuppression() {
    if (!this.#rawLocalStream) {
      return;
    }

    if (this.noiseSuppressionEnabled) {
      this.#teardownNoiseSuppression();
      this.localStream = this.#rawLocalStream;
      this.#setNoiseSuppressionPreference(false);
      // eslint-disable-next-line no-console
      console.log("[resenha] noise suppression disabled");
    } else {
      try {
        await this.#setupNoiseSuppression(this.#rawLocalStream);
        this.noiseSuppressionEnabled = true;
        this.#setNoiseSuppressionPreference(true);
        // eslint-disable-next-line no-console
        console.log("[resenha] noise suppression enabled");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[resenha] failed to enable noise suppression", error);
        this.localStream = this.#rawLocalStream;
        return;
      }
    }

    await this.#replaceTrackOnAllPeers();
  }

  #isNoiseSuppressionPreferred() {
    try {
      return localStorage.getItem("resenha:noise-suppression") === "1";
    } catch {
      return false;
    }
  }

  #setNoiseSuppressionPreference(enabled) {
    try {
      if (enabled) {
        localStorage.setItem("resenha:noise-suppression", "1");
      } else {
        localStorage.removeItem("resenha:noise-suppression");
      }
    } catch {
      // ignore storage errors
    }
  }

  async #replaceTrackOnAllPeers() {
    const newTrack = this.localStream?.getAudioTracks()?.[0];
    if (!newTrack) {
      return;
    }

    for (const [, peers] of this.#peerConnections) {
      for (const [, pc] of peers) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === "audio") {
            try {
              await sender.replaceTrack(newTrack);
            } catch (error) {
              // eslint-disable-next-line no-console
              console.warn("[resenha] failed to replace track on peer", error);
            }
          }
        }
      }
    }
  }
}
