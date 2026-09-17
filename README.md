# emdash-inbox

**The mailbox UI for [EmDash CMS](https://github.com/emdash-cms/emdash).** Read, thread, reply, pin, snooze, and mark-done the email your site sends and receives, right inside the admin panel.

Outbound goes through the native Cloudflare Email Sending Workers binding — no API token to manage. Inbound arrives via a small Cloudflare Email Worker sidecar that POSTs to a webhook-secured endpoint. The whole UI is one EmDash plugin.

---

## Status

**Pre-alpha (v0.10.0, development).** Inbound/outbound mail, complete conversation pagination, pin / snooze / done, read state, compose/reply-all with CC/BCC, drafts, private attachments, settings, durable send recovery, and 20 native MCP tools are implemented. Signatures and undo remain planned.

Requires **EmDash 0.38.x**, tested against **0.38.0**. The mailbox uses resumable indexing and revision-checked writes. EmDash caps each storage query at 100 rows; complete operations now follow continuations. See [compatibility notes](docs/emdash-0.38-compatibility.md) and [pagination/attachment contracts and limits](docs/mailbox-and-attachments.md).

## Why this exists

EmDash (Cloudflare's WordPress successor, released April 2026) ships with a plugin system, a media library, content types, an MCP server, and a send-only email provider. It does not include a personal email mailbox. Cloudflare Email Service (public beta, April 2026) provides a native Workers binding for sending and a receive pipeline via Email Workers.

`emdash-inbox` is the missing piece: one plugin that makes EmDash a CMS *and* an email client, using the platform Cloudflare stack underneath.

### Relationship to `@emdash-cms/cloudflare`'s `cloudflare-email` plugin

As of EmDash 0.38.0, the Cloudflare adapter ships a first-party `cloudflare-email` provider plugin. It is send-only: it forwards messages to the `send_email` binding and stops there — no mailbox, no inbound path, no threading headers, no record of what was sent. If all you need is "magic links get delivered," use it and skip this plugin entirely.

`emdash-inbox` replaces it rather than stacking on top of it. EmDash routes all outbound mail through a single exclusive `email:deliver` provider, and this plugin records messages inside that hook — it is the only point in the pipeline where every outbound message (including system mail, which skips the observer hooks) can be captured. Practical consequence: **if both plugins are installed, select `emdash-inbox` under Settings → Email.** With `cloudflare-email` selected instead, mail still sends, but outbound messages never appear in the inbox.

## Operator setup

1. **Onboard your sender domain to Cloudflare Email Sending** (Dashboard -> Compute & AI -> Email Service -> Email Sending -> Onboard Domain). One-time.
2. **Add the `send_email` binding to your host's `wrangler.jsonc`:**
   ```jsonc
   "send_email": [
     { "name": "EMAIL", "remote": true }
   ]
   ```
3. **Wire the plugin into `astro.config.mjs`.** Register the named `emdashInboxPlugin` export — not the package's default export, which is the plugin runtime and fails at config load with `Plugin "emdash-inbox" has no entrypoint`:
   ```js
   import { emdashInboxPlugin } from "emdash-inbox";

   emdash({
     // ...database, storage...
     plugins: [emdashInboxPlugin()],
   })
   ```
   Add `"emdash-inbox"` to `vite.ssr.noExternal`. The plugin's runtime deps (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`, `@tiptap/core`, `dompurify`, `postal-mime`) also want to be listed there to avoid Vite optimizer cascades during dev — the browser still serves correctly without them, the cascades are just noisy.
4. **Configure plugin settings** at Admin → Inbox Settings: `senderAddress` (your verified sender) and `inboundSecret` (a long random string shared with the inbound sidecar worker — the page can generate one). Headless alternative: `POST /_emdash/api/plugins/emdash-inbox/settings/save` with an admin API token, the `X-EmDash-Request: 1` header, and a JSON body of `{"senderAddress": ..., "inboundSecret": ...}`.
5. **Configure private attachments** using a separate R2 bucket bound as `INBOX_ATTACHMENTS`, with public access disabled. Never reuse EmDash’s `MEDIA` bucket. See [setup and limits](docs/mailbox-and-attachments.md).
6. **Deploy the inbound sidecar Worker** under `examples/inbound-email-worker/` and bind it to your domain via Cloudflare Email Routing. The sidecar POSTs a byte-preserving `rawMimeBase64` JSON envelope to `POST /_emdash/api/plugins/emdash-inbox/inbound`, gated by `X-Inbound-Secret` matching the value you configured in step 4.
7. **Enable a Cron Trigger on the host Worker** (EmDash ≥ 0.19). EmDash no longer piggybacks scheduled work on requests; without a Cron Trigger, snoozed messages never wake back to the inbox (and EmDash's own scheduled publishing stalls too). Your host's `src/worker.ts` should re-export the scheduled handler, and `wrangler.jsonc` needs the trigger:
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

- **`No email provider configured` / `EMAIL_NOT_CONFIGURED` after install.** Tail the host worker (`wrangler tail`) and look for `[hooks] Plugin "emdash-inbox" declares email:deliver hook without hooks.email-transport:register capability — skipping`. That message means your host is on EmDash 0.14+ and is bundling an older `definePlugin` from `emdash-inbox`'s nested `node_modules`. Make sure `emdash-inbox`'s `devDependencies.emdash` matches your host's installed version (≥0.14) and rebuild the plugin with `pnpm install && pnpm build`. This development version requires EmDash 0.38.x.
- **Magic-link URL contains `localhost:4321`.** EmDash stores the base URL under the `emdash:site_url` option in the database, set during initial setup. Setting `SITE_URL` in `wrangler.jsonc` afterwards does not back-fill that row. Update it directly: `wrangler d1 execute <db> --remote --command "UPDATE options SET value='\"https://your.domain\"' WHERE name='emdash:site_url';"`
- **Inbox admin page or `messages/*` routes return 403 for some users.** Since EmDash 0.28.1, every private plugin route requires the `plugins:manage` permission (and the `X-EmDash-Request` header) on all HTTP methods, including reads. Users below that permission tier — e.g. editors — can no longer reach the inbox API. Grant the role `plugins:manage` or have an administrator use the inbox.
- **A Proton test reaches Proton but not Inbox.** Proton may deliver internally between addresses hosted in the same account, bypassing Cloudflare MX and the ingest worker. Use a sender that traverses the external SMTP route. Confirm both delivery paths in the worker logs.
- **Snoozed messages never come back.** See operator setup step 7 — the host Worker needs a Cron Trigger on EmDash ≥ 0.19.
- **Astro 7 / Vite 8 Node host starts with a Kysely class-initialization error.** This also reproduced without the plugin. See the tested [host bundling workaround](docs/emdash-0.38-compatibility.md#astro-7--vite-8-host-bundling-workaround).

## Connecting Claude (or any MCP client)

Use EmDash's native endpoint: **`https://your.site/_emdash/api/mcp`**.

1. Activate emdash-inbox and enable its MCP tools under **Admin → Plugins**, reviewing the host's consent prompt.
2. Connect with EmDash OAuth or a personal access token with **`mcp:tools:emdash-inbox`** scope. The caller also needs **`plugins:manage`** permission.
3. After an upgrade that changes tool definitions, disable and re-enable MCP tools to refresh consent. EmDash 0.38 can show the switch enabled while discovery remains empty.
4. Discover the 20 tools, namespaced by the host: `emdash-inbox__list_threads`, `emdash-inbox__compose_email`, `emdash-inbox__save_draft`, and so on. Tools cover triage, compose, reply-all, drafts, attachment add / remove / read, and delivery review/recovery.

EmDash owns MCP transport, authentication, scope checks, and plugin consent. Sending and mailbox-changing tools are marked destructive in the host's tool metadata.

The old `messages/mcp` JSON-RPC route remains for existing integrations. Its optional [proxy example](examples/mcp-proxy-route/) now requires **each caller's own Bearer token**. If you deployed the previous example, replace or remove it and revoke its shared `EMDASH_INBOX_MCP_TOKEN`: that version delegated the host token to anonymous requests. New clients should use the native endpoint above.

See [durable send recovery](docs/durable-send-recovery.md) for Outbox behavior, stable request IDs, operator resolution, and recovery limits.

## Development checks

Use Node 24.15 or newer in the Node 24 LTS line and pnpm 8.15.1:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm validate
```

`validate` builds both package entrypoints and checks native exports, versions, registration, and routes. Integration tests run EmDash's real SQLite migrations, plugin dispatch, conditional storage, cron hook, and published MCP HTTP adapter. Email delivery is replaced with a test transport; no real mail is sent. GitHub Actions runs these checks on pushes and pull requests.

### Daylight UI preview

The Daylight mail UI adds account-specific Top/Left navigation, an expanded window with dashboard return, responsive conversation and compose views, and private attachment previews. See the [design handoff and coverage](docs/daylight-design.md) for implemented behavior and future tools.

Daylight is deployed on PBWeb with EmDash 0.38.0. The [September 17 rollout report](docs/daylight-production-2026-09-17.md) records the exact build, live checks, and remaining acceptance limits.

M9.1 bundles are also deployed on PBWeb: six Inbox categories, conversation corrections, optional exact-sender rules, account grouping preferences, and resumable bundle completion. See the [bundle rollout report](docs/m9-bundles-production-2026-09-17.md) and [specification](docs/m9-bundles-design.md).

Run `pnpm dev:preview` from a source checkout to open the real UI with synthetic mail at `http://127.0.0.1:4317/`. The preview sends no email. **Reset sample mail** restores the fixture; refreshing retains synthetic bundle-operation state for recovery checks. Production still uses EmDash's authenticated plugin routes.

## Roadmap

| Milestone | Deliverable |
|---|---|
| **M1** ✅ | `email:provide` claimed; `email:deliver` hook sends via Cloudflare Email Service (REST path in M1; migrated to the native binding in M7). Outbound proven end-to-end. |
| **M2** ✅ | Inbound via Cloudflare Email Worker; basic list-view admin page. |
| **M3** ✅ | Inbox-by-Google UX: card-based list, pin / snooze / done, filter tabs, date buckets, cron wake path for snoozed messages. |
| **M4** ✅ | Threading (derived from In-Reply-To / References at ingest), message detail / thread view, sanitized HTML body rendering with external-image gating, thread-level bulk actions. |
| **M5** ✅ | Inline reply / compose in the thread view (TipTap StarterKit editor, pre-filled To / Subject with Re-prefix dedup, quoted-body seed, Cmd+Enter to send, Esc to close with unsaved-change protection); shared `deliverEmail()` extraction so both the `email:deliver` hook and the new `messages/reply` route dispatch through one path. |
| **M6** ✅ | Thread-grouping in the inbox list (one card per thread with participant chips, message-count badge, message preview and expandable conversation history); per-message read state with auto-mark-read on thread open; latest-message-wins filter behavior; new `<ThreadCard>` with fan-out hover actions matching `<ThreadView>`'s bulk-action pattern. |
| **M7** ✅ | REST-to-native binding migration for outbound (drops the `accountId` / `apiToken` settings + the `network:fetch` capability); admin-auth `messages/mcp` route exposing 7 inbox tools over JSON-RPC 2.0 (`list_threads`, `get_thread`, `search_messages`, `mark_read`, `pin_thread`, `snooze_thread`, `mark_done`); typed `EmailBinding` + `DeliverError` + `wrapBindingError()` helper module. |
| **M8** ✅ | Compose-from-scratch with CC / BCC, reply-all, and the full draft lifecycle (save / resume / send / discard, Drafts tab) — in both the admin UI **and** the `messages/mcp` route (7 new tools, catalog of 14), all wrapping one shared operations core. Host-side MCP proxy example so Claude and other MCP clients can connect despite the response envelope. Attachments, signatures, toast undo, and pagination moved to M8b. |
| **M8b** ✅ | Private inbound/outbound attachments, complete thread pagination, resumable substring search, and server-side thread actions. Signatures and toast undo remain follow-up polish. |
| **Send recovery** ✅ | Durable send attempts, locked Outbox, receipt recovery, stable request IDs, and explicit review of uncertain outcomes. |
| **Daylight UI** | Deployed on PBWeb: Top/Left navigation, full-window mode, responsive read/compose, search, private attachment previews, and host-link draft protection. See the rollout report for acceptance coverage. |
| **M9.1 — Bundles** ✅ | Deployed on PBWeb: Orders, Shipping, Commissions, Fans, Promos and Updates; manual corrections and exact-sender rules; grouping preferences; resumable completion with per-conversation outcomes. See the rollout report for verification and remaining limits. |
| **M9 — Remaining** | Highlights: structured field extraction surfaced as inline cards. Reminders and content linking. **v1.0 remains future.** |

## Attribution

Informed by patterns from [SaasMail](https://github.com/choyiny/saasmail) (Apache License 2.0) — particularly around Cloudflare Email Workers inbound handling, MIME parsing, and the rich-text composer. See [NOTICE](./NOTICE).

## License

[Apache License 2.0](./LICENSE).
