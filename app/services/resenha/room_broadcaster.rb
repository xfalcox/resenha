# frozen_string_literal: true

module Resenha
  class RoomBroadcaster
    def self.publish_participants(room)
      new(room).publish_participants
    end

    def self.publish_kick(room, user_id)
      new(room).publish_kick(user_id)
    end

    def initialize(room)
      @room = room
    end

    def publish_participants
      guardian = Guardian.new(nil)
      payload = {
        type: "participants",
        room_id: room.id,
        participants:
          Resenha::ParticipantTracker
            .list(room.id)
            .map { |user| BasicUserSerializer.new(user, scope: guardian, root: false).as_json },
      }

      MessageBus.publish(Resenha.room_channel(room.id), payload, **room.message_bus_targets)
    end

    def publish_room(payload)
      MessageBus.publish(
        Resenha.room_channel(room.id),
        payload.merge(room_id: room.id),
        **room.message_bus_targets,
      )
    end

    def publish_kick(user_id)
      MessageBus.publish(
        Resenha.room_channel(room.id),
        { type: "kicked", room_id: room.id },
        user_ids: [user_id],
      )
    end

    private

    attr_reader :room
  end
end
