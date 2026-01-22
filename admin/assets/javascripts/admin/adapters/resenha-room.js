import RestAdapter from "discourse/adapters/rest";

export default class ResenhaRoomAdapter extends RestAdapter {
  jsonMode = true;

  basePath() {
    return "/admin/plugins/resenha/";
  }

  pathFor(store, type, id) {
    return id === undefined
      ? "/admin/plugins/resenha/rooms.json"
      : `/admin/plugins/resenha/rooms/${id}.json`;
  }

  apiNameFor() {
    return "room";
  }
}
