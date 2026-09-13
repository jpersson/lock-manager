# Facts — Lock User Manager (HA app, Zigbee2MQTT)

- The project delivers a Home Assistant app (add-on) that installs on HAOS/Supervised by adding the GitHub repository URL in HA's App Store; multi-arch images (amd64 + aarch64) are built and published to GHCR via GitHub Actions.
- The app is implemented in Node.js + TypeScript and runs in a Docker container managed by the HA Supervisor.
- The app's management UI is served through HA Ingress and appears in the HA sidebar, visible only to HA administrators.
- The app connects to the MQTT broker used by Zigbee2MQTT: connection details are auto-discovered via Supervisor's MQTT service when the Mosquitto add-on is installed, with manual host/credentials as fallback in the app options.
- The app auto-detects Zigbee2MQTT locks that support PIN codes (lock devices exposing pin_code) and the user selects which of them to manage.
- The app manages multiple locks at the same time, each with its own user list.
- A user entry is a slot number plus a name, managed per lock.
- PINs are stored encrypted at rest (encryption key kept in /data). After entry a PIN is never displayed again; leaving the PIN field empty when editing keeps the existing PIN; PINs are never written to logs or debug output.
- Setting a user's PIN publishes the pin_code set payload to the Zigbee2MQTT set topic of one or more selected locks; the same stored PIN can be applied to the same slot on multiple locks in one action.
- Removing a user entry (or clearing their PIN) sends the lock-appropriate clear payload and removes the entry from the app.
- The app never reads PIN codes back from the lock; the app database is the source of truth and Zigbee2MQTT's expose_pin option is not required.
- Each user slot shows its apply status (applied / not applied / failed) based on the last MQTT write result; a failed write shows an error and is retried manually.
- The app subscribes to the Z2M state topics of managed locks and detects keypad lock/unlock events, mapping the reported user slot (action_user) to the user's name from the app database.
- When a recognized user locks or unlocks via keypad, the app calls a configurable HA notify action (default notify.notify) with a message that includes the lock name, the user's name, and the action performed.
- All detected lock events (recognized users and unknown/manual operations) are recorded in an in-app activity log with timestamps, kept for 90 days.
- The app talks to HA Core only through the Supervisor proxy (no long-lived access tokens); MQTT is used for all lock I/O.
- v1 explicitly excludes: date/time access schedules, global users shared across locks, automatic retry queues, per-user notification routing, and read-back verification of PIN codes.