# Durable send recovery

Inbox 0.10 adds a durable Outbox for compose, reply, draft sends, and the EmDash email provider hook. Cloudflare acceptance and local storage cannot be committed atomically. This design preserves uncertainty rather than automatically sending a second copy.

## Sending and recovery

The plugin stores the complete message and attachment references before invoking transport. A draft moves to `outbox` with a revision-checked claim; saving, deleting, changing its files, or moving it through mailbox actions is then blocked. A delivery journal records the attempt. Only the request that successfully claims the journal's `prepared → sending` transition may call the provider.

An accepted provider receipt is saved before the message is projected into Sent. The same storage message ID survives that transition. Recovery repeats the mailbox write, never the provider call, and preserves later read, pin, and status changes.

A documented pre-acceptance rejection restores the final send edits to an editable draft. Network failures, timeouts, unknown errors, and ambiguous delivery failures remain uncertain. The classifier uses documented error codes, not words in an error message. See [Cloudflare's Workers API errors](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes).

Recovery runs in bounded batches on Outbox access and through the existing five-minute plugin cron. Interrupted preparation can be restored safely; an attempt left in `sending` for five minutes becomes uncertain. This age threshold does not prove a provider call has stopped. An operator should verify delivery before resolving it.

## Outbox actions

- **Refresh/reconcile:** recover accepted messages and classify interrupted attempts. This never sends email.
- **Confirm sent:** after checking delivery, record that the uncertain message was sent. Supply its actual provider Message-ID when available; otherwise the plugin uses an explicitly local identifier and cannot promise reply correlation.
- **Restore draft:** acknowledge that sending again may produce a duplicate. This only unlocks a draft; sending it remains a separate action.

An accepted receipt takes precedence over a concurrent restore. If the restored draft was already edited, removed, or sent as another attempt, recovery must not overwrite those changes. The receipt stays in the journal for review.

## Request identity

`messages/compose`, `messages/reply`, `messages/reply-all`, `messages/draft-send`, and their sending MCP tools accept an optional `requestId` (1–200 characters). Use a unique key for each intentional attempt and retain it when retrying the same request after a lost response. Reusing a key with different input is rejected. Retrying an existing key returns its recorded status without contacting transport again.

If the original request never reached the server, retrying that key may initiate its first send. The UI explains this and preserves the original payload. Once the server reports pending or uncertain delivery, it directs the user to Outbox review.

Results retain `id` and `threadId` and add `attemptId`, `deliveryStatus` (`sent`, `pending`, `uncertain`, or `failed`), and optional `error`/`draftId`. A successful HTTP response alone does not mean mail was sent. Check `deliveryStatus`. Generic EmDash provider-hook calls do not supply a stable request key; distinct hook invocations remain distinct attempts.

## API and MCP

Private routes require `plugins:manage`:

| Route | Input | Result |
| --- | --- | --- |
| `deliveries/list` | Optional `limit` (1–100), `cursor` | `{items,cursor,hasMore}` |
| `deliveries/reconcile` | `{}` | Recovery counts and bounded continuation indicator |
| `deliveries/resolve` | `attemptId`, `resolution: "sent" | "restore"`, optional `providerMessageId`, `confirmDuplicateRisk: true` for uncertain restoration | `{ok:true,id?,threadId?,draftId?}` |

Native MCP adds `list_deliveries`, `reconcile_deliveries`, and `resolve_delivery`, bringing the catalog to 20 tools. Refresh plugin MCP consent after upgrading. Only listing is marked read-only; reconciliation and resolution change durable state. Agents must obtain the operator's decision before resolving an uncertain delivery.

Delivery lists contain summary metadata only, excluding bodies, BCC recipients, raw MIME, and private object keys. The journal snapshot has the same private storage protections as mailbox content. Attachment downloads still require message membership and Inbox permission.

## Operational limits

- A crash after provider acceptance but before the receipt is durably recorded requires operator review. There is no automatic resend or exactly-once guarantee.
- Keep the current build while attempts remain unresolved. Older builds do not understand Outbox locks or delivery metadata.
- Journal retention and orphan-file reconciliation remain follow-up work. Contact statistics are best effort and are not a delivery ledger.
- Fault injection belongs in local integration tests. Production smoke tests should use only an intentional synthetic message to an owned mailbox.
