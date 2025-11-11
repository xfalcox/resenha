import { withPluginApi } from "discourse/lib/plugin-api";
import { i18n } from "discourse-i18n";
import ResenhaParticipantAvatars from "discourse/plugins/resenha/discourse/components/resenha/participant-avatars";

const LINK_NAME_PREFIX = "resenha-room-";
let sidebarClickHandler;

export default {
  name: "resenha-sidebar",
  initialize(owner) {
    withPluginApi((api) => {
      const currentUser = api.getCurrentUser();
      const siteSettings = owner.lookup("service:site-settings");

      if (!currentUser || !siteSettings.resenha_enabled) {
        return;
      }

      const roomsService = owner.lookup("service:resenha-rooms");
      const resenhaWebrtc = owner.lookup("service:resenha-webrtc");

      api.addSidebarSection((BaseSection, BaseLink) => {
        const RoomsLink = class extends BaseLink {
          constructor({ room, webrtcService, user }) {
            super(...arguments);
            this.room = room;
            this.resenhaWebrtc = webrtcService;
            this.currentUser = user;
          }

          get name() {
            return `resenha-room-${this.room.id}`;
          }

          get classNames() {
            const classes = ["resenha-sidebar-link"];

            if (
              this.resenhaWebrtc.connectionStateFor(this.room.id) ===
              "connected"
            ) {
              classes.push("sidebar-section-link--active");
            }

            return classes.join(" ");
          }

          get href() {
            return "#";
          }

          get title() {
            return this.room.description || this.room.name;
          }

          get text() {
            return this.room.name;
          }

          get prefixType() {
            return "icon";
          }

          get prefixValue() {
            return "microphone-lines";
          }

          get contentComponentArgs() {
            const participants = this.room.active_participants || [];

            if (!this.currentUser) {
              return participants;
            }

            if (
              this.resenhaWebrtc.connectionStateFor(this.room.id) !==
              "connected"
            ) {
              return participants;
            }

            if (
              participants.some(
                (participant) => participant?.id === this.currentUser.id
              )
            ) {
              return participants;
            }

            return [
              ...participants,
              {
                id: this.currentUser.id,
                username: this.currentUser.username,
                name: this.currentUser.name,
                avatar_template: this.currentUser.avatar_template,
              },
            ];
          }

          get contentComponent() {
            return ResenhaParticipantAvatars;
          }
        };

        const RoomsSection = class extends BaseSection {
          name = "resenha-rooms";
          text = i18n("resenha.sidebar.title");
          title = i18n("resenha.sidebar.title");

          constructor() {
            super(...arguments);
            this.resenhaRooms = roomsService;
          }

          get displaySection() {
            return (this.resenhaRooms?.rooms?.length || 0) > 0;
          }

          get links() {
            return (this.resenhaRooms?.rooms || []).map(
              (room) =>
                new RoomsLink({
                  room,
                  webrtcService: resenhaWebrtc,
                  user: currentUser,
                })
            );
          }
        };

        return RoomsSection;
      });

      if (sidebarClickHandler) {
        document.removeEventListener("click", sidebarClickHandler);
      }

      sidebarClickHandler = async (event) => {
        const anchor =
          event
            .composedPath?.()
            ?.find?.(
              (node) =>
                node instanceof HTMLElement &&
                node.matches?.(
                  ".sidebar-section-link[data-link-name^='resenha-room-']"
                )
            ) ||
          event.target?.closest?.(
            ".sidebar-section-link[data-link-name^='resenha-room-']"
          );

        if (!anchor) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const linkName = anchor.dataset?.linkName;
        if (!linkName?.startsWith(LINK_NAME_PREFIX)) {
          return;
        }

        const roomId = parseInt(
          linkName.substring(LINK_NAME_PREFIX.length),
          10
        );
        const room = Number.isNaN(roomId)
          ? null
          : roomsService.roomById(roomId);

        if (!room) {
          return;
        }

        if (resenhaWebrtc.connectionStateFor(room.id) === "connected") {
          resenhaWebrtc.leave(room);
        } else {
          await resenhaWebrtc.join(room);
        }
      };

      document.addEventListener("click", sidebarClickHandler);
    });
  },
};
