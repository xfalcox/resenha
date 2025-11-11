# frozen_string_literal: true

module Resenha
  class Engine < ::Rails::Engine
    isolate_namespace Resenha
    engine_name PLUGIN_NAME
  end
end
