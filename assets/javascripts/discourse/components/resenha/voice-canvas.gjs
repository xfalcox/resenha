import Component from "@glimmer/component";
import { service } from "@ember/service";
import { fn } from "@ember/helper";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";

export default class ResenhaVoiceCanvas extends Component {
  @service resenhaWebrtc;

  get localStream() {
    return this.resenhaWebrtc.localStream;
  }

  get remoteStreams() {
    return this.resenhaWebrtc.remoteStreamsFor(this.args.room?.id);
  }

  <template>
    <section class="resenha-voice-canvas">
      {{#if this.localStream}}
        <audio
          {{didInsert (fn this.resenhaWebrtc.attachStream this.localStream)}}
          autoplay
          muted
        />
      {{/if}}

      {{#each this.remoteStreams as |stream|}}
        <audio
          {{didInsert (fn this.resenhaWebrtc.attachStream stream)}}
          autoplay
        />
      {{/each}}
    </section>
  </template>
}
