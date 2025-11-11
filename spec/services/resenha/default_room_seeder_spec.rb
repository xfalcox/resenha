require "rails_helper"
require_relative "../../../db/migrate/20241107000000_create_resenha_rooms"

RSpec.describe Resenha::DefaultRoomSeeder do
  before(:all) do
    ActiveRecord::Migration.suppress_messages do
      CreateResenhaRooms.new.change unless ActiveRecord::Base.connection.table_exists?(:resenha_rooms)
    end
  end

  before do
    wipe_rooms!
  end

  it "creates a Watercooler room when resenha is enabled and no rooms exist" do
    SiteSetting.resenha_enabled = true
    wipe_rooms!

    expect { described_class.ensure! }.to change { Resenha::Room.count }.by(1)

    room = Resenha::Room.first
    expect(room.name).to eq("Watercooler")
    expect(room.public).to eq(true)
  end

  it "does nothing if resenha is disabled" do
    SiteSetting.resenha_enabled = false

    expect { described_class.ensure! }.not_to change { Resenha::Room.count }
  end

  it "does nothing if rooms already exist" do
    SiteSetting.resenha_enabled = true
    wipe_rooms!
    Fabricate(:resenha_room, name: "Existing", creator: Fabricate(:admin))

    expect { described_class.ensure! }.not_to change { Resenha::Room.count }
  end

  def wipe_rooms!
    Resenha::RoomMembership.delete_all
    Resenha::Room.delete_all
  end
end
