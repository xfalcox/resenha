import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import BackButton from "discourse/components/back-button";
import Form from "discourse/components/form";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { i18n } from "discourse-i18n";

export default class ResenhaRoomForm extends Component {
  @tracked isSaving = false;

  get formData() {
    return {
      name: this.args.room?.name || "",
      description: this.args.room?.description || "",
      public: this.args.room?.public ?? false,
      max_participants: this.args.room?.max_participants || null,
    };
  }

  get submitLabel() {
    return this.args.room?.id ? "resenha.admin.update" : "resenha.admin.create";
  }

  @action
  async handleSubmit(data) {
    this.isSaving = true;

    try {
      const room = this.args.room;
      room.setProperties(data);
      await room.save();
      this.args.onSave?.(room);
    } catch (e) {
      popupAjaxError(e);
    } finally {
      this.isSaving = false;
    }
  }

  <template>
    <div class="admin-detail resenha-room-form">
      <BackButton
        @label="resenha.admin.back"
        @route="adminPlugins.show.resenha-rooms.index"
        class="resenha-admin-back"
      />

      <Form
        @data={{this.formData}}
        @onSubmit={{this.handleSubmit}}
        class="resenha-room-form__form"
        as |form|
      >
        <form.Field
          @name="name"
          @title={{i18n "resenha.admin.room.name"}}
          @validation="required|length:1,80"
          as |field|
        >
          <field.Input
            placeholder={{i18n "resenha.admin.room.name_placeholder"}}
          />
        </form.Field>

        <form.Field
          @name="description"
          @title={{i18n "resenha.admin.room.description"}}
          as |field|
        >
          <field.Textarea />
        </form.Field>

        <form.Field
          @name="public"
          @title={{i18n "resenha.admin.room.public"}}
          @helpText={{i18n "resenha.admin.room.public_help"}}
          as |field|
        >
          <field.Toggle />
        </form.Field>

        <form.Field
          @name="max_participants"
          @title={{i18n "resenha.admin.room.max_participants"}}
          @description={{i18n "resenha.admin.room.max_participants_help"}}
          @validation="integer|number:2,50"
          as |field|
        >
          <field.Input @type="number" />
        </form.Field>

        <form.Submit
          @label={{this.submitLabel}}
          @disabled={{this.isSaving}}
          class="resenha-room-form__submit"
        />
      </Form>
    </div>
  </template>
}
