# frozen_string_literal: true

module Resenha
  class AdminRoomSerializer < ApplicationSerializer
    attributes :id,
               :name,
               :slug,
               :description,
               :public,
               :max_participants,
               :member_count,
               :created_at,
               :updated_at

    has_one :creator, serializer: BasicUserSerializer, embed: :objects

    def member_count
      object.room_memberships.size
    end
  end
end
