# frozen_string_literal: true
Fabricator(:resenha_room, class_name: "Resenha::Room") do
  name { sequence(:resenha_room_name) { |i| "Resenha #{i}" } }
  public { false }
  creator { Fabricate(:user) }
end
