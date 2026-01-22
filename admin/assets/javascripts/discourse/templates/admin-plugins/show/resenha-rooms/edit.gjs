import ResenhaRoomForm from "discourse/plugins/resenha/admin/components/resenha-room-form";

export default <template>
  <ResenhaRoomForm
    @room={{@controller.model}}
    @onSave={{@controller.saveRoom}}
  />
</template>
