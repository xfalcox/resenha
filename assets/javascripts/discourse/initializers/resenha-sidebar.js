import noop from "discourse/helpers/noop";
import { avatarUrl } from "discourse/lib/avatar-utils";
import { withPluginApi } from "discourse/lib/plugin-api";
import { i18n } from "discourse-i18n";
import ResenhaParticipantSidebarContextMenu from "discourse/plugins/resenha/discourse/components/resenha-participant-sidebar-context-menu";
import ResenhaRoomSidebarContextMenu from "discourse/plugins/resenha/discourse/components/resenha-room-sidebar-context-menu";
import ResenhaRoomForm from "discourse/plugins/resenha/admin/components/resenha-room-form";

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
      const menuService = owner.lookup("service:menu");
      const capabilities = owner.lookup("service:capabilities");

      api.addSidebarSection((BaseSection, BaseLink) => {
        const RoomsLink = class extends BaseLink {
          constructor({ room, webrtcService, user, menu }) {
            super(...arguments);
            this.room = room;
            this.resenhaWebrtc = webrtcService;
            this.currentUser = user;
            this.menuService = menu;
          }

          get hoverType() {
            return "icon";
          }

          get hoverValue() {
            return capabilities.isIpadOS ? null : "ellipsis-vertical";
          }

          get hoverTitle() {
            return i18n("resenha.room.menu_title");
          }

          get hoverAction() {
            if (capabilities.isIpadOS) {
              return noop;
            }

            return (event, onMenuClose) => {
              event.stopPropagation();
              event.preventDefault();

              const anchor =
                event.target.closest(".sidebar-section-link") || event.target;

              this.menuService.show(anchor, {
                identifier: "resenha-room-menu",
                component: ResenhaRoomSidebarContextMenu,
                placement: "right",
                data: { room: this.room },
                onClose: onMenuClose,
              });
            };
          }

          get name() {
            return `resenha-room-${this.room.id}`;
          }

          get classNames() {
            const classes = ["resenha-sidebar-link"];
            const state = this.resenhaWebrtc.connectionStateFor(this.room.id);

            if (state === "connected") {
              classes.push("sidebar-section-link--active");
            } else if (state === "connecting") {
              classes.push("resenha-sidebar-link--connecting");
            }

            return classes.join(" ");
          }

          get href() {
            return "#";
          }

          get title() {
            const state = this.resenhaWebrtc.connectionStateFor(this.room.id);

            if (state === "connecting") {
              return i18n("resenha.room.connecting");
            }

            if (state === "connected") {
              return i18n("resenha.room.leave");
            }

            return (
              this.room.description_excerpt ||
              this.room.name ||
              i18n("resenha.room.join")
            );
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

          get suffixType() {
            if (
              this.resenhaWebrtc.connectionStateFor(this.room.id) ===
              "connecting"
            ) {
              return "icon";
            }
            return null;
          }

          get suffixValue() {
            if (
              this.resenhaWebrtc.connectionStateFor(this.room.id) ===
              "connecting"
            ) {
              return "spinner";
            }
            return null;
          }

          getParticipantsForSummary() {
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
        };

        const ParticipantLink = class extends BaseLink {
          constructor({
            room,
            participant,
            webrtcService,
            user,
            menu,
            canManageRoom,
          }) {
            super(...arguments);
            this.room = room;
            this.participant = participant;
            this.resenhaWebrtc = webrtcService;
            this.currentUser = user;
            this.menuService = menu;
            this.canManageRoom = canManageRoom;
          }

          get #isCurrentUser() {
            return this.participant.id === this.currentUser?.id;
          }

          get #showMenu() {
            if (capabilities.isIpadOS) {
              return false;
            }
            if (!this.#isCurrentUser) {
              return true;
            }
            return siteSettings.resenha_noise_suppression;
          }

          get hoverType() {
            return this.#showMenu ? "icon" : null;
          }

          get hoverValue() {
            return this.#showMenu ? "ellipsis-vertical" : null;
          }

          get hoverTitle() {
            return i18n("resenha.participant.menu_title");
          }

          get hoverAction() {
            if (!this.#showMenu) {
              return noop;
            }

            return (event, onMenuClose) => {
              event.stopPropagation();
              event.preventDefault();

              const anchor =
                event.target.closest(".sidebar-section-link") || event.target;

              this.menuService.show(anchor, {
                identifier: "resenha-participant-menu",
                component: ResenhaParticipantSidebarContextMenu,
                placement: "right",
                data: {
                  room: this.room,
                  participant: this.participant,
                  canManageRoom: this.canManageRoom,
                  isCurrentUser: this.#isCurrentUser,
                },
                onClose: onMenuClose,
              });
            };
          }

          get name() {
            return `resenha-participant-${this.room.id}-${this.participant.id}`;
          }

          get classNames() {
            const classes = ["resenha-sidebar-participant"];

            if (this.participant.is_speaking) {
              classes.push("resenha-sidebar-participant--speaking");
            }

            if (this.participant.is_muted) {
              classes.push("resenha-sidebar-participant--muted");
            }

            return classes.join(" ");
          }

          get href() {
            return "#";
          }

          get title() {
            return this.participant.name || this.participant.username;
          }

          get text() {
            return this.participant.name || this.participant.username;
          }

          get prefixType() {
            return "image";
          }

          get prefixValue() {
            return avatarUrl(this.participant.avatar_template, "small");
          }
        };

        const RoomsSection = class extends BaseSection {
          name = "resenha-rooms";
          text = i18n("resenha.sidebar.title");
          title = i18n("resenha.sidebar.title");

          get headerActions() {
            if (
              !currentUser.staff &&
              currentUser.trust_level < siteSettings.resenha_allow_trust_level
            ) {
              return [];
            }

            return [
              {
                id: "create-room",
                icon: "plus",
                title: i18n("resenha.sidebar.create"),
                action: () => {
                  const modal = owner.lookup("service:modal");
                  modal.show(ResenhaRoomForm, {
                    model: {
                      room: owner.lookup("service:store").createRecord("resenha-room"),
                      onSave: (room) => {
                        roomsService.handleDirectoryEvent({ type: "created", room });
                        modal.close();
                      },
                    },
                  });
                },
              },
            ];
          }

          constructor() {
            super(...arguments);
            this.resenhaRooms = roomsService;
          }

          get displaySection() {
            return (this.resenhaRooms?.rooms?.length || 0) > 0;
          }

          get links() {
            const result = [];

            for (const room of this.resenhaRooms?.rooms || []) {
              const roomLink = new RoomsLink({
                room,
                webrtcService: resenhaWebrtc,
                user: currentUser,
                menu: menuService,
              });
              result.push(roomLink);

              const canManageRoom = room.can_manage;

              for (const participant of roomLink.getParticipantsForSummary()) {
                result.push(
                  new ParticipantLink({
                    room,
                    participant,
                    webrtcService: resenhaWebrtc,
                    user: currentUser,
                    menu: menuService,
                    canManageRoom,
                  })
                );
              }
            }

            return result;
          }
        };

        return RoomsSection;
      });

      if (sidebarClickHandler) {
        document.removeEventListener("click", sidebarClickHandler);
      }

      sidebarClickHandler = async (event) => {
        const findAnchor = (selector) =>
          event
            .composedPath?.()
            ?.find?.(
              (node) => node instanceof HTMLElement && node.matches?.(selector)
            ) || event.target?.closest?.(selector);

        const participantAnchor = findAnchor(
          ".sidebar-section-link[data-link-name^='resenha-participant-']"
        );

        if (participantAnchor) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        const roomAnchor = findAnchor(
          ".sidebar-section-link[data-link-name^='resenha-room-']"
        );

        if (!roomAnchor) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const linkName = roomAnchor.dataset?.linkName;
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

        const connectionState = resenhaWebrtc.connectionStateFor(room.id);

        if (connectionState === "connecting") {
          return;
        }

        if (connectionState === "connected") {
          resenhaWebrtc.leave(room);
        } else {
          await resenhaWebrtc.join(room);
        }
      };

      document.addEventListener("click", sidebarClickHandler);
    });
  },
};
