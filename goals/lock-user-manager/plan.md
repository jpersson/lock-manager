# Plan — Lock User Manager (HA app, Zigbee2MQTT)

Goal repo: `lock-manager` (currently empty except README and this goal package). Full fact list: `goals/lock-user-manager/facts.md`.

## Solution approach

A single Node.js 22 + TypeScript app packaged as a Home Assistant app (add-on) in the standard two-level repository layout: repo root carries `repository.yaml` for the App Store, and `lock-manager/` contains the app manifest (`config.yaml`), `Dockerfile`, `build.yaml`, and the app source. The app serves an admin-only Ingress UI (React + Vite SPA behind Fastify), talks MQTT directly for all Zigbee2MQTT lock I/O (discovery, PIN writes, keypad events), and calls HA notify actions through the Supervisor's authenticated proxy. State (locks, per-lock users, activity log, settings) lives in `/data/store.json`; PINs are encrypted with AES-256-GCM using a key file in `/data`. The design is deliberately **write-only**: the app never reads PIN codes back from locks, so Zigbee2MQTT's `expose_pin` option is not needed.

Key external interfaces:

- **MQTT (MQTT.js, QoS 1)**: `zigbee2mqtt/bridge/info` (base topic, configurable in Z2M), `zigbee2mqtt/bridge/devices` (retained; find devices whose `exposes` contain a `lock` with a `pin_code` composite), `zigbee2mqtt/<base>/<friendly_name>/set` with `{"pin_code":{"user":N,"user_enabled":true,"pin_code":"..."}}` (set) and `pin_code: null` + `user_enabled: false` (clear), and `zigbee2mqtt/<base>/<friendly_name>` (state: `action`, `action_source_name`, `action_user`, `lock_state`).
- **Supervisor API** (`SUPERVISOR_TOKEN`, `http://supervisor`): `GET /services/mqtt` for broker credentials (requires `services: ["mqtt:want"]` + Mosquitto add-on), and `POST /core/api/services/<notify target>` for notifications (requires `homeassistant_api: true`).
- **Options**: `/data/options.json` (written by Supervisor) — `log_level`, manual MQTT override fields, `notify_target`.

Target repository layout:

```
lock-manager/
├── repository.yaml, README.md
├── .github/workflows/ci.yml
└── lock-manager/                  # the app
    ├── config.yaml, build.yaml, Dockerfile
    └── app/
        ├── package.json, tsconfig.json, vitest.config.ts
        ├── src/                   # Fastify server, options loader, logger w/ redaction
        │   ├── store/             # store.ts (atomic JSON), crypto.ts (AES-256-GCM)
        │   ├── mqtt/              # client.ts, discovery.ts, lockDriver.ts, events.ts
        │   ├── ha/                # supervisor.ts (MQTT discovery + notify action client)
        │   ├── domain/            # users, locks, applyPin, activity log, notify pipeline
        │   ├── http/              # API routes
        │   └── web/               # React + Vite SPA (build output served by Fastify)
        └── test/                  # vitest unit + integration tests, Z2M payload fixtures
```

## Ordered steps

1. **Scaffold the app repository layout** — `repository.yaml`, `lock-manager/config.yaml` (slug `lock_manager`, `ingress: true`, `panel_admin: true`, `panel_title: Lock Manager`, `panel_icon: mdi:lock-check`, `startup: services`, `boot: auto`, `arch: [aarch64, amd64]`, `services: ["mqtt:want"]`, `homeassistant_api: true`, no host ports, options + schema for `log_level`/MQTT override/`notify_target`, `image: ghcr.io/<owner>/lock-manager-{arch}`), `build.yaml`, multi-stage `Dockerfile` (build TS+SPA in `node:22-alpine`, ship runtime only).
   Verify: `docker run --rm -v $PWD/lock-manager:/data frenck/addon-linter` (config/repository validation), `docker build` succeeds.

2. **App skeleton** — `src/server.ts` (Fastify binding `process.env.PORT` for Ingress), options loader (`/data/options.json` with env fallback for dev), structured logger with a redaction helper, `/health` endpoint, static serving of the SPA build with relative paths only (Ingress-safe).
   Verify: `npm run test` (skeleton vitest), `npm run build`, `docker build && docker run` locally → `GET /health` returns ok.

3. **Store + PIN crypto** — `store.ts` (typed state, atomic write via tmp+rename, debounced flush; state: managed locks, per-lock users `{slot, name, pinEnc, pinSet, status: applied|pending|failed, lastAppliedAt, lastError}`, activity log ring, settings) and `crypto.ts` (AES-256-GCM, random key generated to `/data/secret.key` chmod 600, encrypt/decrypt helpers, PIN log-redaction).
   Verify: vitest — encrypt/decrypt roundtrip, tamper detection, empty-PIN-keeps-existing behavior, atomic write on crash simulation, `assert` no PIN ever appears in logger output (redaction test).

4. **MQTT client + discovery** — `mqtt/client.ts` (MQTT.js QoS 1, connect via Supervisor `GET /services/mqtt`, fallback to manual options, reconnect with backoff), `mqtt/discovery.ts` (read `bridge/info` for base topic — never hardcode `zigbee2mqtt`; parse retained `bridge/devices` to list candidate locks: device with lock expose that includes `pin_code`).
   Verify: vitest with `bridge/info`/`bridge/devices` fixtures from real Z2M output (multi-arch base topic case, non-lock devices filtered out); mocked Supervisor fetch for discovery; manual check against a live Mosquitto+Z2M if available.

5. **Lock driver (set/clear)** — `mqtt/lockDriver.ts` builds per-lock payloads: set → `{"pin_code":{"user":SLOT,"user_type":"unrestricted","user_enabled":true,"pin_code":PIN}}`; clear → `{"pin_code":{"user":SLOT,"user_enabled":false,"pin_code":null}}`; tracks per-slot apply status from QoS-1 publish acks.
   Verify: vitest — payload fixtures match Z2M docs (Kwikset/Danalock/Weiser/Datek shapes), status transitions pending→applied / →failed with error text, multi-lock apply writes the same stored PIN to N topics.

6. **Keypad event pipeline** — `mqtt/events.ts` subscribes to `<base>/<friendly_name>` for each managed lock (and on add); normalizes payloads: standard shape (`action: unlock|lock`, `action_source_name: keypad`, `action_user: N`) and variant shape (`action: keypad_unlock|keypad_lock` per some converters); maps `action_user` → user name via that lock's list; records every event in the activity log (recognized, unknown slot, manual, failures like `unlock_failure_invalid_pin_or_id`); daily + startup purge at 90 days. Use Z2M `user` numbering verbatim (no ±1 slot translation — a known Keymaster bug class).
   Verify: vitest with recorded real-world Z2M state payloads — recognized unlock/lock produces activity entry + notification intent; unknown slot/manual logged without notification; failure actions logged; `keypad_*` variants normalized identically; retention purge drops 91-day-old entries.

7. **HA notify client** — `ha/supervisor.ts` `POST /core/api/services/<target>` with `Authorization: Bearer $SUPERVISOR_TOKEN` and message payload `{message: "<user> unlocked <lock>", title: "Lock Manager"}`; failure → activity-log error entry, never crashes.
   Verify: vitest with mocked fetch (URL, headers, payload, target from settings); manual on HAOS later.

8. **HTTP API** — `http/` routes: `GET /api/locks` (discovered + managed), `POST /api/locks` / `DELETE /api/locks/:id`; `GET/POST/PATCH/DELETE /api/locks/:id/users` (slot+name CRUD; PIN write-only field, empty = keep); `POST /api/users/apply-pin` (multi-lock target list); `POST /api/users/:slot/clear-pin`; `GET /api/activity?limit&offset`; `GET/PUT /api/settings` (notify target, enable/disable notifications). Admin gate: reject requests unless `X-Remote-User-Is-Admin: true` (Ingress-provided) — defense in depth behind `panel_admin`.
   Verify: vitest+supertest integration suite with mocked MQTT/notify layers — full user lifecycle, apply across two locks, admin-gate 403 case, activity listing.

9. **Frontend SPA** — React + Vite + TypeScript in `src/web/`: Locks view (discovered locks, add/remove), Users view per lock (slot, name, PIN input with "leave empty to keep", status badge applied/pending/failed, Apply / Clear actions, multi-lock apply selector), Activity view (recent events, filter by lock), Settings view (notify target, notification on/off). Relative URLs only, plain CSS visually aligned with HA.
   Verify: `npm run build` + lint; manual smoke in HAOS.

10. **CI + multi-arch publishing** — `.github/workflows/ci.yml`: jobs for lint (eslint, `tsc --noEmit`), tests (vitest), addon-linter, docker build; on tag/main: `docker/build-push-action` with buildx for `linux/amd64` + `linux/aarch64` to `ghcr.io/<owner>/lock-manager-{arch}` (matching `image:` in `config.yaml`).
    Verify: CI green on push; images appear on GHCR for both arches.

11. **HAOS end-to-end (manual)** — push to GitHub, add repo URL in HA App Store, install & start, verify: Mosquitto-based MQTT discovery lights up; lock detected and added; a user (slot+name+PIN) applied to the real lock and the PIN physically works on the keypad; keypad unlock with that PIN triggers `notify.notify` (and configured mobile-app target); activity log shows the event; failed write (e.g., broker stopped) shows a failed badge and can be retried.
    Verify: manual checklist mirroring facts; record results in this goal package.

12. **Docs** — root `README.md`: features, install, options reference, architecture diagram, security notes (encrypted PINs, admin-only panel, no expose_pin needed), and the known limitation that MQTT publish ack ≠ physical programming (read-back verification deliberately out of scope).
    Verify: doc review against facts list.

## Verification summary

- Automated (CI): addon-linter, `tsc --noEmit`, eslint, vitest unit + integration suites (crypto/redaction, store, discovery parsing, driver payloads, event normalization, notify client, HTTP API), docker build, multi-arch push.
- Manual (real system): HAOS install via App Store, Ingress sidebar visibility (admin-only), real-lock PIN set/clear, keypad event → notification, activity log retention, failure/retry path.

## Risks / open questions

- **Optimistic apply status**: QoS-1 MQTT ack means "broker accepted", not "lock programmed". Documented as a v1 limitation; read-back verification (needs `expose_pin`) is out of scope.
- **Per-model payload variance**: clear semantics differ slightly per lock vendor (omit `pin_code` vs `null`; Danalock needs `user_status` too). Driver keeps a default payload + per-lock variant hooks, with fixture tests; unknown models still get the default.
- **`action_user` numbering is per-model** (some 0-based, some 1-based). The app stores and matches Z2M's own numbering verbatim, so keypad events always line up with the numbers used in set payloads.
- **Ingress header trust**: `X-Remote-User-Is-Admin` is enforced as defense in depth; the primary gate is `panel_admin: true`.
- **Z2M base topic**: must be read from `bridge/info`, never assumed to be `zigbee2mqtt`.
- **GHCR owner/arch image naming** must match `config.yaml` `image:` exactly, or the App Store install will fail.
- **No Zigbee lock available in CI** — real-lock behavior (step 11) is a required manual gate before calling v1 done.