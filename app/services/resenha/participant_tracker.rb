# frozen_string_literal: true

module Resenha
  class ParticipantTracker
    KEY_NAMESPACE = "resenha:room".freeze

    class << self
      def add(room_id, user_id)
        redis.sadd(key(room_id), user_id)
        redis.expire(key(room_id), SiteSetting.resenha_participant_ttl_seconds)
      end

      def update_metadata(room_id, user_id, metadata)
        redis.hset(metadata_key(room_id), user_id, metadata.to_json)
        redis.expire(metadata_key(room_id), SiteSetting.resenha_participant_ttl_seconds)
      end

      def get_metadata(room_id, user_id)
        raw = redis.hget(metadata_key(room_id), user_id)
        raw ? JSON.parse(raw).symbolize_keys : {}
      end

      def get_all_metadata(room_id)
        redis.hgetall(metadata_key(room_id)).transform_values { |v| JSON.parse(v).symbolize_keys }
      end

      def remove(room_id, user_id)
        redis.srem(key(room_id), user_id)
        redis.hdel(metadata_key(room_id), user_id)
      end

      def list(room_id)
        User.where(id: redis.smembers(key(room_id)))
      end

      def user_ids(room_id)
        redis.smembers(key(room_id)).map(&:to_i)
      end

      def clear(room_id)
        redis.del(key(room_id))
        redis.del(metadata_key(room_id))
      end

      private

      def redis
        @redis ||= Discourse.redis
      end

      def key(room_id)
        "#{KEY_NAMESPACE}:#{room_id}:participants"
      end

      def metadata_key(room_id)
        "#{KEY_NAMESPACE}:#{room_id}:metadata"
      end
    end
  end
end
