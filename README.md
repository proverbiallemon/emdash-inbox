# emdash-inbox

**The Cloudflare Email Service transport for [EmDash CMS](https://github.com/emdash-cms/emdash), with a built-in Inbox-by-Google-style mailbox.**

A native EmDash plugin that does two things at once:

1. **Email transport** — claims EmDash's `email:provide` capability and ships outbound mail via the Cloudflare Email Service binding. Any other EmDash plugin that calls `ctx.email.send()` routes through `emdash-inbox`.
2. **Unified inbox UI** — card-based mailbox in the EmDash admin that surfaces both incoming mail (via Cloudflare Email Workers) and every outbound message sent by any plugin. Bundles, pin / snooze / done, highlights, reminders — the good ideas from Google Inbox (RIP 2019), shaped for a modern CMS admin.

---

## Status

**Pre-alpha (v0.6.0).** The plugin works end-to-end for outbound + inbound + threading + reply + grouped inbox with per-message read state. M1 + M2 + M3 + M4 + M5 + M6 shipped: outbound and inbound email work end-to-end, the admin page is a card-based Inbox with pin / snooze / done, filter tabs, date buckets, and a cron-driven wake path for snoozed messages; clicking a card opens a thread-grouped detail view with sanitized HTML body rendering and thread-level bulk actions; the thread view has an inline TipTap-based reply form (pre-filled To / Subject / quoted body, Cmd+Enter to send); and the inbox list now collapses messages to one card per thread with participant chips, message-count badge, and a faded second snippet when the thread has history. Inbox list aggregates threads client-side over all messages on every list-view fetch — fine for personal mailboxes (<5K messages), revisit before v1.0 if running at higher volumes.

Built against EmDash v0.5.0. Expect breaking changes between commits as EmDash itself matures.

## Why this exists

EmDash (Cloudflare's WordPress successor, released April 2026) ships with a plugin system, a media library, content types, and an MCP server — but not with email. Cloudflare Email Service (public beta, April 2026) provides a native Workers binding for sending and a receive pipeline via Email Workers.

`emdash-inbox` is the missing piece: one plugin that makes EmDash a CMS *and* an email client, using the platform Cloudflare stack underneath.

## Roadmap

| Milestone | Deliverable |
|---|---|
| **M1** ✅ | `email:provide` claimed; `email:deliver` hook sends via Cloudflare Email Service (REST path, since v0.5.0 plugin ctx can't reach host env bindings). Outbound proven end-to-end. |
| **M2** ✅ | Inbound via Cloudflare Email Worker; basic list-view admin page. |
| **M3** ✅ | Inbox-by-Google UX: card-based list, pin / snooze / done, filter tabs, date buckets, cron wake path for snoozed messages. |
| **M4** ✅ | Threading (derived from In-Reply-To / References at ingest), message detail / thread view, sanitized HTML body rendering with external-image gating, thread-level bulk actions. |
| **M5** ✅ | Inline reply / compose in the thread view (TipTap StarterKit editor, pre-filled To / Subject with Re-prefix dedup, quoted-body seed, Cmd+Enter to send, Esc to discard); shared `deliverEmail()` extraction so both the `email:deliver` hook and the new `messages/reply` route dispatch through one path. |
| **M6** ✅ | Thread-grouping in the inbox list (one card per thread with participant chips, message-count badge, two-snippet preview when N≥2); per-message read state with auto-mark-read on thread open; latest-message-wins filter behavior; new `<ThreadCard>` with fan-out hover actions matching `<ThreadView>`'s bulk-action pattern. |
| **M7** | Compose-from-scratch + reply-all + CC / BCC, attachments, signatures, drafts, toast undo, pagination for `messages/list`. |
| **M8** | Bundle classification (Orders, Shipping, Commissions, Fans, Promos, Updates) + highlights — structured field extraction surfaced as inline cards. |
| **M9** | Reminders, content linking, MCP extension for agent-driven inbox operations. **v1.0.** |

## Attribution

Informed by patterns from [SaasMail](https://github.com/choyiny/saasmail) (Apache License 2.0) — particularly around Cloudflare Email Workers inbound handling, MIME parsing, and the rich-text composer. See [NOTICE](./NOTICE).

## License

[Apache License 2.0](./LICENSE).
