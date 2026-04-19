# Inbound Email Worker

Minimal Cloudflare Worker that forwards incoming email to emdash-inbox.

## Why a separate Worker?

Cloudflare Email Routing delivers to a Worker's `email(message, env, ctx)`
handler. Astro's Cloudflare adapter only exposes `fetch`, so we can't attach
the email handler to the main site Worker. This side-car Worker owns the
email entrypoint and POSTs raw MIME to the plugin's ingestion route on the
main site.

## Deploy

1. **Configure the plugin** in your EmDash admin: set `Inbound webhook
   shared secret` to some random string.

2. **Copy this directory** into its own repo (or subdirectory) and install
   wrangler:
   ```
   npm i -D wrangler
   ```

3. **Copy `wrangler.jsonc.example` to `wrangler.jsonc`** and edit
   `INBOUND_URL` to match your deployed emdash host, e.g.
   `https://yoursite.example.com/_emdash/api/plugins/emdash-inbox/inbound`.

4. **Set the shared secret** (same value you put in plugin admin):
   ```
   npx wrangler secret put INBOUND_SECRET
   ```

5. **Deploy** the Worker:
   ```
   npx wrangler deploy
   ```

6. **Route email** to this Worker in the Cloudflare dashboard:
   Email → Email Routing → Routes → *catch-all* → **Send to a Worker** →
   `emdash-inbox-ingest`.

Test by sending an email to your domain. It should land in `ctx.storage.messages`
with `direction: "inbound"` within a few seconds.

## Troubleshooting

- **Bounces**: the Worker calls `message.setReject(...)` if the POST to the
  plugin fails, which surfaces a bounce to the sender. Check the Worker's
  logs in the Cloudflare dashboard.
- **No rows appearing**: verify the plugin's `inboundSecret` setting matches
  the Worker's `INBOUND_SECRET` secret (both are case-sensitive).
- **MIME parse errors**: the plugin logs these with `ctx.log.error` — tail
  your emdash host's logs.
