# frozen_string_literal: true

module Resenha
  class Room < ActiveRecord::Base
    self.table_name = "#{Resenha.table_name_prefix}rooms"

    belongs_to :creator, class_name: "User"
    has_many :room_memberships,
             class_name: "Resenha::RoomMembership",
             dependent: :destroy
    has_many :members, through: :room_memberships, source: :user

    validates :name, presence: true, length: { maximum: 80 }
    validates :slug, presence: true, uniqueness: true
    validates :max_participants,
              numericality: {
                only_integer: true,
                allow_nil: true,
                greater_than_or_equal_to: 2,
                less_than_or_equal_to: 50,
              }

    before_validation :ensure_slug
    after_commit :ensure_creator_membership, on: :create

    scope :public_rooms, -> { where(public: true) }

    def moderator_ids
      room_memberships.moderator.pluck(:user_id)
    end

    def member_ids
      room_memberships.pluck(:user_id)
    end

    def message_bus_targets
      if public?
        { group_ids: [Group::AUTO_GROUPS[:trust_level_0]] }
      else
        { user_ids: member_ids }
      end
    end

    private

    def ensure_slug
      self.slug = Slug.for(name) if slug.blank? && name.present?
    end

    def ensure_creator_membership
      room_memberships.find_or_create_by!(user: creator) do |membership|
        membership.role = Resenha::RoomMembership::ROLE_MODERATOR
      end
    end
  end
end
