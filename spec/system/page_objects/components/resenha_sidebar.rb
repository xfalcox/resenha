# frozen_string_literal: true

module PageObjects
  module Components
    class ResenhaSidebar < PageObjects::Components::Base
      SECTION_SELECTOR = ".sidebar-section[data-section-name='resenha-rooms']"
      ROOM_LINK_SELECTOR = ".sidebar-section-link.resenha-sidebar-link"

      def visible?
        page.has_css?(SECTION_SELECTOR)
      end

      def not_visible?
        page.has_no_css?(SECTION_SELECTOR)
      end

      def has_room?(room_name)
        page.has_css?(SECTION_SELECTOR, text: room_name)
      end

      def has_no_room?(room_name)
        page.has_no_css?(SECTION_SELECTOR, text: room_name)
      end

      def room_link(room_id)
        find("#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}']")
      end

      def has_room_link?(room_id)
        page.has_css?("#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}']")
      end

      def has_no_room_link?(room_id)
        page.has_no_css?("#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}']")
      end

      def click_room(room_id)
        room_link(room_id).click
        self
      end

      def has_active_room?(room_id)
        page.has_css?(
          "#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}'].sidebar-section-link--active",
        )
      end

      def has_no_active_room?(room_id)
        page.has_no_css?(
          "#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}'].sidebar-section-link--active",
        )
      end

      def has_participants?(room_id)
        page.has_css?(
          "#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}'] .resenha-sidebar-link__participants",
        )
      end

      def has_no_participants?(room_id)
        page.has_no_css?(
          "#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}'] .resenha-sidebar-link__participants",
        )
      end

      def has_speaking_indicator?(room_id)
        page.has_css?(
          "#{ROOM_LINK_SELECTOR}[data-link-name='resenha-room-#{room_id}'] .resenha-sidebar-link__avatar--speaking",
        )
      end

      def section_title
        find("#{SECTION_SELECTOR} .sidebar-section-header-text").text
      end
    end
  end
end
