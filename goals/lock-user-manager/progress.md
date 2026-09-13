# Progress — Lock User Manager

Execution log for the plan in `plan.md`. Updated as steps complete.

## Decisions (from kickoff Q&A, 2026-09-13)

- **Distribution**: local Docker builds for now (Supervisor builds from the repo); CI/publishing wired later. `config.yaml` omits `image:` until publishing is set up. Future registry: `ghcr.io/jpersson/lock-manager-{arch}`.
- **Cadence**: autonomous execution of steps 1–10, then hand off for manual HAOS E2E (step 11).
- **Lock model**: not yet provided ("other vendor"). Driver uses default payload + variant hooks (Danalock variant included from Z2M docs). Open question for step 11.
- **CI (step 10)**: skipped per decision above; local equivalents (lint, typecheck, vitest, docker build) run instead.

## Corrections discovered during implementation

- **Ingress admin header**: the Supervisor does not send an `X-Remote-User-Is-Admin` header (plan step 8 assumed one). Admin visibility is enforced by HA via `panel_admin: true`; the app records `X-Remote-User-Name`/`X-Remote-User-Id` for audit purposes only.
- **Notify service path**: Supervisor proxy path is `/core/api/services/<domain>/<service>` (e.g. `/core/api/services/notify/notify`), body `{title, message}`.
- **Z2M clear payload** (confirmed on zigbee2mqtt.io device pages): `{"pin_code":{"user":N}}` with `pin_code` omitted; Danalock remove is the same shape.
- **Keypad action shape** (confirmed): `action` ∈ {lock, unlock, lock_failure_*, unlock_failure_*, manual_lock, manual_unlock, one_touch_lock, …} + `action_source_name` ∈ {keypad, rfid, manual, rf} + `action_user`. No `keypad_lock`/`keypad_unlock` action values exist; normalizer still tolerates them defensively.

## Step log

| Step | Status | Notes |
| --- | --- | --- |
| 1. Scaffold | ✅ | manifests pass official add-on linter (tools/lint-addon.sh); docker build + run OK (CI/publishing deferred; image: owner will be jpersson) |
| 2. App skeleton | ✅ | Fastify + Ingress-safe SPA serving, options loader, redacting logger; 13 tests; docker image runs, /health + SPA fallback verified |
| 3. Store + crypto | ⬜ | |
| 4. MQTT client + discovery | ⬜ | |
| 5. Lock driver | ⬜ | |
| 6. Keypad event pipeline | ⬜ | |
| 7. HA notify client | ⬜ | |
| 8. HTTP API | ⬜ | |
| 9. Frontend SPA | ⬜ | |
| 10. CI + publishing | 🔜 skipped (per decision) | local verification instead |
| 11. HAOS E2E (manual) | ⬜ | user gate |
| 12. Docs | ⬜ | |