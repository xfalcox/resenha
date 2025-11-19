# frozen_string_literal: true

module Jobs
  class PublishRoomParticipants < ::Jobs::Scheduled
    every 1.minute
    sidekiq_options retry: false
    cluster_concurrency 1

    def execute(args)
      return unless Resenha.enabled?

      # Find all room participant keys in Redis
      pattern = "#{Resenha::ParticipantTracker::KEY_NAMESPACE}:*:participants"
      redis = Discourse.redis

      # Use scan_each to iterate through matching keys
      # This is safe for production as resenha rooms should be a manageable number
      redis.scan_each(match: pattern) do |key|
        # Extract room_id from key: "resenha:room:123:participants" -> 123
        if key =~ /#{Regexp.escape(Resenha::ParticipantTracker::KEY_NAMESPACE)}:(\d+):participants/
          room_id = Regexp.last_match(1).to_i
          room = Resenha::Room.find_by(id: room_id)

          if room
            # Publish current participants (will reflect any TTL-expired removals)
            Resenha::RoomBroadcaster.publish_participants(room)
            Rails.logger.debug(
              "[resenha] published participants for room #{room_id} (scheduled job)",
            )
          end
        end
      end
    end
  end
end
