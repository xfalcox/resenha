import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn, hash } from "@ember/helper";
import { action } from "@ember/object";
import DButton from "discourse/components/d-button";
import DModal from "discourse/components/d-modal";
import avatar from "discourse/helpers/avatar";
import icon from "discourse/helpers/d-icon";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import ComboBox from "discourse/select-kit/components/combo-box";
import UserChooser from "discourse/select-kit/components/user-chooser";
import { eq, notEq } from "discourse/truth-helpers";
import { i18n } from "discourse-i18n";

export default class ResenhaRoomInfoModal extends Component {
  @tracked memberships = [];
  @tracked loading = false;
  @tracked selectedUsernames = [];
  @tracked selectedRole = "participant";
  @tracked addingMember = false;

  constructor() {
    super(...arguments);
    if (this.showMembershipManagement) {
      this.loadMemberships();
    }
  }

  get room() {
    return this.args.model.room;
  }

  get showMembershipManagement() {
    return this.room.can_manage && !this.room.public;
  }

  get roleOptions() {
    return [
      {
        id: "participant",
        name: i18n("resenha.room_info.members.participant"),
      },
      { id: "moderator", name: i18n("resenha.room_info.members.moderator") },
    ];
  }

  async loadMemberships() {
    this.loading = true;
    try {
      const result = await ajax(`/resenha/rooms/${this.room.id}/memberships`);
      this.memberships = result.memberships;
    } catch (error) {
      popupAjaxError(error);
    } finally {
      this.loading = false;
    }
  }

  @action
  setSelectedUsernames(usernames) {
    this.selectedUsernames = usernames;
  }

  @action
  setSelectedRole(role) {
    this.selectedRole = role;
  }

  @action
  async addMember() {
    if (!this.selectedUsernames.length) {
      return;
    }

    this.addingMember = true;
    try {
      for (const username of this.selectedUsernames) {
        await ajax(`/resenha/rooms/${this.room.id}/memberships`, {
          type: "POST",
          data: { username, role: this.selectedRole },
        });
      }
      this.selectedUsernames = [];
      this.selectedRole = "participant";
      await this.loadMemberships();
    } catch (error) {
      popupAjaxError(error);
    } finally {
      this.addingMember = false;
    }
  }

  @action
  async updateMemberRole(membership, role) {
    try {
      await ajax(
        `/resenha/rooms/${this.room.id}/memberships/${membership.id}`,
        {
          type: "PUT",
          data: { role },
        }
      );
      await this.loadMemberships();
    } catch (error) {
      popupAjaxError(error);
    }
  }

  @action
  async removeMember(membership) {
    try {
      await ajax(
        `/resenha/rooms/${this.room.id}/memberships/${membership.id}`,
        {
          type: "DELETE",
        }
      );
      await this.loadMemberships();
    } catch (error) {
      popupAjaxError(error);
    }
  }

  <template>
    <DModal @closeModal={{@closeModal}} class="resenha-room-info-modal">
      <:body>
        <div class="resenha-room-info-modal__header">
          <div class="resenha-room-info-modal__icon">
            {{icon "microphone-lines"}}
          </div>
          <div class="resenha-room-info-modal__header-content">
            <h2
              class="resenha-room-info-modal__room-name"
            >{{this.room.name}}</h2>
            {{#if this.room.description}}
              <p
                class="resenha-room-info-modal__description"
              >{{this.room.description}}</p>
            {{/if}}
          </div>
        </div>

        <div class="resenha-room-info-modal__stats">
          <div class="resenha-room-info-modal__stat">
            <span class="resenha-room-info-modal__stat-value">
              {{#if this.room.public}}
                {{icon "globe"}}
              {{else}}
                {{icon "lock"}}
              {{/if}}
            </span>
            <span class="resenha-room-info-modal__stat-label">
              {{if
                this.room.public
                (i18n "resenha.room_info.public")
                (i18n "resenha.room_info.private")
              }}
            </span>
          </div>

          <div class="resenha-room-info-modal__stat">
            <span
              class="resenha-room-info-modal__stat-value"
            >{{this.room.member_count}}</span>
            <span class="resenha-room-info-modal__stat-label">{{i18n
                "resenha.room_info.member_count"
              }}</span>
          </div>

          {{#if this.room.max_participants}}
            <div class="resenha-room-info-modal__stat">
              <span
                class="resenha-room-info-modal__stat-value"
              >{{this.room.max_participants}}</span>
              <span class="resenha-room-info-modal__stat-label">{{i18n
                  "resenha.room_info.max_participants"
                }}</span>
            </div>
          {{/if}}
        </div>

        {{#if this.showMembershipManagement}}
          <div class="resenha-room-info-modal__members">
            <div class="resenha-room-info-modal__section-header">
              {{icon "users"}}
              <h3>{{i18n "resenha.room_info.members.title"}}</h3>
            </div>

            {{#if this.loading}}
              <div class="resenha-room-info-modal__loading">
                <div class="spinner small"></div>
                {{i18n "loading"}}
              </div>
            {{else}}
              <div class="resenha-room-info-modal__member-list">
                {{#each this.memberships as |membership|}}
                  <div
                    class="resenha-room-info-modal__member
                      {{if
                        (eq membership.user_id this.room.creator_id)
                        '--creator'
                      }}"
                  >
                    <div class="resenha-room-info-modal__member-avatar">
                      {{avatar membership.user imageSize="medium"}}
                    </div>
                    <div class="resenha-room-info-modal__member-details">
                      <span
                        class="resenha-room-info-modal__member-username"
                      >{{membership.user.username}}</span>
                      {{#if (eq membership.user_id this.room.creator_id)}}
                        <span
                          class="resenha-room-info-modal__member-role --creator"
                        >
                          {{icon "crown"}}
                          {{i18n "resenha.room_info.members.creator"}}
                        </span>
                      {{else}}
                        <span
                          class="resenha-room-info-modal__member-role --{{membership.role_name}}"
                        >
                          {{membership.role_name}}
                        </span>
                      {{/if}}
                    </div>

                    {{#if (notEq membership.user_id this.room.creator_id)}}
                      <div class="resenha-room-info-modal__member-actions">
                        <ComboBox
                          @content={{this.roleOptions}}
                          @value={{membership.role_name}}
                          @onChange={{fn this.updateMemberRole membership}}
                          @options={{hash none=false}}
                          class="resenha-room-info-modal__role-select"
                        />
                        <DButton
                          @action={{fn this.removeMember membership}}
                          @icon="xmark"
                          @title="resenha.room_info.members.remove"
                          class="btn-flat btn-small resenha-room-info-modal__remove-btn"
                        />
                      </div>
                    {{/if}}
                  </div>
                {{/each}}
              </div>

              <div class="resenha-room-info-modal__add-member">
                <div class="resenha-room-info-modal__add-row">
                  <UserChooser
                    @value={{this.selectedUsernames}}
                    @onChange={{this.setSelectedUsernames}}
                    @options={{hash
                      excludeCurrentUser=false
                      filterPlaceholder="resenha.room_info.members.add_placeholder"
                    }}
                    class="resenha-room-info-modal__user-chooser"
                  />
                  <ComboBox
                    @content={{this.roleOptions}}
                    @value={{this.selectedRole}}
                    @onChange={{this.setSelectedRole}}
                    @options={{hash none=false}}
                    class="resenha-room-info-modal__role-chooser"
                  />
                  <DButton
                    @action={{this.addMember}}
                    @icon="plus"
                    @disabled={{this.addingMember}}
                    @title="resenha.room_info.members.add_button"
                    class="btn-primary resenha-room-info-modal__add-btn"
                  />
                </div>
              </div>
            {{/if}}
          </div>
        {{/if}}
      </:body>
    </DModal>
  </template>
}
