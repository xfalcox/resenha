import { withPluginApi } from "discourse/lib/plugin-api";

const PLUGIN_ID = "resenha";

export default {
  name: "resenha-admin-plugin-configuration-nav",

  initialize(container) {
    const currentUser = container.lookup("service:current-user");
    if (!currentUser?.admin) {
      return;
    }

    withPluginApi((api) => {
      api.setAdminPluginIcon(PLUGIN_ID, "microphone-lines");
      api.addAdminPluginConfigurationNav(PLUGIN_ID, [
        {
          label: "resenha.admin.rooms_title",
          route: "adminPlugins.show.resenha-rooms",
        },
      ]);
    });
  },
};
