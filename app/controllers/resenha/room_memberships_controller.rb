# frozen_string_literal: true

module Resenha
  class RoomMembershipsController < ApplicationController
    before_action :load_room

    def index
      guardian.ensure_can_manage_resenha_room!(@room)
      render_serialized @room.room_memberships, Resenha::RoomMembershipSerializer,
                        root: :memberships
    end

    def create
      guardian.ensure_can_manage_resenha_room!(@room)
      user = fetch_user
      membership =
        @room.room_memberships.find_or_create_by!(user: user) do |record|
          record.role = Resenha::RoomMembership.role_value(params[:role])
        end

      render_serialized membership, Resenha::RoomMembershipSerializer, root: :membership
    end

    def update
      guardian.ensure_can_manage_resenha_room!(@room)
      membership = @room.room_memberships.find(params[:id])
      membership.update!(role: Resenha::RoomMembership.role_value(params.require(:role)))
      render_serialized membership, Resenha::RoomMembershipSerializer, root: :membership
    end

    def destroy
      guardian.ensure_can_manage_resenha_room!(@room)
      membership = @room.room_memberships.find(params[:id])
      membership.destroy!
      head :no_content
    end

    private

    def fetch_user
      if params[:user_id]
        User.find(params[:user_id])
      elsif params[:username]
        User.find_by_username_or_email(params[:username])
      else
        raise Discourse::InvalidParameters
      end
    end

    def load_room
      @room = Resenha::Room.find(params[:room_id])
    end
  end
end
