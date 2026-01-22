import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { LinkTo } from "@ember/routing";
import { service } from "@ember/service";
import AdminConfigAreaEmptyList from "discourse/admin/components/admin-config-area-empty-list";
import DButton from "discourse/components/d-button";
import DPageSubheader from "discourse/components/d-page-subheader";
import avatar from "discourse/helpers/avatar";
import formatDate from "discourse/helpers/format-date";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { escapeExpression } from "discourse/lib/utilities";
import { i18n } from "discourse-i18n";

export default class ResenhaRoomList extends Component {
  @service dialog;

  @action
  async destroyRoom(room) {
    room.set("isDeleting", true);
    try {
      await this.dialog.deleteConfirm({
        message: i18n("resenha.admin.destroy_room.confirm", {
          name: escapeExpression(room.name),
        }),
        didConfirm: async () => {
          try {
            await room.destroyRecord();
            this.args.onDestroy?.(room);
          } catch (e) {
            popupAjaxError(e);
          }
        },
      });
    } finally {
      room?.set("isDeleting", false);
    }
  }

  <template>
    <section class="resenha-rooms-table">
      <DPageSubheader @titleLabel={{i18n "resenha.admin.rooms_title"}}>
        <:actions as |actions|>
          <actions.Primary
            @label="resenha.admin.create_room"
            @route="adminPlugins.show.resenha-rooms.new"
            @icon="plus"
            class="resenha-admin__create-btn"
          />
        </:actions>
      </DPageSubheader>

      {{#if @rooms.length}}
        <table class="d-admin-table resenha-rooms">
          <thead>
            <tr>
              <th>{{i18n "resenha.admin.room.name"}}</th>
              <th>{{i18n "resenha.admin.room.public"}}</th>
              <th>{{i18n "resenha.admin.room.max_participants"}}</th>
              <th>{{i18n "resenha.admin.room.member_count"}}</th>
              <th>{{i18n "resenha.admin.room.creator"}}</th>
              <th>{{i18n "resenha.admin.room.created_at"}}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {{#each @rooms as |room|}}
              <tr class="d-admin-row__content">
                <td class="d-admin-row__overview resenha-rooms__name">
                  {{room.name}}
                </td>
                <td class="d-admin-row__detail resenha-rooms__public">
                  <div class="d-admin-row__mobile-label">
                    {{i18n "resenha.admin.room.public"}}
                  </div>
                  {{#if room.public}}
                    {{i18n "yes_value"}}
                  {{else}}
                    {{i18n "no_value"}}
                  {{/if}}
                </td>
                <td class="d-admin-row__detail resenha-rooms__max-participants">
                  <div class="d-admin-row__mobile-label">
                    {{i18n "resenha.admin.room.max_participants"}}
                  </div>
                  {{#if room.max_participants}}
                    {{room.max_participants}}
                  {{else}}
                    -
                  {{/if}}
                </td>
                <td class="d-admin-row__detail resenha-rooms__member-count">
                  <div class="d-admin-row__mobile-label">
                    {{i18n "resenha.admin.room.member_count"}}
                  </div>
                  {{room.member_count}}
                </td>
                <td class="d-admin-row__detail resenha-rooms__creator">
                  <div class="d-admin-row__mobile-label">
                    {{i18n "resenha.admin.room.creator"}}
                  </div>
                  {{#if room.creator}}
                    <a
                      href={{room.creator.userPath}}
                      data-user-card={{room.creator.username}}
                    >
                      {{avatar room.creator imageSize="small"}}
                    </a>
                  {{/if}}
                </td>
                <td class="d-admin-row__detail resenha-rooms__created-at">
                  <div class="d-admin-row__mobile-label">
                    {{i18n "resenha.admin.room.created_at"}}
                  </div>
                  {{formatDate room.created_at leaveAgo="true"}}
                </td>
                <td class="d-admin-row__controls resenha-rooms__controls">
                  <LinkTo
                    @route="adminPlugins.show.resenha-rooms.edit"
                    @model={{room.id}}
                    class="btn btn-default btn-text btn-small"
                  >
                    {{i18n "resenha.admin.edit"}}
                  </LinkTo>

                  <DButton
                    @icon="trash-can"
                    @disabled={{room.isDeleting}}
                    {{on "click" (fn this.destroyRoom room)}}
                    class="btn-small btn-danger resenha-rooms__delete"
                  />
                </td>
              </tr>
            {{/each}}
          </tbody>
        </table>
      {{else}}
        <AdminConfigAreaEmptyList
          @ctaLabel="resenha.admin.create_room"
          @ctaRoute="adminPlugins.show.resenha-rooms.new"
          @ctaClass="resenha-admin__create-btn"
          @emptyLabel="resenha.admin.no_rooms_yet"
        />
      {{/if}}
    </section>
  </template>
}
