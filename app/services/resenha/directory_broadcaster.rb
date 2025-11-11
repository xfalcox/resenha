# frozen_string_literal: true

module Resenha
  class DirectoryBroadcaster
    def self.broadcast(action:, room:)
      new(room, action).broadcast
    end

    def initialize(room, action)
      @room = room
      @action = action
    end

    def broadcast
      MessageBus.publish(
        Resenha.room_index_channel,
        {
          type: action,
          room: Resenha::RoomSerializer.new(room, scope: Guardian.new(nil), root: false).as_json,
        },
      )
    end

    private

    attr_reader :room, :action
  end
end
