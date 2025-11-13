# Resenha Plugin Architecture

Resenha adds lightweight WebRTC voice rooms to Discourse without proxying audio/video through the server. It consists of the following layers:

## Backend

- **Models**
  - `Resenha::Room`: describes each voice space and keeps ownership, slug, visibility, and capacity metadata. Creator is automatically promoted to room moderator.
  - `Resenha::RoomMembership`: links users to rooms while storing participant/moderator roles.
- **Services**
  - `Resenha::ParticipantTracker`: stores the list of actively connected users per room in Redis with a short TTL. Join/leave actions refresh MessageBus subscribers.
  - `Resenha::RoomBroadcaster`: emits participant snapshots to `/resenha/rooms/:id` MessageBus channels so Ember clients can update sidebars in real time.
  - `Resenha::DirectoryBroadcaster`: keeps the sidebar list in sync across clients by broadcasting CRUD events to `/resenha/rooms/index`.
  - `Resenha::SignalRelay`: relays raw WebRTC SDP/ICE payloads between peers via MessageBus without touching media data.
- **Controllers**
  - `RoomsController` exposes CRUD, join/leave, participant, and signaling endpoints.
  - `RoomMembershipsController` lets moderators manage explicit memberships.
- **Authorization**
  - Guardian extensions gate room visibility, membership, and management. Site settings define who can create/manage rooms and cap per-user ownership tallies.

## Frontend

- **Services**
  - `resenha-rooms`: fetches initial room data, subscribes to MessageBus channels, updates tracked sidebar state, and forwards participant events to the UI.
  - `resenha-webrtc`: manages `navigator.mediaDevices` capture, maintains one `RTCPeerConnection` per peer, exchanges offers/answers/candidates through the `signal` endpoint, and keeps remote audio elements synced.
- **Sidebar Integration**
  - `resenha-sidebar` initializer registers a sidebar section with custom links for each room. Each link swaps its label with inline avatar thumbnails (plus a counter) so active participants are visible without modifying core sidebar components.
- **Room UI**
  - `resenha-room` route/controller fetch full room metadata, render participant lists, and command the WebRTC service to join/leave rooms. `Resenha::VoiceCanvas` mounts `<audio>` sinks for local and remote streams during active calls.

## Message Flow

1. User joins a room → `POST /resenha/rooms/:id/join` adds them to Redis and broadcasts participants list.
2. Each participant receiving the broadcast spins up `RTCPeerConnection` objects (only lower user IDs send offers to avoid glare) and relays SDP/ICE payloads via `POST /resenha/rooms/:id/signal`.
3. Audio flows directly peer-to-peer; Discourse only transports JSON signaling events.
4. Sidebar avatars and the room screen update automatically as MessageBus notifications arrive.
