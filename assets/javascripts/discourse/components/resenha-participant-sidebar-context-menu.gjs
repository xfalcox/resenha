import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";
import DButton from "discourse/components/d-button";
import DropdownMenu from "discourse/components/dropdown-menu";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { i18n } from "discourse-i18n";

export default class ResenhaParticipantSidebarContextMenu extends Component {
  @service resenhaWebrtc;

  @tracked volume = 100;
  @tracked isMuted = false;

  constructor() {
    super(...arguments);
    const { room, participant } = this.args.data;
    this.volume = Math.round(
      this.resenhaWebrtc.getParticipantVolume(room.id, participant.id) * 100
    );
    this.isMuted = this.resenhaWebrtc.isParticipantMuted(
      room.id,
      participant.id
    );
  }

  get room() {
    return this.args.data.room;
  }

  get participant() {
    return this.args.data.participant;
  }

  get canManageRoom() {
    return this.args.data.canManageRoom;
  }

  get canKick() {
    return this.canManageRoom && this.participant.id !== this.room.creator_id;
  }

  get muteLabel() {
    return this.isMuted
      ? i18n("resenha.participant.unmute")
      : i18n("resenha.participant.mute");
  }

  get muteIcon() {
    return this.isMuted ? "volume-xmark" : "volume-high";
  }

  @action
  onVolumeChange(event) {
    this.volume = parseInt(event.target.value, 10);
    this.resenhaWebrtc.setParticipantVolume(
      this.room.id,
      this.participant.id,
      this.volume / 100
    );
  }

  @action
  toggleMute() {
    this.isMuted = this.resenhaWebrtc.toggleParticipantMute(
      this.room.id,
      this.participant.id
    );
  }

  @action
  async kick() {
    try {
      await ajax(`/resenha/rooms/${this.room.id}/kick`, {
        type: "DELETE",
        data: { user_id: this.participant.id },
      });
      this.args.close();
    } catch (error) {
      popupAjaxError(error);
    }
  }

  <template>
    <DropdownMenu
      class="resenha-participant-sidebar-context-menu"
      as |dropdown|
    >
      <dropdown.item class="resenha-participant-sidebar-context-menu__volume">
        <label class="resenha-participant-sidebar-context-menu__volume-label">
          {{i18n "resenha.participant.volume"}}
        </label>
        <input
          type="range"
          min="0"
          max="100"
          value={{this.volume}}
          class="resenha-participant-sidebar-context-menu__volume-slider"
          {{on "input" this.onVolumeChange}}
        />
      </dropdown.item>
      <dropdown.item>
        <DButton
          @action={{this.toggleMute}}
          @icon={{this.muteIcon}}
          @translatedLabel={{this.muteLabel}}
          @translatedTitle={{this.muteLabel}}
          class="resenha-participant-sidebar-context-menu__mute-btn"
        />
      </dropdown.item>
      {{#if this.canKick}}
        <dropdown.item>
          <DButton
            @action={{this.kick}}
            @icon="right-from-bracket"
            @label="resenha.participant.kick"
            @title="resenha.participant.kick"
            class="resenha-participant-sidebar-context-menu__kick-btn btn-danger"
          />
        </dropdown.item>
      {{/if}}
    </DropdownMenu>
  </template>
}
