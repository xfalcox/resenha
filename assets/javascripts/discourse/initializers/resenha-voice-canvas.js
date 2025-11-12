import { withPluginApi } from "discourse/lib/plugin-api";
import ResenhaVoiceCanvas from "discourse/plugins/resenha/discourse/components/resenha/voice-canvas";

export default {
  name: "resenha-voice-canvas",

  initialize(owner) {
    withPluginApi((api) => {
      const currentUser = api.getCurrentUser();
      const siteSettings = owner.lookup("service:site-settings");

      if (!currentUser || !siteSettings.resenha_enabled) {
        return;
      }

      api.renderInOutlet("below-site-header", ResenhaVoiceCanvas);
    });
  },
};
