import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
];

export default class ResenhaWebrtcService extends Service {
  @service currentUser;
  @service messageBus;
  @service("resenha-rooms") resenhaRooms;

  @tracked localStream;
  @tracked audioEnabled = true;
  @tracked remoteStreamsRevision = 0;

  #peerConnections = new Map();
  #remoteStreams = new Map();
  #roomSubscriptions = new Map();
  #activeRoomIds = new Set();
  #speakingMonitors = new Map();

  willDestroy() {
    super.willDestroy(...arguments);
    this.#roomSubscriptions.forEach((callback, channel) => {
      this.messageBus.unsubscribe(channel, callback);
    });
    this.#speakingMonitors.forEach((monitor) => monitor?.stop?.());
    this.#speakingMonitors.clear();
  }

  get remoteStreams() {
    this.remoteStreamsRevision;
    return Array.from(this.#remoteStreams.values())
      .filter(Array.isArray)
      .flat();
  }

  remoteStreamsFor(roomId) {
    this.remoteStreamsRevision;
    return this.#remoteStreams.get(roomId) || [];
  }

  connectionStateFor(roomId) {
    return this.#activeRoomIds.has(roomId) ? "connected" : "idle";
  }

  async join(room) {
    if (!room?.id) {
      return;
    }

    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    }

    await ajax(`/resenha/rooms/${room.id}/join`, { type: "POST" });
    this.#activeRoomIds.add(room.id);
    this.#addLocalParticipant(room.id);
    this.#ensureAudioMonitor(room.id, this.currentUser?.id, this.localStream);
    this.#subscribeToRoom(room.id);
  }

  leave(room) {
    if (!room?.id) {
      return;
    }

    ajax(`/resenha/rooms/${room.id}/leave`, { type: "DELETE" });
    this.#activeRoomIds.delete(room.id);
    this.#removeLocalParticipant(room.id);
    this.#teardownAudioMonitor(room.id, this.currentUser?.id);
    this.#teardownRoom(room.id);
  }

  attachStream(stream, element) {
    if (!element || !stream) {
      return;
    }

    element.srcObject = stream;
  }

  remotePeerKey(roomId, userId) {
    return `${roomId}:${userId}`;
  }

  #subscribeToRoom(roomId) {
    if (this.#roomSubscriptions.has(roomId)) {
      return;
    }

    const channel = `/resenha/rooms/${roomId}`;
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
    peers.forEach((pc) => pc.close());
    this.#peerConnections.delete(roomId);
    this.#remoteStreams.delete(roomId);
    this.#bumpRemoteStreamsRevision();
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    roomPeers.set(remoteUserId, pc);

    this.localStream?.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    pc.ontrack = (event) => {
      let roomStreams = this.#remoteStreams.get(roomId);
      if (!roomStreams) {
        roomStreams = [];
        this.#remoteStreams.set(roomId, roomStreams);
      }

      const existing = roomStreams.find(
        (stream) => stream.id === event.streams[0].id
      );
      if (!existing) {
        roomStreams.push(event.streams[0]);
        this.#remoteStreams.set(roomId, [...roomStreams]);
        this.#bumpRemoteStreamsRevision();
        this.#ensureAudioMonitor(roomId, remoteUserId, event.streams[0]);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal(roomId, remoteUserId, {
          type: "candidate",
          candidate: event.candidate,
        });
      }
    };

    return pc;
  }

  async #handleRoomMessage(roomId, payload) {
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
    const pc = await this.#createPeerConnection(roomId, remoteUserId);

    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.#sendSignal(roomId, remoteUserId, answer);
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === "candidate") {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  async #sendSignal(roomId, recipientId, payload) {
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

    let peers = this.#peerConnections.get(roomId);
    peers?.forEach((pc, remoteUserId) => {
      if (!participantIds.has(remoteUserId)) {
        pc.close();
        peers.delete(remoteUserId);
        this.#teardownAudioMonitor(roomId, remoteUserId);
      }
    });

    for (const participantId of participantIds) {
      if (participantId === this.currentUser?.id) {
        continue;
      }

      if (peers?.has(participantId)) {
        continue;
      }

      if (this.currentUser?.id > participantId) {
        continue;
      }

      const pc = await this.#createPeerConnection(roomId, participantId);
      peers = this.#peerConnections.get(roomId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.#sendSignal(roomId, participantId, offer);
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

      const sample = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const deviation = dataArray[i] - 128;
          sum += deviation * deviation;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const isSpeaking = rms > 8;

        if (isSpeaking !== speaking) {
          speaking = isSpeaking;
          this.resenhaRooms?.setParticipantSpeaking(roomId, userId, speaking);
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

  #bumpRemoteStreamsRevision() {
    this.remoteStreamsRevision++;
  }
}
