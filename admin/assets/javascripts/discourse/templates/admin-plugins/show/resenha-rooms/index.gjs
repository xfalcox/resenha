import ResenhaRoomList from "discourse/plugins/resenha/admin/components/resenha-room-list";

export default <template>
  <ResenhaRoomList
    @rooms={{@controller.model.content}}
    @onDestroy={{@controller.destroyRoom}}
  />
</template>
