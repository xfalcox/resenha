# frozen_string_literal: true

class CreateResenhaRooms < ActiveRecord::Migration[7.0]
  def change
    create_table :resenha_rooms do |t|
      t.string :name, null: false
      t.string :slug, null: false
      t.text :description
      t.boolean :public, default: false, null: false
      t.integer :max_participants
      t.references :creator, null: false, foreign_key: { to_table: :users }
      t.timestamps
    end

    add_index :resenha_rooms, :slug, unique: true

    create_table :resenha_room_memberships do |t|
      t.references :room, null: false, foreign_key: { to_table: :resenha_rooms }
      t.references :user, null: false, foreign_key: true
      t.integer :role, default: 0, null: false
      t.timestamps
    end

    add_index :resenha_room_memberships, %i[room_id user_id], unique: true,
              name: "idx_resenha_room_memberships_on_room_and_user"
  end
end
