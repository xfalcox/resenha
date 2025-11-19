# frozen_string_literal: true

require_relative "page_objects/components/resenha_sidebar"

describe "Resenha voice rooms", type: :system do
  let(:resenha_sidebar) { PageObjects::Components::ResenhaSidebar.new }

  fab!(:user)
  fab!(:admin)

  before do
    user.activate
    SiteSetting.resenha_enabled = true
    SiteSetting.resenha_allow_trust_level = 2
  end

  context "when plugin is disabled" do
    it "does not show voice rooms section" do
      SiteSetting.resenha_enabled = false
      Fabricate(:resenha_room, name: "Test Room", creator: admin, public: true)
      sign_in(user)

      visit("/latest")

      expect(resenha_sidebar).to be_not_visible
    end
  end

  context "when plugin is enabled" do
    context "as anonymous user" do
      it "does not show voice rooms section" do
        Fabricate(:resenha_room, name: "Test Room", creator: admin, public: true)

        visit("/latest")

        expect(resenha_sidebar).to be_not_visible
      end
    end

    context "as logged in user" do
      fab!(:room) { Fabricate(:resenha_room, name: "Test Room", creator: admin, public: true) }

      before do
        user.update!(trust_level: TrustLevel[2])
        sign_in(user)
      end

      it "shows voice rooms section when rooms exist" do
        visit("/latest")

        expect(resenha_sidebar).to be_visible
      end

      it "displays public rooms in the sidebar" do
        visit("/latest")

        expect(resenha_sidebar).to be_visible
        expect(resenha_sidebar).to have_room(room.name)
      end

      it "shows private rooms when user can manage rooms" do
        private_room = Fabricate(:resenha_room, name: "Private Room", creator: admin, public: false)

        visit("/latest")

        # Users with sufficient trust level can see and manage all rooms, including private ones
        expect(resenha_sidebar).to have_room(room.name)
        expect(resenha_sidebar).to have_room(private_room.name)
      end
    end

    context "as admin" do
      before do
        admin.activate
        sign_in(admin)
      end

      it "shows voice rooms section when rooms exist" do
        Fabricate(:resenha_room, name: "Admin Room", creator: admin, public: true)

        visit("/latest")

        expect(resenha_sidebar).to be_visible
      end
    end

    context "when user has insufficient trust level" do
      fab!(:low_trust_user) { Fabricate(:user, trust_level: TrustLevel[0]) }

      before do
        low_trust_user.activate
        SiteSetting.resenha_allow_trust_level = 2
        sign_in(low_trust_user)
      end

      it "shows public rooms but hides private rooms" do
        public_room = Fabricate(:resenha_room, name: "Public Room", creator: admin, public: true)
        private_room = Fabricate(:resenha_room, name: "Private Room", creator: admin, public: false)

        visit("/latest")

        expect(resenha_sidebar).to be_visible
        expect(resenha_sidebar).to have_room(public_room.name)
        expect(resenha_sidebar).to have_no_room(private_room.name)
      end
    end
  end
end
