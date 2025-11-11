# Resenha Voice Rooms

Resenha is an experimental Discourse plugin that adds Discord-style voice rooms powered entirely by WebRTC. Once enabled, staff can curate voice rooms that appear in the Discourse sidebar; users join or leave a room with a single click and establish peer-to-peer audio sessions without any media going through the Discourse server.

> **Status:** early alpha. Expect rough edges and plan to test with small groups before opening to a full community.

## Feature Highlights

- **Sidebar-first UX** – rooms show up under a “Voice rooms” section; clicking a room toggles join/leave without a route change.
- **Watercooler out of the box** – enabling the plugin seeds a default room so communities can try voice immediately.
- **Live presence** – avatars of active participants render directly under each room name, update in real time, and show a green outline whenever a participant is speaking.
- **Room + membership management** – REST endpoints allow trusted users to create/update/delete rooms, adjust membership roles, and control visibility.
- **Pure browser WebRTC** – all signaling happens through Discourse + MessageBus; media stays peer-to-peer so no SFU/MCU infrastructure is required.

## Installation

1. Add the plugin to your app’s `plugins` directory (e.g. via `git clone https://github.com/discourse/resenha.git plugins/resenha`).
2. Rebuild or restart Discourse so the plugin is compiled.
3. Enable the feature via **Admin > Settings > Plugins > resenha enabled**.

Once the site setting flips on, the plugin seeds a default “Watercooler” room and exposes the REST API at `/resenha`.

## Configuration

| Setting | Description |
| --- | --- |
| `resenha_enabled` | Master switch. When true we mount the engine, seed the default room, expose the API, and load the Ember sidebar section. |
| `resenha_allow_trust_level` | Minimum trust level required to create/manage rooms. Defaults to TL2. |
| `resenha_max_rooms_per_user` | Hard cap on how many rooms a single creator can own (default 5). |
| `resenha_participant_ttl_seconds` | Number of seconds participant presence is kept in Redis before expiring (default 15). |

All settings live under **Admin > Settings > Plugins**.

## Using Voice Rooms

1. Visit any Discourse page with the sidebar visible. A **Voice rooms** section appears as soon as at least one room exists.
2. Click a room name to join. The front-end will request microphone access and establish WebRTC peers with the other members.
3. Clicking again leaves the room. We optimistically update presence and speaking state locally while the backend broadcasts authoritative updates through MessageBus.
4. Speaking detection is performed per stream in the browser; avatars get a green outline (and bold username) when RMS levels exceed the threshold.

Rooms are currently “button-only” UI – there is no `/resenha/rooms` page exposed to end users. Moderation and CRUD flows are provided through the REST API or future staff UI.

## REST API Overview

All endpoints are namespaced under `/resenha` and respect the regular CSRF/session requirements.

| Endpoint | Purpose |
| --- | --- |
| `GET /resenha/rooms.json` | List rooms visible to the current user (guards via `Guardian#can_see_resenha_room?`). |
| `POST /resenha/rooms` | Create a room (enforces TL via `resenha_allow_trust_level` and per-user quotas). |
| `PUT /resenha/rooms/:id` | Update name/description/visibility. |
| `DELETE /resenha/rooms/:id` | Delete a room. |
| `POST /resenha/rooms/:id/join` / `DELETE .../leave` | Mark presence and trigger participant broadcasts. |
| `POST /resenha/rooms/:id/signal` | WebRTC signaling relay. Payload must include `recipient_id` plus SDP/candidate data. |
| `GET/POST/PUT/DELETE /resenha/rooms/:room_id/memberships` | Manage room memberships/roles. |

Serializers live under `app/serializers/resenha`, and authorization is handled via `Resenha::GuardianExtension`.

## Architecture Notes

- **Backend:** `Resenha::RoomsController` and `Resenha::RoomMembershipsController` expose CRUD endpoints; `Resenha::ParticipantTracker` keeps Redis-backed presence and broadcasts via `Resenha::RoomBroadcaster` / `Resenha::DirectoryBroadcaster`.
- **Frontend:** Ember services `resenha-rooms` (presence + MessageBus) and `resenha-webrtc` (media, signaling, speaking detection) drive the sidebar component declared in `initializers/resenha-sidebar.js`.
- **Sidebar UI:** `resenha/participant-avatars` component renders real-time participant lists. Speaking state is derived from local audio monitors and MessageBus payloads, giving instant feedback while remaining consistent when authoritative data arrives.

## Development

```bash
# Run Ruby specs for the plugin
bin/rspec plugins/resenha/spec

# Run JavaScript/SCSS lint for plugin files
bin/lint plugins/resenha
```

Helpful entry points:

- `app/controllers/resenha/rooms_controller.rb` – room CRUD + WebRTC signaling relay.
- `app/services/resenha` – participant tracker, message bus broadcasters, default room seeder.
- `assets/javascripts/discourse/app/services/resenha-rooms.js` – client-side presence store.
- `assets/javascripts/discourse/app/services/resenha-webrtc.js` – WebRTC/session orchestration.

Please run the linters before opening a PR and remember the plugin relies on modern browsers that ship WebRTC + Web Audio APIs.

## Known Limitations / Future Work

- No UI yet for staff to manage rooms/memberships—interact with the REST API or add custom admin screens.
- Pure peer-to-peer topology; large rooms may hit browser/network limits. Introducing TURN/SFU support is on the roadmap.
- No call recording, moderation tools, or spam controls beyond existing trust-level gating.

Contributions are welcome! Open an issue or PR with your proposed change so we can keep iterating on the Resenha voice experience.
