# Changelog

## 0.1.3

- Support Onesti Nimly / EasyAccess-style locks: keypad events are detected
  from the `last_unlock_source` / `last_unlock_user` / `last_lock_source` /
  `last_lock_user` state fields (including repeated unlocks by the same user
  via lock state transitions) — these locks do not publish `action` events.
- Security: log scrubbing now redacts any key containing pin/password/secret/
  token — this includes the Nimly's `last_used_pin_code` state field (the PIN
  actually used), which could previously reach debug logs.

## 0.1.2

- Diagnostics: with `log_level: debug` the app logs every raw state message
  received for a watched lock (topic + payload) to troubleshoot keypad event
  detection.

## 0.1.1

- Switching to published images

## 0.1.0

- Initial release.
- Auto-discovery of PIN-capable Zigbee2MQTT locks (multiple locks supported).
- Per-lock user lists (slot + name) with encrypted PIN storage
  (AES-256-GCM); PINs are write-only and never displayed or logged.
- Apply a PIN to one or more locks in one action; per-slot status
  (applied/pending/failed) with manual retry.
- Removing a user entry clears the PIN on the lock (vendor-appropriate
  payload, e.g. Danalock `user_status` handling).
- Keypad lock/unlock detection with notifications through HA notify actions
  (configurable target) and a 90-day activity log for all lock events.
- Ingress UI (admin-only panel): Locks, Users, Activity and Settings views.