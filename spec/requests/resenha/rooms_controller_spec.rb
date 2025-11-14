require "rails_helper"
require_relative "../../../db/migrate/20241107000000_create_resenha_rooms"

RSpec.describe Resenha::RoomsController do
  before(:all) do
    ActiveRecord::Migration.suppress_messages do
      CreateResenhaRooms.new.change unless ActiveRecord::Base.connection.table_exists?(:resenha_rooms)
    end
  end

  fab!(:staff) { Fabricate(:admin) }
  fab!(:user) { Fabricate(:user, trust_level: TrustLevel[2]) }
  fab!(:room) { Fabricate(:resenha_room, creator: staff, public: true) }

  before do
    SiteSetting.resenha_enabled = true
    SiteSetting.resenha_allow_trust_level = 2
  end

  describe "#index" do
    it "returns rooms visible to the user" do
      sign_in(user)

      get "/resenha/rooms.json"

      expect(response.status).to eq(200)
      expect(response.parsed_body["rooms"]).to be_present
    end
  end

  describe "#create" do
    it "allows trusted user to create a room" do
      sign_in(user)

      post "/resenha/rooms.json", params: { room: { name: "Game Night", public: true } }

      expect(response.status).to eq(200)
      expect(response.parsed_body["room"]["name"]).to eq("Game Night")
    end
  end

  describe "#join" do
    it "tracks users when they join a room" do
      sign_in(user)

      post "/resenha/rooms/#{room.id}/join.json"

      expect(response.status).to eq(200)
      json = response.parsed_body
      expect(json["room"]["active_participants"].map { |p| p["id"] }).to include(user.id)
    end
  end

  describe "#signal" do
    it "rejects missing payloads" do
      sign_in(user)

      post "/resenha/rooms/#{room.id}/signal.json", params: { payload: {} }

      expect(response.status).to eq(400)
    end

    it "relays ICE candidate payloads" do
      sign_in(user)

      candidate_payload = {
        candidate: "candidate:347230118 1 udp 41819902 203.0.113.1 54400 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "abc123",
      }

      expect(MessageBus).to receive(:publish).with(
        Resenha.room_channel(room.id),
        hash_including(
          type: "signal",
          room_id: room.id,
          sender_id: user.id,
          data: hash_including(type: "candidate", candidate: candidate_payload),
        ),
        user_ids: [staff.id],
      )

      post "/resenha/rooms/#{room.id}/signal.json",
           params: {
             payload: {
               type: "candidate",
               candidate: candidate_payload,
               recipient_id: staff.id,
             },
           }

      expect(response.status).to eq(204)
    end
  end
end
