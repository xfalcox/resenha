# frozen_string_literal: true

module Resenha
  class SignalRelay
    def initialize(room)
      @room = room
    end

    def publish!(from:, recipient_id:, data:)
      if data.blank? || recipient_id.blank?
        raise Discourse::InvalidParameters.new(I18n.t("resenha.errors.missing_payload"))
      end

      MessageBus.publish(
        Resenha.room_channel(room.id),
        {
          type: "signal",
          room_id: room.id,
          sender_id: from.id,
          data: data,
        },
        user_ids: Array(recipient_id),
      )
    end

    private

    attr_reader :room
  end
end
