# frozen_string_literal: true

module Resenha
  module UserExtension
    extend ActiveSupport::Concern

    included do
      has_many :resenha_rooms,
               class_name: "Resenha::Room",
               foreign_key: :creator_id,
               dependent: :destroy
    end
  end
end

::User.include Resenha::UserExtension
