# frozen_string_literal: true

Resenha::Engine.routes.draw do
  resources :rooms do
    member do
      post :join
      delete :leave
      get :participants
      post :signal
      delete :kick
    end

    resources :memberships, controller: "room_memberships", only: %i[index create update destroy]
  end
end

Discourse::Application.routes.draw do
  scope "/admin/plugins/resenha", constraints: AdminConstraint.new do
    scope format: false do
      get "/resenha-rooms" => "resenha/admin#index"
      get "/resenha-rooms/new" => "resenha/admin#new"
      get "/resenha-rooms/:id" => "resenha/admin#edit"
    end

    scope format: :json do
      get "/rooms" => "resenha/admin_rooms#index"
      get "/rooms/:id" => "resenha/admin_rooms#show"
      post "/rooms" => "resenha/admin_rooms#create"
      put "/rooms/:id" => "resenha/admin_rooms#update"
      delete "/rooms/:id" => "resenha/admin_rooms#destroy"
    end
  end
end
