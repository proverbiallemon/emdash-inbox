# emdash-inbox

**The mailbox UI for [EmDash CMS](https://github.com/emdash-cms/emdash).** Read, thread, reply, pin, snooze, and mark-done the email your site sends and receives, right inside the admin panel.

Outbound goes through the native Cloudflare Email Sending Workers binding — no API token to manage. Inbound arrives via a small Cloudflare Email Worker sidecar that POSTs to a webhook-secured endpoint. The whole UI is one EmDash plugin.

---

## Status

**Pre-alpha (v0.8.0).** The plugin works end-to-end for outbound + inbound + threading + compose + reply / reply-all with CC/BCC + drafts + grouped inbox with per-message read state. M1–M8 shipped: outbound and inbound email work end-to-end via the native CF Email Sending binding; the admin page is a card-based Inbox with pin / snooze / done, filter tabs, date buckets, and a cron-driven wake path for snoozed messages; clicking a card opens a thread-grouped detail view with sanitized HTML body rendering and thread-level bulk actions; the thread view has an inline TipTap-based reply form (pre-filled To / Subject / quoted body, Cmd+Enter to send); the inbox list collapses messages to one card per thread with participant chips, message-count badge, and a faded second snippet when the thread has history; an admin-auth MCP route (`messages/mcp`) exposes 14 inbox tools over JSON-RPC 2.0 (triage + compose + drafts); and a compose view with CC/BCC, a Drafts tab, and reply-all round out mail authoring in both the UI and MCP. Inbox list aggregates threads client-side over all messages on every list-view fetch — fine for personal mailboxes (<5K messages), revisit before v1.0 if running at higher volumes.

Built against EmDash v0.29.0 (bumped from 0.14 — see CHANGELOG). Expect breaking changes between commits as EmDash itself matures.

## Why this exists

EmDash (Cloudflare's WordPress successor, released April 2026) ships with a plugin system, a media library, content types, and an MCP server — but not with email. Cloudflare Email Service (public beta, April 2026) provides a native Workers binding for sending and a receive pipeline via Email Workers.

`emdash-inbox` is the missing piece: one plugin that makes EmDash a CMS *and* an email client, using the platform Cloudflare stack underneath.

### Relationship to `@emdash-cms/cloudflare`'s `cloudflare-email` plugin

Since 0.29 the Cloudflare adapter ships a first-party `cloudflare-email` provider plugin. It is send-only: it forwards messages to the `send_email` binding and stops there — no mailbox, no inbound path, no threading headers, no record of what was sent. If all you need is "magic links get delivered," use it and skip this plugin entirely.

`emdash-inbox` replaces it rather than stacking on top of it. EmDash routes all outbound mail through a single exclusive `email:deliver` provider, and this plugin records messages inside that hook — it is the only point in the pipeline where every outbound message (including system mail, which skips the observer hooks) can be captured. Practical consequence: **if both plugins are installed, select `emdash-inbox` under Settings → Email.** With `cloudflare-email` selected instead, mail still sends, but outbound messages never appear in the inbox.

## Operator setup

1. **Onboard your sender domain to Cloudflare Email Sending** (Dashboard -> Compute & AI -> Email Service -> Email Sending -> Onboard Domain). One-time.
2. **Add the `send_email` binding to your host's `wrangler.jsonc`:**
   ```jsonc
   "send_email": [
     { "name": "EMAIL", "remote": true }
   ]
   ```
3. **Wire the plugin into `astro.config.mjs`** alongside the existing `ssr.noExternal: ["emdash-inbox"]` entry. Under EmDash 0.12 the plugin's runtime deps (TipTap, dompurify, postal-mime) also want to be listed in `vite.ssr.noExternal` to avoid Vite optimizer cascades during dev — the browser still serves correctly without it, the cascades are just noisy.
4. **Configure plugin settings** in the admin: `senderAddress` (your verified sender) and `inboundSecret` (a long random string shared with the inbound sidecar worker).
5. **Deploy the inbound sidecar Worker** under `examples/inbound-email-worker/` and bind it to your domain via Cloudflare Email Routing. The sidecar POSTs raw RFC822 to `POST /_emdash/api/plugins/emdash-inbox/inbound`, gated by `X-Inbound-Secret` matching the value you configured in step 4.
6. **Enable a Cron Trigger on the host Worker** (EmDash ≥ 0.19). EmDash no longer piggybacks scheduled work on requests; without a Cron Trigger, snoozed messages never wake back to the inbox (and EmDash's own scheduled publishing stalls too). Your host's `src/worker.ts` should re-export the scheduled handler, and `wrangler.jsonc` needs the trigger:
   ```ts
   // src/worker.ts
   export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
   ```
   ```jsonc
   // wrangler.jsonc
   "triggers": { "crons": ["* * * * *"] }
   ```
   Hosts scaffolded with `create-emdash` ≥ 0.19 have this already.

Operators upgrading from 0.6.x: the `accountId` and `apiToken` fields are gone — existing rows for those settings are cleared automatically on first request after upgrade. The CF API token they referenced can be revoked.

### Troubleshooting

- **`No email provider configured` / `EMAIL_NOT_CONFIGURED` after install.** Tail the host worker (`wrangler tail`) and look for `[hooks] Plugin "emdash-inbox" declares email:deliver hook without hooks.email-transport:register capability — skipping`. That message means your host is on EmDash 0.14+ and is bundling an older `definePlugin` from `emdash-inbox`'s nested `node_modules`. Make sure `emdash-inbox`'s `devDependencies.emdash` matches your host's installed version (≥0.14) and rebuild the plugin with `pnpm install && pnpm build`. The current main branch is already set up for 0.14.
- **Magic-link URL contains `localhost:4321`.** EmDash stores the base URL under the `emdash:site_url` option in the database, set during initial setup. Setting `SITE_URL` in `wrangler.jsonc` afterwards does not back-fill that row. Update it directly: `wrangler d1 execute <db> --remote --command "UPDATE options SET value='\"https://your.domain\"' WHERE name='emdash:site_url';"`
- **Inbox admin page or `messages/*` routes return 403 for some users.** Since EmDash 0.28.1, every private plugin route requires the `plugins:manage` permission (and the `X-EmDash-Request` header) on all HTTP methods, including reads. Users below that permission tier — e.g. editors — can no longer reach the inbox API. Grant the role `plugins:manage` or have an administrator use the inbox.
- **Snoozed messages never come back.** See operator setup step 6 — the host Worker needs a Cron Trigger on EmDash ≥ 0.19.

## Connecting Claude (or any MCP client)

The plugin exposes 14 inbox tools over JSON-RPC 2.0 at `/_emdash/api/plugins/emdash-inbox/messages/mcp`: 7 triage tools (`list_threads`, `get_thread`, `search_messages`, `mark_read`, `pin_thread`, `snooze_thread`, `mark_done`) to read and manipulate messages, and 7 compose tools (`compose_email`, `reply_to_thread`, `reply_all_to_thread`, `save_draft`, `list_drafts`, `send_draft`, `discard_draft`) to draft and send mail. The admin UI for inbox triage and compose both surface these tools, so anything possible interactively is also possible through Claude, other MCP clients, or custom integrations.

Direct MCP client connections are blocked by EmDash's response envelope — the plugin route wraps all responses in `{"data": ...}`, which MCP clients can't unwrap. Deploy the HTTP proxy route from `examples/mcp-proxy-route/` on your site as the workaround. Copy `inbox-mcp.ts` to your `src/pages/api/` directory, set `EMDASH_INBOX_MCP_TOKEN` to an EmDash admin API token, and point your MCP client at `https://your.site/api/inbox-mcp`.

## Roadmap

| Milestone | Deliverable |
|---|---|
| **M1** ✅ | `email:provide` claimed; `email:deliver` hook sends via Cloudflare Email Service (REST path in M1; migrated to the native binding in M7). Outbound proven end-to-end. |
| **M2** ✅ | Inbound via Cloudflare Email Worker; basic list-view admin page. |
| **M3** ✅ | Inbox-by-Google UX: card-based list, pin / snooze / done, filter tabs, date buckets, cron wake path for snoozed messages. |
| **M4** ✅ | Threading (derived from In-Reply-To / References at ingest), message detail / thread view, sanitized HTML body rendering with external-image gating, thread-level bulk actions. |
| **M5** ✅ | Inline reply / compose in the thread view (TipTap StarterKit editor, pre-filled To / Subject with Re-prefix dedup, quoted-body seed, Cmd+Enter to send, Esc to discard); shared `deliverEmail()` extraction so both the `email:deliver` hook and the new `messages/reply` route dispatch through one path. |
| **M6** ✅ | Thread-grouping in the inbox list (one card per thread with participant chips, message-count badge, two-snippet preview when N≥2); per-message read state with auto-mark-read on thread open; latest-message-wins filter behavior; new `<ThreadCard>` with fan-out hover actions matching `<ThreadView>`'s bulk-action pattern. |
| **M7** ✅ | REST-to-native binding migration for outbound (drops the `accountId` / `apiToken` settings + the `network:fetch` capability); admin-auth `messages/mcp` route exposing 7 inbox tools over JSON-RPC 2.0 (`list_threads`, `get_thread`, `search_messages`, `mark_read`, `pin_thread`, `snooze_thread`, `mark_done`); typed `EmailBinding` + `DeliverError` + `wrapBindingError()` helper module. |
| **M8** ✅ | Compose-from-scratch with CC / BCC, reply-all, and the full draft lifecycle (save / resume / send / discard, Drafts tab) — in both the admin UI **and** the `messages/mcp` route (7 new tools, catalog of 14), all wrapping one shared operations core. Host-side MCP proxy example so Claude and other MCP clients can connect despite the response envelope. Attachments, signatures, toast undo, and pagination moved to M8b. |
| **M8b** | Attachments (inbound + outbound), signatures, toast undo, pagination for `messages/list`, and the remaining triage-suite polish — scoped after a period of real-mail dogfooding. Target: "full inbox in a Claude chat," daily-driver grade. |
| **M9** | Bundle classification (Orders, Shipping, Commissions, Fans, Promos, Updates) + highlights — structured field extraction surfaced as inline cards. Reminders, content linking. **v1.0.** |

## Attribution

Informed by patterns from [SaasMail](https://github.com/choyiny/saasmail) (Apache License 2.0) — particularly around Cloudflare Email Workers inbound handling, MIME parsing, and the rich-text composer. See [NOTICE](./NOTICE).

## License

[Apache License 2.0](./LICENSE).
