# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
