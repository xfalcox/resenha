import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";
import DButton from "discourse/components/d-button";
import DropdownMenu from "discourse/components/dropdown-menu";
import ResenhaRoomInfoModal from "./modal/resenha-room-info";

export default class ResenhaRoomSidebarContextMenu extends Component {
  @service modal;
  @service resenhaWebrtc;

  get room() {
    return this.args.data.room;
  }

  get isConnected() {
    return this.resenhaWebrtc.connectionStateFor(this.room.id) === "connected";
  }

  @action
  openRoomInfo() {
    this.modal.show(ResenhaRoomInfoModal, { model: { room: this.room } });
    this.args.close();
  }

  @action
  leaveRoom() {
    this.resenhaWebrtc.leave(this.room);
    this.args.close();
  }

  <template>
    <DropdownMenu class="resenha-room-sidebar-context-menu" as |dropdown|>
      <dropdown.item>
        <DButton
          @action={{this.openRoomInfo}}
          @icon="circle-info"
          @label="resenha.room.info"
          @title="resenha.room.info"
          class="resenha-room-sidebar-context-menu__room-info"
        />
      </dropdown.item>
      {{#if this.isConnected}}
        <dropdown.item>
          <DButton
            @action={{this.leaveRoom}}
            @icon="phone-slash"
            @label="resenha.room.leave"
            @title="resenha.room.leave"
            class="resenha-room-sidebar-context-menu__leave-room --danger"
          />
        </dropdown.item>
      {{/if}}
    </DropdownMenu>
  </template>
}
