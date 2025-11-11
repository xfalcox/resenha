# frozen_string_literal: true

module ::Resenha
  PLUGIN_NAME = "resenha"
  ROOM_CHANNEL_PREFIX = "/resenha/rooms"
  ROOM_INDEX_CHANNEL = "/resenha/rooms/index"

  def self.table_name_prefix
    "resenha_"
  end

  def self.enabled?
    SiteSetting.resenha_enabled
  end

  def self.room_channel(room_id)
    "#{ROOM_CHANNEL_PREFIX}/#{room_id}"
  end

  def self.room_index_channel
    ROOM_INDEX_CHANNEL
  end
end

require_relative "resenha/engine"
require_relative "resenha/guardian_extension"
