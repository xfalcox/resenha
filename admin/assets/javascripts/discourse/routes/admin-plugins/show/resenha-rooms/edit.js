import { service } from "@ember/service";
import DiscourseRoute from "discourse/routes/discourse";

export default class ResenhaRoomsEditRoute extends DiscourseRoute {
  @service store;

  model(params) {
    return this.store.find("resenha-room", params.id);
  }
}
