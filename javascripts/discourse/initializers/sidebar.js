import { withPluginApi } from "discourse/lib/plugin-api";
import { bind } from "discourse-common/utils/decorators";
import { getOwner } from "discourse-common/lib/get-owner";

export default {
  name: "resenha-sidebar",
  initialize(container) {
    withPluginApi("1.3.0", (api) => {
      const currentUser = getOwner(this).lookup("service:current-user");
      // const presence = container.lookup("service:presence");
      // var presenceChannel = presence.getChannel(
      //   `discourse-presence/resenha/${this.text}`
      // );

      api.addSidebarSection(
        (BaseCustomSidebarSection, BaseCustomSidebarSectionLink) => {
          return class extends BaseCustomSidebarSection {
            get name() {
              return "test-resenha-channels";
            }

            get route() {
              return "discovery.latest";
            }

            get title() {
              return "chat channels title";
            }

            get text() {
              return "Voice Channels";
            }

            get actionsIcon() {
              return "cog";
            }

            get actions() {
              return [
                {
                  id: "browseChannels",
                  title: "Manage channels",
                  action: () => {},
                },
                {
                  id: "settings",
                  title: "Audio Settings",
                  action: () => {},
                },
              ];
            }

            @bind
            willDestroy() {
              sectionDestroy = "section test";
            }

            get links() {
              return [
                new (class extends BaseCustomSidebarSectionLink {
                  get name() {
                    return "dev-channel";
                  }

                  get route() {
                    return "discovery.latest";
                  }

                  get title() {
                    return "dev channel title";
                  }

                  get text() {
                    return "Watercooler";
                  }

                  get prefixColor() {
                    return "alert";
                  }

                  get prefixType() {
                    return "text";
                  }

                  get prefixValue() {
                    return "🎤";
                  }

                  get hoverType() {
                    return "icon";
                  }

                  get hoverValue() {
                    return "plus";
                  }

                  get hoverAction() {
                    return async () => {
                      const p2pcfLibrary = settings.theme_uploads_local.p2pcf;
                      const p2pcf = await import(p2pcfLibrary);
                      let instance = new p2pcf.default(
                        currentUser.username,
                        this.text
                      );

                      instance.start();

                      //presenceChannel.enter();
                      //presenceChannel.subscribe();

                      let stream = await navigator.mediaDevices.getUserMedia({
                        audio: true,
                      });

                      for (const peer of instance.peers.values()) {
                        peer.addStream(stream);
                      }

                      instance.on("peerconnect", (peer) => {
                        console.log("Peer connect", peer.id, peer);
                        if (stream) {
                          peer.addStream(stream);
                        }

                        peer.on("track", (track, stream) => {
                          console.log("got track", track);
                          const audio = document.createElement("audio");
                          audio.id = `${peer.id}-audio`;
                          audio.srcObject = stream;
                          audio.setAttribute("playsinline", true);
                          document.body.appendChild(audio);
                          audio.play();
                        });
                      });

                      instance.on("peerclose", (peer) => {
                        console.log("Peer close", peer.id, peer);
                        document.getElementById(`${peer.id}-audio`)?.remove();
                      });
                    };
                  }

                  get hoverTitle() {
                    return "Click to join this voice chat";
                  }
                })(),
              ];
            }
          };
        }
      );
    });
  },
};
