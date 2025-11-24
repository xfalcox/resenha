# frozen_string_literal: true

module Resenha
  class RoomsController < ApplicationController
    before_action :load_room, only: %i[show update destroy join leave participants signal]

    def index
      Resenha::DefaultRoomSeeder.ensure!

      rooms =
        Resenha::Room
          .includes(:room_memberships)
          .order(:created_at)
          .select { |room| guardian.can_see_resenha_room?(room) }

      render_serialized rooms, Resenha::RoomSerializer, root: :rooms
    end

    def show
      guardian.ensure_can_see_resenha_room!(@room)
      render_serialized @room, Resenha::RoomSerializer, root: :room
    end

    def create
      guardian.ensure_can_create_resenha_room!

      if current_user.resenha_rooms.count >= SiteSetting.resenha_max_rooms_per_user
        raise Discourse::InvalidParameters.new(I18n.t("resenha.errors.room_limit"))
      end

      room = Resenha::Room.new(room_params)
      room.creator = current_user

      if room.save
        Resenha::DirectoryBroadcaster.broadcast(action: :created, room: room)
        render_serialized room, Resenha::RoomSerializer, root: :room
      else
        render_json_error room
      end
    end

    def update
      guardian.ensure_can_manage_resenha_room!(@room)

      if @room.update(room_params)
        Resenha::DirectoryBroadcaster.broadcast(action: :updated, room: @room)
        render_serialized @room, Resenha::RoomSerializer, root: :room
      else
        render_json_error @room
      end
    end

    def destroy
      guardian.ensure_can_manage_resenha_room!(@room)
      @room.destroy!
      Resenha::DirectoryBroadcaster.broadcast(action: :destroyed, room: @room)
      render json: success_json
    end

    def join
      guardian.ensure_can_join_resenha_room!(@room)
      Resenha::ParticipantTracker.add(@room.id, current_user.id)
      Resenha::RoomBroadcaster.publish_participants(@room)

      render json: {
               room: Resenha::RoomSerializer.new(@room, scope: guardian, root: false).as_json,
             }
    end

    def leave
      guardian.ensure_can_join_resenha_room!(@room)
      Resenha::ParticipantTracker.remove(@room.id, current_user.id)
      Resenha::RoomBroadcaster.publish_participants(@room)
      head :no_content
    end

    def participants
      guardian.ensure_can_join_resenha_room!(@room)
      render json: {
               participants:
                 ActiveModel::Serializer::CollectionSerializer.new(
                   Resenha::ParticipantTracker.list(@room.id),
                   serializer: BasicUserSerializer,
                   scope: guardian,
                   root: false,
                 ),
             }
    end

    def signal
      guardian.ensure_can_join_resenha_room!(@room)
      payload =
        params
          .require(:payload)
          .permit(
            :type,
            :sdp,
            :recipient_id,
            candidate: {
            },
            metadata: {
            },
            events: [:type, :sdp, { candidate: {}, metadata: {} }],
            messages: [
              :recipient_id,
              :type,
              :sdp,
              {
                candidate: {
                },
                metadata: {
                },
                events: [:type, :sdp, { candidate: {}, metadata: {} }],
              },
            ],
          )
          .to_h
          .deep_symbolize_keys

      if payload.blank?
        raise Discourse::InvalidParameters.new(I18n.t("resenha.errors.missing_payload"))
      end

      relay = Resenha::SignalRelay.new(@room)
      messages = extract_batched_messages(payload)
      recipient_id = payload[:recipient_id].to_i

      if recipient_id.positive?
        events = extract_signal_events(payload)
        messages << { recipient_id: recipient_id, events: events } if events.present?
      end

      if messages.blank?
        raise Discourse::InvalidParameters.new(I18n.t("resenha.errors.missing_payload"))
      end

      messages.each do |message|
        message[:events].each do |event|
          relay.publish!(from: current_user, recipient_id: message[:recipient_id], data: event)
        end
      end

      head :no_content
    end

    private

    def room_params
      params.require(:room).permit(:name, :description, :public, :max_participants)
    end

    def extract_batched_messages(payload)
      normalize_collection(payload[:messages]).filter_map do |raw_message|
        message = normalize_signal_payload(raw_message)
        next if message.blank?

        recipient_id = message[:recipient_id].to_i
        next unless recipient_id.positive?

        events = extract_signal_events(message)
        next if events.blank?

        { recipient_id: recipient_id, events: events }
      end
    end

    def extract_signal_events(container)
      events =
        normalize_collection(container[:events]).filter_map do |event|
          normalized = normalize_signal_payload(event)
          normalized.presence
        end

      return events if events.present?

      fallback = container.except(:recipient_id, :events, :messages).presence
      fallback ? [fallback] : []
    end

    def normalize_signal_payload(value)
      return {} if value.blank?

      if value.respond_to?(:to_h)
        value.to_h.deep_symbolize_keys
      else
        value
      end
    rescue NoMethodError, TypeError
      {}
    end

    def normalize_collection(raw)
      return [] if raw.blank?

      array =
        if raw.is_a?(Array)
          raw
        elsif raw.respond_to?(:to_unsafe_h)
          raw.to_unsafe_h
        elsif raw.respond_to?(:to_h)
          raw.to_h
        else
          Array.wrap(raw)
        end

      return array if array.is_a?(Array)

      array.sort_by { |key, _| key.to_s }.map { |_, value| value }
    end

    def load_room
      @room =
        Resenha::Room.find_by(id: params[:id]) ||
          Resenha::Room.find_by!(slug: params[:id] || params[:slug])
    end
  end
end
