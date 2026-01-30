import { htmlSafe } from "@ember/template";
import noop from "discourse/helpers/noop";
import { avatarImg } from "discourse/lib/avatar-utils";
import { withPluginApi } from "discourse/lib/plugin-api";
import { escapeExpression, isiPad } from "discourse/lib/utilities";
import { i18n } from "discourse-i18n";
import ResenhaRoomSidebarContextMenu from "discourse/plugins/resenha/discourse/components/resenha-room-sidebar-context-menu";

const LINK_NAME_PREFIX = "resenha-room-";
const MAX_INLINE_AVATARS = 11;
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
            return isiPad() ? null : "ellipsis-vertical";
          }

          get hoverTitle() {
            return i18n("resenha.room.menu_title");
          }

          get hoverAction() {
            if (isiPad()) {
              return noop;
            }

            return (event, onMenuClose) => {
              event.stopPropagation();
              event.preventDefault();

              this.menuService.show(event.target, {
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

            if (
              this.resenhaWebrtc.connectionStateFor(this.room.id) ===
              "connected"
            ) {
              classes.push("sidebar-section-link--active");
            }

            if (this.hasParticipants) {
              classes.push("resenha-sidebar-link--has-participants");
            }

            return classes.join(" ");
          }

          get route() {
            return "discovery";
          }

          get currentWhen() {
            return false;
          }

          get title() {
            const isConnected =
              this.resenhaWebrtc.connectionStateFor(this.room.id) ===
              "connected";

            if (isConnected) {
              return i18n("resenha.room.leave");
            }

            return (
              this.room.description ||
              this.room.name ||
              i18n("resenha.room.join")
            );
          }

          get text() {
            const participants = this.participantsForSummary;

            if (!participants.length) {
              return this.room.name;
            }

            const markup = this.participantsMarkup(participants);

            return markup || this.room.name;
          }

          get prefixType() {
            return "icon";
          }

          get prefixValue() {
            return "microphone-lines";
          }

          get hasParticipants() {
            return this.participantsForSummary.length > 0;
          }

          get participantsForSummary() {
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

          displayName(participant) {
            return participant?.name || participant?.username;
          }

          participantTooltip(participants) {
            return participants
              .map((participant) => this.displayName(participant))
              .filter(Boolean)
              .join(", ");
          }

          participantAvatar(participant) {
            if (!participant?.avatar_template) {
              return "";
            }

            const extraClasses = participant?.is_speaking
              ? "resenha-sidebar-link__avatar resenha-sidebar-link__avatar--speaking"
              : "resenha-sidebar-link__avatar";

            return avatarImg({
              avatarTemplate: participant.avatar_template,
              size: "tiny",
              extraClasses,
              title: this.displayName(participant),
              loading: "lazy",
            });
          }

          participantsMarkup(participants) {
            const inlineParticipants = participants.slice(
              0,
              MAX_INLINE_AVATARS
            );
            const avatarHtml = inlineParticipants
              .map((participant) => this.participantAvatar(participant))
              .join("");

            if (!avatarHtml) {
              return null;
            }

            const remaining = Math.max(
              participants.length - inlineParticipants.length,
              0
            );
            const remainderHtml = remaining
              ? `<span class="resenha-sidebar-link__more">+${remaining}</span>`
              : "";

            const label = escapeExpression(
              this.participantTooltip(participants) || this.room.name
            );
            const labelledAttrs = label
              ? ` aria-label="${label}" title="${label}"`
              : "";

            return htmlSafe(
              `<span class="resenha-sidebar-link__participants"${labelledAttrs}>${avatarHtml}${remainderHtml}</span>`
            );
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
                  menu: menuService,
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
