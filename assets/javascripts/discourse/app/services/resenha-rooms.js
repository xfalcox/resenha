import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { bind } from "discourse/lib/decorators";

export default class ResenhaRoomsService extends Service {
  @service currentUser;
  @service messageBus;
  @service siteSettings;

  @tracked rooms = [];

  #roomsById = new Map();
  #roomsBySlug = new Map();
  #roomSubscriptions = new Map();

  constructor() {
    super(...arguments);
    if (!this.currentUser || !this.siteSettings.resenha_enabled) {
      return;
    }

    this.ready = this.#bootstrap();
    this.messageBus.subscribe(
      "/resenha/rooms/index",
      this.handleDirectoryEvent
    );
  }

  willDestroy() {
    super.willDestroy(...arguments);
    this.messageBus.unsubscribe(
      "/resenha/rooms/index",
      this.handleDirectoryEvent
    );
    this.#roomSubscriptions.forEach((callback, roomId) => {
      this.messageBus.unsubscribe(`/resenha/rooms/${roomId}`, callback);
    });
    this.#roomSubscriptions.clear();
  }

  roomById(id) {
    return this.#roomsById.get(id);
  }

  roomBySlug(slug) {
    return this.#roomsBySlug.get(slug);
  }

  async #bootstrap() {
    const payload = await ajax("/resenha/rooms.json");
    this.#hydrateRooms(payload.rooms);
    return this.rooms;
  }

  #hydrateRooms(roomPayloads) {
    this.rooms = roomPayloads;
    this.#roomsById.clear();
    this.#roomsBySlug.clear();

    roomPayloads.forEach((room) => {
      this.#roomsById.set(room.id, room);
      this.#roomsBySlug.set(room.slug, room);
      this.#ensureRoomSubscription(room.id);
    });
  }

  @bind
  handleDirectoryEvent(message) {
    if (message.type === "destroyed") {
      this.#roomsById.delete(message.room.id);
      this.#roomsBySlug.delete(message.room.slug);
      this.#teardownRoomSubscription(message.room.id);
    } else {
      this.#roomsById.set(message.room.id, message.room);
      this.#roomsBySlug.set(message.room.slug, message.room);
      this.#ensureRoomSubscription(message.room.id);
    }

    this.rooms = Array.from(this.#roomsById.values());
  }

  handleRoomBroadcast(payload) {
    const room = this.#roomsById.get(payload.room_id);
    if (!room) {
      return;
    }

    if (payload.type === "participants") {
      this.#setRoomParticipants(room.id, payload.participants || []);
    }
  }

  #ensureRoomSubscription(roomId) {
    if (this.#roomSubscriptions.has(roomId)) {
      return;
    }

    const channel = `/resenha/rooms/${roomId}`;
    const callback = (message) => this.handleRoomBroadcast(message);
    this.messageBus.subscribe(channel, callback);
    this.#roomSubscriptions.set(roomId, callback);
  }

  #teardownRoomSubscription(roomId) {
    const callback = this.#roomSubscriptions.get(roomId);
    if (callback) {
      const channel = `/resenha/rooms/${roomId}`;
      this.messageBus.unsubscribe(channel, callback);
      this.#roomSubscriptions.delete(roomId);
    }
  }

  addParticipant(roomId, participant) {
    if (!participant?.id) {
      return;
    }

    const room = this.#roomsById.get(roomId);
    if (!room) {
      return;
    }

    const existing = room.active_participants || [];
    if (existing.some((p) => p?.id === participant.id)) {
      return;
    }

    room.active_participants = [
      ...existing,
      { ...participant, is_speaking: participant.is_speaking || false },
    ];
    this.rooms = [...this.rooms];
  }

  removeParticipant(roomId, userId) {
    const targetId = Number(userId);
    if (!targetId) {
      return;
    }

    const room = this.#roomsById.get(roomId);
    if (!room || !Array.isArray(room.active_participants)) {
      return;
    }

    const filtered = room.active_participants.filter(
      (participant) => Number(participant?.id) !== targetId
    );

    if (filtered.length === room.active_participants.length) {
      return;
    }

    room.active_participants = filtered;
    this.rooms = [...this.rooms];
  }

  setParticipantSpeaking(roomId, userId, speaking) {
    const targetId = Number(userId);
    if (!targetId) {
      return;
    }

    const room = this.#roomsById.get(roomId);
    if (!room || !Array.isArray(room.active_participants)) {
      return;
    }

    let changed = false;
    room.active_participants = room.active_participants.map((participant) => {
      const participantId = Number(participant?.id);
      if (!participantId || participantId !== targetId) {
        return participant;
      }

      if (!!participant.is_speaking === speaking) {
        return participant;
      }

      changed = true;
      return {
        ...participant,
        is_speaking: speaking,
      };
    });

    if (changed) {
      this.rooms = [...this.rooms];
    }
  }

  setParticipantMuted(roomId, userId, muted) {
    const targetId = Number(userId);
    if (!targetId) {
      return;
    }

    const room = this.#roomsById.get(roomId);
    if (!room || !Array.isArray(room.active_participants)) {
      return;
    }

    let changed = false;
    room.active_participants = room.active_participants.map((participant) => {
      const participantId = Number(participant?.id);
      if (!participantId || participantId !== targetId) {
        return participant;
      }

      if (!!participant.is_muted === muted) {
        return participant;
      }

      changed = true;
      return {
        ...participant,
        is_muted: muted,
      };
    });

    if (changed) {
      this.rooms = [...this.rooms];
    }
  }

  #setRoomParticipants(roomId, participants) {
    const room = this.#roomsById.get(roomId);
    if (!room) {
      return;
    }

    const previous = room.active_participants || [];
    const stateByUserId = new Map(
      previous
        .filter((participant) => Number(participant?.id))
        .map((participant) => [
          Number(participant.id),
          {
            is_speaking: participant.is_speaking === true,
            is_muted: participant.is_muted === true,
          },
        ])
    );

    room.active_participants = (participants || []).map((participant) => {
      const participantId = Number(participant?.id);
      const previousState = stateByUserId.get(participantId);
      if (!participantId || !previousState) {
        return participant;
      }

      return {
        ...participant,
        is_speaking: previousState.is_speaking,
        is_muted: previousState.is_muted,
      };
    });
    this.rooms = [...this.rooms];
  }
}
