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

  willDestroy() {
    super.willDestroy(...arguments);
    this.#roomSubscriptions.forEach((callback, channel) => {
      this.messageBus.unsubscribe(channel, callback);
    });
    this.#speakingMonitors.forEach((monitor) => monitor?.stop?.());
    this.#speakingMonitors.clear();
    this.#heartbeatTimers.forEach((timer) => clearInterval(timer));
    this.#heartbeatTimers.clear();
    this.#peerReconnectTimers.forEach((timer) => clearTimeout(timer));
    this.#peerReconnectTimers.clear();
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
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      // eslint-disable-next-line no-console
      console.log("[resenha] local stream obtained");
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
    });
    this.#peerConnections.delete(roomId);
    this.#removeAllRemoteStreams(roomId);
    this.#teardownRoomMonitors(roomId);
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
      this.#registerRemoteStream(roomId, remoteUserId, event.streams[0]);
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
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.#clearOfferRetry(roomId, remoteUserId);
        this.#clearPeerRestart(roomId, remoteUserId);
        return;
      }

      if (pc.connectionState === "failed") {
        this.#clearOfferRetry(roomId, remoteUserId);
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

    return pc;
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
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.#sendSignal(roomId, remoteUserId, answer);
    } else if (data.type === "answer") {
      this.#clearOfferRetry(roomId, remoteUserId);
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === "candidate") {
      this.#clearOfferRetry(roomId, remoteUserId);
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  async #sendSignal(roomId, recipientId, payload) {
    // eslint-disable-next-line no-console
    console.log(
      `[resenha] 🚀 sending ${payload.type} to user ${recipientId} in room ${roomId}`
    );
    await ajax(`/resenha/rooms/${roomId}/signal`, {
      type: "POST",
      data: {
        payload: {
          ...payload,
          recipient_id: recipientId,
        },
      },
    });
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
      await this.#sendSignal(roomId, remoteUserId, offer);
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

    const timer = setTimeout(async () => {
      this.#offerRetryTimers.delete(key);
      await this.#initiateOffer(roomId, remoteUserId);
    }, delay);

    this.#offerRetryTimers.set(key, timer);
  }

  #clearOfferRetry(roomId, remoteUserId) {
    const key = this.remotePeerKey(roomId, remoteUserId);
    const timer = this.#offerRetryTimers.get(key);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.#offerRetryTimers.delete(key);
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

    if (
      existingIndex >= 0 &&
      roomStreams[existingIndex]?.stream === stream
    ) {
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

    // Send heartbeat every 10 seconds (TTL is 15 seconds, so this gives us buffer)
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

  #schedulePeerRestart(roomId, remoteUserId, options = {}) {
    if (!this.#activeRoomIds.has(roomId)) {
      return;
    }

    const delay = options.immediate ? 200 : 1500;
    const key = this.remotePeerKey(roomId, remoteUserId);

    if (this.#peerReconnectTimers.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#peerReconnectTimers.delete(key);
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
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.#peerReconnectTimers.delete(key);
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

    await this.#createPeerConnection(roomId, remoteUserId);

    if (this.currentUser?.id <= remoteUserId) {
      await this.#initiateOffer(roomId, remoteUserId);
    } else {
      this.#scheduleOfferRetry(roomId, remoteUserId, 0);
    }
  }
}
