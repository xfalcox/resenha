# Resenha

A proof of concept voice chat theme-component for Discourse.

### How it works

It uses https://github.com/gfodor/p2pcf for WebRTC signaling, and Discourse Sidebar API for UI.

### TODO

[ ] Add DiscoursePresence to show current participants avatars in the sidebar
[ ] Add basic UI (mute, leave)
[ ] Move from p2pcf to Rails Controller / MessageBus for signaling the SimplePeer WebRTC connection setup. Will need to be moved from TC to plugin.
