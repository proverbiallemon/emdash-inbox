# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-20

### Added

- Status actions on messages. New plugin routes `messages/pin` (toggle
  pinned flag) and `messages/status` (move between `inbox` / `snoozed` /
  `done`, with `snoozeUntil` when snoozing). Admin-auth-gated.
- Cron-driven wake path for snoozed messages. The plugin schedules a
  `wake-snoozed-messages` task (every 5 min) that moves any snoozed row
  whose `snoozeUntil` has passed back to the inbox and updates `sortAt`
  so it resurfaces at the top.
- Filter tabs on the admin page — Inbox / Snoozed / Done / All. URL
  reflects the active tab via `?status=...` so tabs deep-link and share.
  Snoozed is sorted ascending by `snoozeUntil` (next-to-wake first);
  the other tabs sort by `sortAt` desc.
- Card-based inbox UI. `MessageCard` with left-edge color strip
  (emerald inbound, sky outbound, amber snoozed, muted done). Cards
  grouped into date buckets — past-direction (TODAY / YESTERDAY / THIS
  WEEK / OLDER) on Inbox/Done/All, future-direction (TODAY / TOMORROW /
  THIS WEEK / LATER) on Snoozed.
- Per-tab empty states with tab-specific copy, and a skeleton loader
  (`SkeletonList`) for the initial fetch.
- `SnoozePicker` popover with preset durations (later today, tomorrow,
  this weekend, next week) resolved against the current time.
- Two new indexed fields on `messages`: `sortAt` (drives inbox order;
  equals `receivedAt` on create, updated to wake-time when a snoozed
  message resurfaces) and `snoozeUntil` (ISO8601, null when not
  snoozed). Idempotent backfill runs on first `messages/list` call so
  pre-M3 rows gain the fields transparently.
- Vitest wired up. 19 unit tests across three pure-logic modules:
  `bucketize` (date-bucket grouping), `snoozePresets` (preset resolution),
  and `statusTransitions` (state-machine validator).

### Notes

- `ctx.cron` is undefined on route contexts in EmDash v0.5.0 (the
  route-handler factory is constructed before the cron scheduler wires
  itself in). The lazy setup path guards with `if (ctx.cron)` so
  `messages/list` doesn't crash; the cron row gets created on the
  hook-context paths (`plugin:install`, `plugin:activate`) instead.
- Config-registered plugins (those registered in `astro.config.mjs`)
  don't re-fire `plugin:install` or `plugin:activate` on every boot —
  only on first install and explicit admin-UI enable. The lazy
  backfill-on-first-list path exists to cover the upgrade case.
- Message detail view is deferred to M4 alongside threading. Building a
  flat detail now would need to be rewritten once messages become
  conversations.

## [0.2.0] — 2026-04-19

### Added

- Outbound email delivery through Cloudflare Email Service via its REST API.
  Claims the `email:provide` capability, so any plugin that calls
  `ctx.email.send()` on the host EmDash instance routes through this plugin.
- Inbound email ingestion. Public plugin route `POST /_emdash/api/plugins/
  emdash-inbox/inbound` accepts raw RFC822 MIME wrapped in a JSON envelope,
  gated by a shared-secret `X-Inbound-Secret` header. MIME parsing is done
  server-side with `postal-mime`.
- Persistence. Two storage collections (`messages`, `contacts`) declared via
  `definePlugin`. Every outbound send writes a message row and upserts a
  contact; every inbound message does the same on receipt.
- React admin UI. A single Inbox page (at `/_emdash/admin/plugins/emdash-
  inbox/`) lists all persisted messages with direction, counterparty,
  subject, and status.
- Example Cloudflare Email Worker under `examples/inbound-email-worker/` —
  a minimal side-car Worker operators deploy to route inbound mail from
  Cloudflare Email Routing to this plugin's `/inbound` endpoint.
- Admin settings schema: Cloudflare account ID, API token (Email Sending
  scope), verified sender address, inbound webhook secret.

### Notes

- Outbound uses the REST API rather than the `env.SEND_EMAIL` binding because
  EmDash v0.5.0 plugin contexts do not expose host Cloudflare env bindings.
  If that lands upstream, the transport is a one-line swap in
  `email:deliver`.
- Inbound requires a second Cloudflare Worker because Astro's Cloudflare
  adapter exposes only the `fetch` handler, not the `email` handler. The
  shipped template (`examples/inbound-email-worker/`) is ~50 lines of
  boilerplate for operators to deploy.

## [0.1.0] — 2026-04-19

### Added

- Initial scaffold via `emdash plugin init --native`.
- Project metadata, LICENSE (Apache 2.0), NOTICE, README.
- Declared `email:provide` + `email:intercept` capabilities with stub hooks.
