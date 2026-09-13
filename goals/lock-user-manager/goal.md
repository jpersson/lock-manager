# Goal — Lock User Manager (HA app, Zigbee2MQTT)

## Articulated goal

Build a Home Assistant app (add-on) named **Lock Manager** for HAOS/Supervised that manages keypad users for Zigbee2MQTT locks from the HA sidebar: per-lock user lists (slot + name), encrypted PIN storage with PIN writes to one or more locks in one action, and notifications plus an activity log whenever a recognized user locks or unlocks via the keypad. Implemented in Node.js + TypeScript with an Ingress UI, MQTT-direct lock I/O (write-only — no `expose_pin` needed), and HA notify actions via the Supervisor proxy.

## Shared understanding

The 17 accepted, testable facts that define v1 scope and behavior: [`facts.md`](facts.md)

## Execution plan

Ordered 12-step build (scaffold → app skeleton → store/crypto → MQTT → driver → events → notify → API → SPA → CI → manual E2E on real lock → docs), with per-step verification and flagged risks: [`plan.md`](plan.md)

## Done condition

CI is green (linter, addon-linter, typecheck, all vitest suites, multi-arch GHCR images), and a manual end-to-end run on HAOS confirms every fact: the app installs from the repo URL, locks are auto-detected, a user's PIN is applied to a real lock and physically opens it, a keypad unlock fires the configured notify action with lock/user/action in the message, and the activity log records recognized and unknown events with 90-day retention.