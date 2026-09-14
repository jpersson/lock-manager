# lock-manager

A Home Assistant app (add-on) that manages keypad users for Zigbee2MQTT locks:
per-lock user lists, encrypted PIN storage, one-action PIN applies to one or
more locks, and notifications plus an activity log for keypad events.

## Features

- **Auto-discovery** of Zigbee2MQTT locks that support PIN codes — you pick
  which to manage; multiple locks are supported at once
- **Per-lock user lists**: each user is a slot number plus a name (slots are
  used exactly as Zigbee2MQTT numbers them — no renumbering)
- **Encrypted PIN storage**: PINs are encrypted at rest (AES-256-GCM, key only
  in the app's `/data`), never shown again after entry, never written to logs
- **One action, many locks**: apply a user's PIN to the same slot on one or
  more locks in a single action
- **Apply status tracking**: each slot shows applied / pending / failed based
  on the last MQTT write; failures show the error and can be retried manually
- **Keypad event detection**: lock/unlock events from the keypad are mapped to
  user names; recognized users trigger a configurable Home Assistant
  notification (e.g. `notify.notify`, `notify.mobile_app_pixel`)
- **Activity log**: all lock events (recognized, unknown, manual) with
  timestamps, kept for 90 days

## Install

1. In Home Assistant: **Settings → Apps → App Store → ⋮ → Repositories**, add
   `https://github.com/jpersson/lock-manager`.
2. Install **Lock Manager** from the store. The image is built locally on your
   HAOS/Supervised machine (no pre-built registry images yet — see
   [Publishing](#publishing-planned) below).
3. Start the app; **Lock Manager** appears in the sidebar (visible to
   administrators only).
4. Make sure Zigbee2MQTT is connected to an MQTT broker. With the official
   Mosquitto broker add-on, connection details are discovered automatically.
   Otherwise set the broker host/user/password in the app options.

### Requirements

- Home Assistant OS or Supervised
- Zigbee2MQTT (1.x) connected to an MQTT broker
- Zigbee locks that support PIN codes (devices exposing `pin_code` in
  Zigbee2MQTT, e.g. Kwikset/Weiser SmartCode, Danalock V3, Datek/ID Lock,
  ShinaSystem DLM-300Z)

## App options

| Option | Default | Description |
| --- | --- | --- |
| `log_level` | `info` | `trace` / `debug` / `info` / `warning` / `error` |
| `notifications_enabled` | `true` | Notify when a recognized user locks/unlocks via keypad |
| `notify_target` | `notify.notify` | HA notify action to call (`domain.service` form) |
| `z2m_base_topic` | `zigbee2mqtt` | Zigbee2MQTT base topic; the actual value is confirmed from `bridge/info` and adopted automatically if it differs |
| `mqtt_host` | *(empty)* | Manual broker host — fallback when auto-discovery is unavailable |
| `mqtt_port` | `1883` | Manual broker port |
| `mqtt_user` | *(empty)* | Manual broker username |
| `mqtt_password` | *(empty)* | Manual broker password |

The notification target and toggle can also be overridden in the app's
**Settings** tab; the add-on options act as defaults.

## How it works

```
        ┌────────────┐   bridge/info, bridge/devices   ┌───────────────┐
        │ Mosquitto  │ ───────────────────────────────▶ │               │
        │ (MQTT)     │ ◀─────────────────────────────── │  Lock Manager │
        └─────┬──────┘   <friendly_name>/set (PINs,     │   (Ingress UI │
              │            QoS 1) + state topics       │    + API)     │
              │                                       └───────┬───────┘
        Zigbee2MQTT ── Zigbee network ── Locks                  │ Supervisor proxy
                                                      ┌─────────▼─────────┐
                                                      │  Home Assistant    │
                                                      │  notify.* actions │
                                                      └───────────────────┘
```

- All lock I/O goes directly over MQTT (QoS 1): PIN writes to
  `<base>/<friendly_name>/set`, keypad events from `<base>/<friendly_name>`.
- Broker connection details come from the Supervisor's MQTT service
  (Mosquitto) with manual options as fallback.
- Notifications call HA notify actions through the Supervisor's authenticated
  proxy — no long-lived tokens.
- State (locks, users, activity log, settings) lives in `/data/store.json`;
  PINs inside it are AES-256-GCM encrypted with `/data/secret.key`.

### Security notes

- The sidebar panel is visible **only to Home Assistant administrators**
  (`panel_admin` in the app manifest).
- PINs are encrypted at rest and never displayed again; leaving the PIN field
  empty when editing keeps the existing PIN. PINs are scrubbed from all log
  output.
- The app is **write-only**: it never reads PIN codes back from locks, so
  Zigbee2MQTT's `expose_pin` option is **not** required, and the app's
  database is the source of truth.
- The app talks to Home Assistant Core only through the Supervisor proxy; no
  ports are exposed to the network.

### Known limitations

- **Apply status is optimistic**: a successful apply means the MQTT broker
  accepted the write, not that the lock physically confirmed the PIN. Check
  the lock's keypad event in the activity log. Read-back verification (which
  would require `expose_pin`) is deliberately out of scope.
- Removing a user entry always sends a clear command for that slot to the
  lock — including slots that may have been programmed by other tools.
- No access schedules, no global users across locks, no automatic retry
  queues, no per-user notification routing (v1 scope decisions).

## Publishing (planned)

Today the Supervisor builds the image locally from this repository. When
registry publishing is wired up, `config.yaml` gains
`image: ghcr.io/jpersson/lock-manager-{arch}` with multi-arch images built by
GitHub Actions (amd64 + aarch64). The `image:` line is intentionally omitted
until then.

## Development

```bash
cd lock-manager/app
npm install
npm run lint        # eslint
npm run typecheck   # tsc for server + web
npm test            # vitest suites (100+ tests)
npm run build       # tsc -> dist/ + vite -> dist-web/

# Run locally (needs an MQTT broker):
LM_MQTT_HOST=host.docker.internal LM_MQTT_PORT=1883 npm run build
node dist/server.js   # serves on :8099

# Add-on lint + image build:
./tools/lint-addon.sh
cd lock-manager && docker build \
  --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=0.1.0 -t lock-manager .
```

Goal/plan documents for this project live in [`goals/lock-user-manager/`](goals/lock-user-manager/goal.md).