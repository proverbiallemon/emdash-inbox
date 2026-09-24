# Provider delivery receipts

Configure the native descriptor with
`emdashInboxPlugin({ deliveryEvents: { accountId, zoneId, domain } })` and pass
Cloudflare Email Sending queue events to the private `delivery-events/record`
route using EmDash's `withEmDashRuntime()`. Without the option, event writes are
disabled. The route remains protected by `plugins:manage` for HTTP callers.

Receipts are separate from the durable send journal. Delivery events do not send,
retry, restore, or alter mail. Events are recorded per provider Message-ID and
recipient, even if they precede the sent-message projection. Read routes join
them into message and Outbox results. Copied recipients and their SMTP responses
remain redacted from Outbox summaries.

The latest recipient result survives duplicate and out-of-order events through
CAS. Terminal results cannot regress to deferred; complaints remain visible.
The UI distinguishes accepted-for-delivery from recipient-server delivery and
explains that delivery does not establish inbox placement or reading. Unknown
results remain unconfirmed, including messages predating event subscriptions.

PBWeb production verification on September 24, 2026 covered queue receipt
processing, authentication rejection, and live Outbox presentation using a
verified historical result. A synthetic receipt was processed and removed; no
external email was sent during deployment verification.
