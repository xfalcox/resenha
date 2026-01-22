import ResenhaRoomList from "discourse/plugins/resenha/admin/components/resenha-room-list";

<template>
  <ResenhaRoomList
    @rooms={{@controller.model.content}}
    @onDestroy={{@controller.destroyRoom}}
  />
</template>
