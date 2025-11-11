import Component from "@glimmer/component";
import avatar from "discourse/helpers/avatar";
import concatClass from "discourse/helpers/concat-class";

export default class ResenhaParticipantAvatars extends Component {
  get participants() {
    return this.args.status || [];
  }

  displayName(participant) {
    return participant?.name || participant?.username;
  }

  <template>
    {{#if this.participants.length}}
      <span class="resenha-participant-avatars" role="list">
        {{#each this.participants as |participant|}}
          <span
            class={{concatClass
              "resenha-participant-avatars__entry"
              (if
                participant.is_speaking
                "resenha-participant-avatars__entry--speaking"
              )
            }}
            role="listitem"
            data-user-card={{participant.username}}
          >
            {{avatar participant imageSize="extra_small"}}

            <span class="resenha-participant-avatars__username">
              {{this.displayName participant}}
            </span>
          </span>
        {{/each}}
      </span>
    {{/if}}
  </template>
}
