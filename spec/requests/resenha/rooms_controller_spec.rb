# frozen_string_literal: true
require "rails_helper"
require_relative "../../../db/migrate/20241107000000_create_resenha_rooms"

RSpec.describe Resenha::RoomsController do
  before do
    ActiveRecord::Migration.suppress_messages do
      unless ActiveRecord::Base.connection.table_exists?(:resenha_rooms)
        CreateResenhaRooms.new.change
      end
    end
  end

  fab!(:staff, :admin)
  fab!(:user) { Fabricate(:user, trust_level: TrustLevel[2]) }
  fab!(:other_participant) { Fabricate(:user, trust_level: TrustLevel[2]) }
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

  describe "#kick" do
    before { Resenha::ParticipantTracker.add(room.id, other_participant.id) }

    it "allows room manager to kick participants" do
      sign_in(staff)

      published = []
      allow(MessageBus).to receive(:publish) { |channel, data, opts|
        published << [channel, data, opts]
      }

      delete "/resenha/rooms/#{room.id}/kick.json", params: { user_id: other_participant.id }

      expect(response.status).to eq(204)
      expect(Resenha::ParticipantTracker.user_ids(room.id)).not_to include(other_participant.id)

      kick_message = published.find { |(_, data)| data[:type] == "kicked" }
      expect(kick_message).to be_present
      expect(kick_message[2][:user_ids]).to eq([other_participant.id])
    end

    it "prevents non-managers from kicking" do
      low_trust_user = Fabricate(:user, trust_level: TrustLevel[0])
      sign_in(low_trust_user)

      delete "/resenha/rooms/#{room.id}/kick.json", params: { user_id: other_participant.id }

      expect(response.status).to eq(403)
    end

    it "prevents kicking oneself" do
      sign_in(staff)

      delete "/resenha/rooms/#{room.id}/kick.json", params: { user_id: staff.id }

      expect(response.status).to eq(400)
    end

    it "prevents kicking the room creator" do
      sign_in(staff)
      other_room = Fabricate(:resenha_room, creator: user, public: true)
      Resenha::ParticipantTracker.add(other_room.id, user.id)

      delete "/resenha/rooms/#{other_room.id}/kick.json", params: { user_id: user.id }

      expect(response.status).to eq(400)
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

      published = []
      allow(MessageBus).to receive(:publish) do |channel, data, opts|
        published << [channel, data, opts]
      end

      post "/resenha/rooms/#{room.id}/signal.json",
           params: {
             payload: {
               type: "candidate",
               candidate: candidate_payload,
               recipient_id: staff.id,
             },
           }

      expect(response.status).to eq(204)

      # Verify MessageBus received correct parameters
      expect(MessageBus).to have_received(:publish) do |channel, data, opts|
        expect(channel).to eq(Resenha.room_channel(room.id))
        expect(data[:type]).to eq("signal")
        expect(data[:room_id]).to eq(room.id)
        expect(data[:sender_id]).to eq(user.id)
        expect(data[:data][:type]).to eq("candidate")
        expect(data[:data][:candidate][:candidate]).to eq(candidate_payload[:candidate])
        expect(opts[:user_ids]).to eq([staff.id])
      end
    end

    it "accepts batched events payloads" do
      sign_in(user)

      published = []
      allow(MessageBus).to receive(:publish) do |channel, data, opts|
        published << [channel, data, opts]
      end

      post "/resenha/rooms/#{room.id}/signal.json",
           params: {
             payload: {
               recipient_id: staff.id,
               events: [
                 { type: "offer", sdp: "v=0" },
                 {
                   type: "candidate",
                   candidate: {
                     candidate: "candidate:1 1 udp 2122260223 10.0.0.1 8998 typ host",
                   },
                 },
               ],
             },
           }

      expect(response.status).to eq(204)
      expect(MessageBus).to have_received(:publish).twice

      expect(published.map(&:first)).to all(eq(Resenha.room_channel(room.id)))
      expect(published.map { |(_, data)| data[:sender_id] }).to all(eq(user.id))
      expect(published.map { |(_, _, opts)| opts[:user_ids] }).to all(eq([staff.id]))

      types = published.map { |(_, data)| data[:data][:type] }
      expect(types).to contain_exactly("offer", "candidate")
      expect(published.find { |(_, data)| data[:data][:type] == "offer" }[1][:data][:sdp]).to eq(
        "v=0",
      )
      expect(
        published.find { |(_, data)| data[:data][:type] == "candidate" }[1][:data][:candidate][
          :candidate
        ],
      ).to eq("candidate:1 1 udp 2122260223 10.0.0.1 8998 typ host")
    end

    it "relays multi-recipient batched messages" do
      sign_in(user)

      published = []
      allow(MessageBus).to receive(:publish) do |channel, data, opts|
        published << [channel, data, opts]
      end

      post "/resenha/rooms/#{room.id}/signal.json",
           params: {
             payload: {
               messages: [
                 { recipient_id: staff.id, events: [{ type: "offer", sdp: "v=0" }] },
                 {
                   recipient_id: other_participant.id,
                   events: [
                     {
                       type: "candidate",
                       candidate: {
                         candidate: "candidate:1 1 udp 2122260223 10.0.0.1 8998 typ host",
                       },
                     },
                   ],
                 },
               ],
             },
           }

      expect(response.status).to eq(204)
      expect(published.size).to eq(2)
      expect(published.map(&:first)).to all(eq(Resenha.room_channel(room.id)))
      expect(published.map { |(_, data)| data[:sender_id] }).to all(eq(user.id))

      offer_payload = published.find { |(_, data)| data[:data][:type] == "offer" }
      candidate_payload = published.find { |(_, data)| data[:data][:type] == "candidate" }

      expect(offer_payload[1][:data][:sdp]).to eq("v=0")
      expect(offer_payload[2][:user_ids]).to eq([staff.id])
      expect(candidate_payload[1][:data][:candidate][:candidate]).to eq(
        "candidate:1 1 udp 2122260223 10.0.0.1 8998 typ host",
      )
      expect(candidate_payload[2][:user_ids]).to eq([other_participant.id])
    end
  end
end
