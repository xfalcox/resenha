# frozen_string_literal: true

module Resenha
  class ParticipantTracker
    KEY_NAMESPACE = "resenha:room".freeze

    class << self
      def add(room_id, user_id)
        redis.sadd(key(room_id), user_id)
        redis.expire(key(room_id), SiteSetting.resenha_participant_ttl_seconds)
      end

      def remove(room_id, user_id)
        redis.srem(key(room_id), user_id)
      end

      def list(room_id)
        User.where(id: redis.smembers(key(room_id)))
      end

      def user_ids(room_id)
        redis.smembers(key(room_id)).map(&:to_i)
      end

      def clear(room_id)
        redis.del(key(room_id))
      end

      private

      def redis
        @redis ||= Discourse.redis
      end

      def key(room_id)
        "#{KEY_NAMESPACE}:#{room_id}:participants"
      end
    end
  end
end
