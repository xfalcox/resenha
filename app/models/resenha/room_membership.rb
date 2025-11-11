# frozen_string_literal: true

module Resenha
  class RoomMembership < ActiveRecord::Base
    self.table_name = "#{Resenha.table_name_prefix}room_memberships"

    belongs_to :room, class_name: "Resenha::Room"
    belongs_to :user

    ROLE_PARTICIPANT = 0
    ROLE_MODERATOR = 1
    ROLES = {
      "participant" => ROLE_PARTICIPANT,
      "moderator" => ROLE_MODERATOR,
    }.freeze

    scope :moderator, -> { where(role: ROLE_MODERATOR) }

    def moderator?
      role == ROLE_MODERATOR
    end

    def participant?
      role == ROLE_PARTICIPANT
    end

    def role_name
      ROLES.key(role) || "participant"
    end

    def self.role_value(key)
      return ROLE_PARTICIPANT if key.blank?

      ROLES[key.to_s] || ROLE_PARTICIPANT
    end

    validates :room_id, presence: true
    validates :user_id, presence: true, uniqueness: { scope: :room_id }
  end
end
