# frozen_string_literal: true

Resenha::Engine.routes.draw do
  resources :rooms do
    member do
      post :join
      delete :leave
      get :participants
      post :signal
    end

    resources :memberships, controller: "room_memberships", only: %i[index create update destroy]
  end
end
