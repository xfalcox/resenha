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

# == Schema Information
#
# Table name: resenha_room_memberships
#
#  id         :bigint           not null, primary key
#  role       :integer          default(0), not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#  room_id    :bigint           not null
#  user_id    :bigint           not null
#
# Indexes
#
#  idx_resenha_room_memberships_on_room_and_user  (room_id,user_id) UNIQUE
#  index_resenha_room_memberships_on_room_id      (room_id)
#  index_resenha_room_memberships_on_user_id      (user_id)
#
# Foreign Keys
#
#  fk_rails_...  (room_id => resenha_rooms.id)
#  fk_rails_...  (user_id => users.id)
#
