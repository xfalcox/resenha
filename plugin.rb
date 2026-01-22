# frozen_string_literal: true

# name: resenha
# about: Voice chat rooms powered by WebRTC inside Discourse
# version: 0.1
# authors: Discourse Contributors
# url: https://github.com/discourse/resenha

enabled_site_setting :resenha_enabled

register_svg_icon "microphone-lines"
register_svg_icon "phone"
register_svg_icon "waveform"
register_asset "stylesheets/common/resenha.scss"
register_asset "stylesheets/common/resenha-admin.scss", :admin

add_admin_route "resenha.admin.title", "resenha", use_new_show_route: true

require_relative "lib/resenha"

after_initialize do
  require_relative "lib/resenha/user_extension"

  Discourse::Application.routes.append { mount ::Resenha::Engine, at: "/resenha" }

  Guardian.prepend Resenha::GuardianExtension

  Resenha::DefaultRoomSeeder.ensure! if SiteSetting.resenha_enabled?

  on(:site_setting_changed) do |name, _old_value, new_value|
    next if name.to_sym != :resenha_enabled
    next if !new_value

    Resenha::DefaultRoomSeeder.ensure!
  end
end
