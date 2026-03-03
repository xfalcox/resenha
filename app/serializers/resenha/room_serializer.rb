# frozen_string_literal: true

module Resenha
  class RoomSerializer < ApplicationSerializer
    attributes :id,
               :name,
               :slug,
               :description,
               :cooked_description,
               :public,
               :max_participants,
               :created_at,
               :updated_at,
               :member_count,
               :active_participants,
               :creator_id,
               :can_manage,
               :description_excerpt

    has_one :membership, serializer: Resenha::RoomMembershipSerializer, embed: :objects

    def membership
      object.room_memberships.find { |membership| membership.user_id == scope.user&.id }
    end

    def member_count
      object.room_memberships.size
    end

    def active_participants
      metadata = Resenha::ParticipantTracker.get_all_metadata(object.id)

      Resenha::ParticipantTracker
        .list(object.id)
        .map do |user|
          json = BasicUserSerializer.new(user, scope: scope, root: false).as_json
          json.merge!(metadata[user.id.to_s] || {})
          json
        end
    end

    def can_manage
      scope.can_manage_resenha_room?(object)
    end

    def description_excerpt
      object.description&.lines&.first&.truncate(150)
    end
  end
end
