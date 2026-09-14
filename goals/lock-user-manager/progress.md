# Progress — Lock User Manager

Execution log for the plan in `plan.md`. Updated as steps complete.

## Decisions (from kickoff Q&A, 2026-09-13)

- **Distribution**: repo lives on GitHub (`jpersson/lock-manager`). Until the first tagged release the Supervisor builds locally (no `image:`); the Actions workflow publishes per-arch GHCR images on `v*` tags (see README "Publishing"). Future registry: `ghcr.io/jpersson/lock-manager-{arch}`.
- **Cadence**: autonomous execution of steps 1–10, then hand off for manual HAOS E2E (step 11).
- **Lock model**: not yet provided ("other vendor"). Driver uses default payload + variant hooks (Danalock variant included from Z2M docs). Open question for step 11.
- **CI (step 10)**: skipped per decision above; local equivalents (lint, typecheck, vitest, docker build) run instead.

## Corrections discovered during implementation

- **Ingress admin header**: the Supervisor does not send an `X-Remote-User-Is-Admin` header (plan step 8 assumed one). Admin visibility is enforced by HA via `panel_admin: true`; the app records `X-Remote-User-Name`/`X-Remote-User-Id` for audit purposes only.
- **CI bug (run 34812356726)**: debounced store flush fired after test teardown removed the data dir → throw inside a timer callback. The same failure would crash the app on any transient write error. Fixed: `flushNow` logs and never throws; added `close()` (cancel timer + final flush), used by shutdown and the test harness; regression test added (102 tests now). CI caught what 20+ local runs did not.
- **QEMU runner variance**: the main-run aarch64 build once ground for 30+ min on a contended emulated runner (identical commit built in 2m43s on proteus); cancel + rerun resolved it.
- **Notify service path**: Supervisor proxy path is `/core/api/services/<domain>/<service>` (e.g. `/core/api/services/notify/notify`), body `{title, message}`.
- **Z2M clear payload** (confirmed on zigbee2mqtt.io device pages): `{"pin_code":{"user":N}}` with `pin_code` omitted; Danalock remove is the same shape.
- **Keypad action shape** (confirmed): `action` ∈ {lock, unlock, lock_failure_*, unlock_failure_*, manual_lock, manual_unlock, one_touch_lock, …} + `action_source_name` ∈ {keypad, rfid, manual, rf} + `action_user`. No `keypad_lock`/`keypad_unlock` action values exist; normalizer still tolerates them defensively.

## Step log

| Step | Status | Notes |
| --- | --- | --- |
| 1. Scaffold | ✅ | manifests pass official add-on linter (tools/lint-addon.sh); docker build + run OK (CI/publishing deferred; image: owner will be jpersson) |
| 2. App skeleton | ✅ | Fastify + Ingress-safe SPA serving, options loader, redacting logger; 13 tests; docker image runs, /health + SPA fallback verified |
| 3. Store + crypto | ✅ | AES-256-GCM PIN crypto (tamper-tested), atomic debounced store.json, user CRUD w/ keep-PIN semantics, 90-day purge; 28 tests total |
| 4. MQTT client + discovery | ✅ | MqttService w/ base-topic-relative subs (auto re-subscribe, base correction from bridge/info), Z2M device parsing (pin_code composite detection), Supervisor /services/mqtt resolution; fixtures from real Z2M payloads; 50 tests |
| 5. Lock driver | ✅ | payload variants (default composite, Danalock user_status), QoS-1 writes to <friendly>/set, clear = pin_code omitted; fan-out verified |
| 6. Keypad event pipeline | ✅ | normalizer (keypad unlock/lock/failure, manual, other; slot verbatim), LockEventMonitor w/ rename re-watch, activity types, 90-day purge (startup + daily); landed together with step 7 |
| 7. HA notify client | ✅ | SupervisorClient.callNotifyService via /core/api/services/<domain>/<service>; notify pipeline: recognized keypad events → notify, failures → notify-failed activity entry; Settings overrides (store) over add-on option defaults |

**Bug fixed during step 6:** `Store.updateSettings` merged patches (reset values couldn't be cleared) — now replaces the complete settings object built by the domain layer.
| 8. HTTP API | ✅ | full REST surface (locks, users CRUD, multi-lock apply, activity w/ paging+filter, settings w/ overrides); X-Remote-User-Name audit trail; PIN never serialized; 101 tests. AJV coercion disabled (null-clear semantics) |

**Bug fixed during step 8:** fastify/AJV coerced JSON `null` → `""`/`false` (breaking settings-override clears and validation) — type coercion disabled app-wide.
| 9. Frontend SPA | ✅ | Locks / Users (per-lock, PIN keep-on-empty, apply fan-out dialog, status badges) / Activity (filter + polling) / Settings (overrides + reset); relative URLs, no router (Ingress-safe), HA-styled plain CSS; dark mode |

**Real-broker integration test (2026-09-13):** app + eclipse-mosquitto on a shared docker network — auto-discovery from retained `bridge/devices`, manage → create user → apply (set payload captured on the wire: `{"pin_code":{"user":1,"user_type":"unrestricted","user_enabled":true,"pin_code":"1234"}}`), status pending→applied, keypad unlock → activity + notify-failed (expected w/o Supervisor), state survives container restart (store.json + secret.key in /data). |
| 10. CI + publishing | ✅ | `.github/workflows/ci.yml`: lint/typecheck/vitest + official add-on linter + per-arch docker builds on push/PR (amd64 + aarch64 via QEMU); publishes `ghcr.io/jpersson/lock-manager-{arch}:<version>` on `v*` tags with config/tag version match gate; `image:` stays commented until the first tagged release (documented release flow in README) |
| 11. HAOS E2E (manual) | ⏳ | **user gate** — checklist below |
| 12. Docs | ✅ | root README (features/install/architecture/security/limitations/dev), add-on README, CHANGELOG |

## Step 11 — manual HAOS end-to-end checklist (user gate)

Run on the real Home Assistant installation:

- [ ] Push the `proteus` branch to GitHub (or merge to `main` — required, since the App Store reads the default branch)
- [ ] Add the repository URL to HA App Store (Settings → Apps → App Store → ⋮ → Repositories)
- [ ] Install **Lock Manager** from the store; it builds locally (this needs the machine to have internet access for the base image)
- [ ] Start the app; panel appears in the sidebar (admin only) — Mosquitto + Zigbee2MQTT running
- [ ] Locks auto-detected; manage the real lock
- [ ] Create a user (slot + name + PIN), apply → status `applied`; **the PIN physically opens the lock**
- [ ] Apply the same PIN to a second lock (if available) in one action
- [ ] Keypad unlock with that PIN → notification fires on the configured target with lock/user/action in the message
- [ ] Unknown PIN attempt + manual unlock → activity log entries, no notification
- [ ] Remove the user → PIN no longer works on the lock; entry gone
- [ ] Edit user, leave PIN empty → PIN still works (kept)
- [ ] Restart the app → users + activity survive
- [ ] Stop Mosquitto → apply shows `failed` with error; restart → retry succeeds

Open question: the actual lock vendor/model was never provided ("other vendor") — if the lock needs a different Z2M payload variant, add it in `lock-manager/app/src/mqtt/lockDriver.ts` (see the Danalock variant as the pattern) plus fixture tests.