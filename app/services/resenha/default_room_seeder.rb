# frozen_string_literal: true

module Resenha
  class DefaultRoomSeeder
    DEFAULT_NAME = "Watercooler"
    MUTEX = "resenha-default-room-seeder"

    def self.ensure!
      return unless SiteSetting.resenha_enabled?
      return unless ActiveRecord::Base.connection.table_exists?(:resenha_rooms)

      DistributedMutex.synchronize(MUTEX) do
        next if Resenha::Room.exists?

        room = Resenha::Room.create!(
          name: DEFAULT_NAME,
          description: I18n.t("resenha.defaults.watercooler_description"),
          public: true,
          creator: Discourse.system_user,
        )

        Resenha::DirectoryBroadcaster.broadcast(action: :created, room: room)
      end
    end
  end
end
