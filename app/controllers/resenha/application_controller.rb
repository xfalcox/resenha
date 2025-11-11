# frozen_string_literal: true

module Resenha
  class ApplicationController < ::ApplicationController
    requires_plugin ::Resenha::PLUGIN_NAME

    before_action :ensure_logged_in
    before_action :ensure_enabled!

    private

    def ensure_enabled!
      raise Discourse::InvalidAccess.new(I18n.t("resenha.errors.not_enabled")) unless Resenha.enabled?
    end

    def guardian
      @guardian ||= Guardian.new(current_user)
    end
  end
end
