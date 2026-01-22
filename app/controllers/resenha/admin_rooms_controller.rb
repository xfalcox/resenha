# frozen_string_literal: true

module Resenha
  class AdminRoomsController < ::Admin::AdminController
    requires_plugin "resenha"

    def index
      rooms = Resenha::Room.includes(:creator, :room_memberships).order(:name).all

      render_serialized rooms, AdminRoomSerializer, root: :rooms
    end

    def show
      room = Resenha::Room.includes(:creator, :room_memberships).find(params[:id])
      render_serialized room, AdminRoomSerializer, root: :room
    end

    def create
      room = Resenha::Room.new(room_params)
      room.creator = current_user

      if room.save
        render_serialized room, AdminRoomSerializer, root: :room, status: :created
      else
        render_json_error room
      end
    end

    def update
      room = Resenha::Room.find(params[:id])

      if room.update(room_params)
        render_serialized room, AdminRoomSerializer, root: :room
      else
        render_json_error room
      end
    end

    def destroy
      room = Resenha::Room.find(params[:id])
      room.destroy!
      head :no_content
    end

    private

    def room_params
      params.require(:room).permit(:name, :description, :public, :max_participants)
    end
  end
end
