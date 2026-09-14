# Lock Manager

Manage keypad users for your Zigbee2MQTT locks from the Home Assistant sidebar.

## Features

- Auto-detects Zigbee2MQTT locks that support PIN codes; you pick which to manage
- Per-lock user lists (slot number + name), multiple locks managed at once
- PINs are stored **encrypted at rest** and are never shown again after entry,
  never written to logs, and never read back from the lock
- Apply one user's PIN to one or more locks in a single action
- Per-slot apply status (applied / pending / failed) with manual retry
- Keypad lock/unlock events are detected and mapped to user names; recognized
  users trigger a configurable Home Assistant notification. Unlock
  notifications are coalesced with the following (auto-)relock into one
  message: "<user> unlocked <lock>. Locked after N seconds"
- Activity log with timestamps for all lock events (recognized, unknown, manual),
  kept for 90 days

The app talks to the locks directly over MQTT (the same broker Zigbee2MQTT uses)
and calls Home Assistant notify actions through the Supervisor proxy. Zigbee2MQTT's
`expose_pin` option is **not** required — the app is write-only and its database
is the source of truth.

## Requirements

- Home Assistant (HAOS/Supervised)
- Zigbee2MQTT connected to an MQTT broker
- With the Mosquitto broker add-on, broker credentials are discovered
  automatically; otherwise set the MQTT host/user/password in the app options

## Options

| Option | Default | Description |
| --- | --- | --- |
| `log_level` | `info` | Logging verbosity |
| `notifications_enabled` | `true` | Send notifications on keypad events by recognized users |
| `notify_target` | `notify.notify` | Home Assistant notify action to call (e.g. `notify.notify`, `notify.mobile_app_pixel`) |
| `notify_coalesce_seconds` | `15` | After a keypad unlock, wait up to this many seconds for the (auto-)relock and send one combined notification (`<user> unlocked <lock>. Locked after N seconds`); `0` = notify immediately |
| `notify_coalesce_seconds` | `15` | After a keypad unlock, wait up to this many seconds for the (auto-)relock and send one combined notification; `0` = notify immediately |
| `z2m_base_topic` | `zigbee2mqtt` | Zigbee2MQTT base topic (confirmed from `bridge/info` when possible) |
| `mqtt_host` | *(empty)* | Manual MQTT broker host (fallback when auto-discovery is unavailable) |
| `mqtt_port` | `1883` | Manual MQTT broker port |
| `mqtt_user` | *(empty)* | Manual MQTT username |
| `mqtt_password` | *(empty)* | Manual MQTT password |

## Security notes

- The app's panel is visible **only to Home Assistant administrators**.
- PINs are encrypted with AES-256-GCM; the key lives only in the app's `/data`.
- A successful apply means the broker accepted the MQTT write — the lock
  confirms programming through its own keypad event (see the activity log).
  Read-back verification of PIN codes is deliberately out of scope.