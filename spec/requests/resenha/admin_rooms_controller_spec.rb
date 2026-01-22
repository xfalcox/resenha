# frozen_string_literal: true

require "rails_helper"
require_relative "../../../db/migrate/20241107000000_create_resenha_rooms"

RSpec.describe Resenha::AdminRoomsController do
  before do
    ActiveRecord::Migration.suppress_messages do
      unless ActiveRecord::Base.connection.table_exists?(:resenha_rooms)
        CreateResenhaRooms.new.change
      end
    end
  end

  fab!(:admin)
  fab!(:moderator)
  fab!(:user)
  fab!(:room) { Fabricate(:resenha_room, creator: admin, public: true, name: "Test Room") }

  before { SiteSetting.resenha_enabled = true }

  describe "#index" do
    it "returns 403 for non-staff users" do
      sign_in(user)
      get "/admin/plugins/resenha/rooms.json"
      expect(response.status).to eq(404)
    end

    it "returns rooms for admin users" do
      sign_in(admin)
      get "/admin/plugins/resenha/rooms.json"

      expect(response.status).to eq(200)
      expect(response.parsed_body["rooms"]).to be_an(Array)
      expect(response.parsed_body["rooms"].first["name"]).to eq("Test Room")
    end
  end

  describe "#show" do
    it "returns 403 for non-staff users" do
      sign_in(user)
      get "/admin/plugins/resenha/rooms/#{room.id}.json"
      expect(response.status).to eq(404)
    end

    it "returns room details for admin users" do
      sign_in(admin)
      get "/admin/plugins/resenha/rooms/#{room.id}.json"

      expect(response.status).to eq(200)
      expect(response.parsed_body["room"]["id"]).to eq(room.id)
      expect(response.parsed_body["room"]["name"]).to eq("Test Room")
      expect(response.parsed_body["room"]["creator"]).to be_present
    end

    it "returns 404 for non-existent room" do
      sign_in(admin)
      get "/admin/plugins/resenha/rooms/99999.json"
      expect(response.status).to eq(404)
    end
  end

  describe "#create" do
    it "returns 403 for non-staff users" do
      sign_in(user)
      post "/admin/plugins/resenha/rooms.json", params: { room: { name: "New Room" } }
      expect(response.status).to eq(404)
    end

    it "creates a room for admin users" do
      sign_in(admin)

      expect {
        post "/admin/plugins/resenha/rooms.json",
             params: {
               room: {
                 name: "New Room",
                 description: "A test room",
                 public: true,
                 max_participants: 10,
               },
             }
      }.to change { Resenha::Room.count }.by(1)

      expect(response.status).to eq(201)
      expect(response.parsed_body["room"]["name"]).to eq("New Room")
      expect(response.parsed_body["room"]["description"]).to eq("A test room")
      expect(response.parsed_body["room"]["public"]).to be(true)
      expect(response.parsed_body["room"]["max_participants"]).to eq(10)
    end

    it "returns errors for invalid data" do
      sign_in(admin)

      post "/admin/plugins/resenha/rooms.json", params: { room: { name: "" } }

      expect(response.status).to eq(422)
      expect(response.parsed_body["errors"]).to be_present
    end

    it "validates max_participants range" do
      sign_in(admin)

      post "/admin/plugins/resenha/rooms.json",
           params: {
             room: {
               name: "New Room",
               max_participants: 100,
             },
           }

      expect(response.status).to eq(422)
    end
  end

  describe "#update" do
    it "returns 403 for non-staff users" do
      sign_in(user)
      put "/admin/plugins/resenha/rooms/#{room.id}.json", params: { room: { name: "Updated" } }
      expect(response.status).to eq(404)
    end

    it "updates a room for admin users" do
      sign_in(admin)

      put "/admin/plugins/resenha/rooms/#{room.id}.json",
          params: {
            room: {
              name: "Updated Room",
              description: "Updated description",
            },
          }

      expect(response.status).to eq(200)
      expect(response.parsed_body["room"]["name"]).to eq("Updated Room")
      expect(response.parsed_body["room"]["description"]).to eq("Updated description")

      room.reload
      expect(room.name).to eq("Updated Room")
    end

    it "returns 404 for non-existent room" do
      sign_in(admin)
      put "/admin/plugins/resenha/rooms/99999.json", params: { room: { name: "Updated" } }
      expect(response.status).to eq(404)
    end

    it "returns errors for invalid data" do
      sign_in(admin)

      put "/admin/plugins/resenha/rooms/#{room.id}.json", params: { room: { name: "" } }

      expect(response.status).to eq(422)
    end
  end

  describe "#destroy" do
    it "returns 403 for non-staff users" do
      sign_in(user)
      delete "/admin/plugins/resenha/rooms/#{room.id}.json"
      expect(response.status).to eq(404)
    end

    it "deletes a room for admin users" do
      sign_in(admin)

      expect { delete "/admin/plugins/resenha/rooms/#{room.id}.json" }.to change {
        Resenha::Room.count
      }.by(-1)

      expect(response.status).to eq(204)
    end

    it "returns 404 for non-existent room" do
      sign_in(admin)
      delete "/admin/plugins/resenha/rooms/99999.json"
      expect(response.status).to eq(404)
    end
  end
end
