# frozen_string_literal: true

module Resenha
  module GuardianExtension
    def can_access_resenha?
      SiteSetting.resenha_enabled? && authenticated?
    end

    def can_manage_resenha_rooms?
      return false unless can_access_resenha?

      return true if is_staff?

      SiteSetting.resenha_allow_trust_level >= 0 &&
        user&.trust_level.to_i >= SiteSetting.resenha_allow_trust_level
    end

    def can_manage_resenha_room?(room)
      return false unless can_access_resenha?
      return false unless room

      can_manage_resenha_rooms? ||
        room.creator_id == user&.id ||
        room.moderator_ids.include?(user&.id)
    end

    def ensure_can_manage_resenha_room!(room)
      raise Discourse::InvalidAccess.new(I18n.t("resenha.errors.not_authorized")) unless
        can_manage_resenha_room?(room)
    end

    def ensure_can_create_resenha_room!
      raise Discourse::InvalidAccess.new(I18n.t("resenha.errors.not_authorized")) unless
        can_manage_resenha_rooms?
    end

    def can_join_resenha_room?(room)
      return false unless can_access_resenha?
      return false unless room

      room.public? || room.member_ids.include?(user.id) || can_manage_resenha_room?(room)
    end

    def ensure_can_join_resenha_room!(room)
      raise Discourse::InvalidAccess.new(I18n.t("resenha.errors.not_authorized")) unless
        can_join_resenha_room?(room)
    end

    def can_see_resenha_room?(room)
      can_join_resenha_room?(room)
    end
  end
end
