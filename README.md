# emdash-inbox

**The Cloudflare Email Service transport for [EmDash CMS](https://github.com/emdash-cms/emdash), with a built-in Inbox-by-Google-style mailbox.**

A native EmDash plugin that does two things at once:

1. **Email transport** — claims EmDash's `email:provide` capability and ships outbound mail via the Cloudflare Email Service binding. Any other EmDash plugin that calls `ctx.email.send()` routes through `emdash-inbox`.
2. **Unified inbox UI** — card-based mailbox in the EmDash admin that surfaces both incoming mail (via Cloudflare Email Workers) and every outbound message sent by any plugin. Bundles, pin / snooze / done, highlights, reminders — the good ideas from Google Inbox (RIP 2019), shaped for a modern CMS admin.

---

## Status

**Pre-alpha (v0.3.0).** M1 + M2 + M3 shipped: outbound and inbound email work end-to-end, and the admin page is a card-based Inbox with pin / snooze / done, filter tabs, date buckets, and a cron-driven wake path for snoozed messages.

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
| **M4** | Threading (derive from In-Reply-To / References) + message detail view. Bundle classification (Orders, Shipping, Commissions, Fans, Promos, Updates). |
| **M5** | Highlights — structured field extraction (order totals, tracking, event times) surfaced as inline cards. |
| **M6** | Reminders, content linking, MCP extension for agent-driven inbox operations. **v1.0.** |

## Attribution

Informed by patterns from [SaasMail](https://github.com/choyiny/saasmail) (Apache License 2.0) — particularly around Cloudflare Email Workers inbound handling, MIME parsing, and the rich-text composer. See [NOTICE](./NOTICE).

## License

[Apache License 2.0](./LICENSE).
