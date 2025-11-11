# frozen_string_literal: true

module Resenha
  class RoomSerializer < ApplicationSerializer
    attributes :id,
               :name,
               :slug,
               :description,
               :public,
               :max_participants,
               :created_at,
               :updated_at,
               :member_count,
               :active_participants

    has_one :membership, serializer: Resenha::RoomMembershipSerializer, embed: :objects

    def membership
      object.room_memberships.find { |membership| membership.user_id == scope.user&.id }
    end

    def member_count
      object.room_memberships.size
    end

    def active_participants
      Resenha::ParticipantTracker
        .list(object.id)
        .map { |user| BasicUserSerializer.new(user, scope: scope, root: false).as_json }
    end
  end
end
