# frozen_string_literal: true

RSpec.describe Jobs::PublishRoomParticipants do
  fab!(:room, :resenha_room)
  fab!(:user1, :user)
  fab!(:user2, :user)

  before { SiteSetting.resenha_enabled = true }

  it "publishes participants for rooms with active participants" do
    Resenha::ParticipantTracker.add(room.id, user1.id)
    Resenha::ParticipantTracker.add(room.id, user2.id)

    # Verify participants were added
    expect(Resenha::ParticipantTracker.user_ids(room.id)).to contain_exactly(user1.id, user2.id)

    messages = MessageBus.track_publish { subject.execute({}) }

    room_messages = messages.select { |m| m.channel == Resenha.room_channel(room.id) }
    expect(room_messages.size).to eq(1)
    expect(room_messages.first.data[:type]).to eq("participants")
    expect(room_messages.first.data[:participants].map { |p| p[:id] }).to contain_exactly(
      user1.id,
      user2.id,
    )
  end

  it "reflects TTL-expired participants in broadcast" do
    Resenha::ParticipantTracker.add(room.id, user1.id)
    Resenha::ParticipantTracker.add(room.id, user2.id)

    # Manually remove user2 to simulate TTL expiration
    Discourse.redis.srem(
      "#{Resenha::ParticipantTracker::KEY_NAMESPACE}:#{room.id}:participants",
      user2.id,
    )

    messages = MessageBus.track_publish { subject.execute({}) }

    room_messages = messages.select { |m| m.channel == Resenha.room_channel(room.id) }
    expect(room_messages.size).to eq(1)
    expect(room_messages.first.data[:participants].map { |p| p[:id] }).to contain_exactly(user1.id)
  end

  it "does not publish for rooms without participants" do
    messages = MessageBus.track_publish { subject.execute({}) }

    expect(messages).to be_empty
  end

  it "handles rooms that no longer exist" do
    Resenha::ParticipantTracker.add(99_999, user1.id)

    expect { subject.execute({}) }.not_to raise_error
  end

  it "does not publish when plugin is disabled" do
    Resenha::ParticipantTracker.add(room.id, user1.id)

    SiteSetting.resenha_enabled = false

    messages = MessageBus.track_publish { subject.execute({}) }

    expect(messages).to be_empty
  end
end
