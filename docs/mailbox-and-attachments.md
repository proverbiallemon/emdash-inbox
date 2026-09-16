# Mailbox pagination and private attachments (0.9)

The admin loads 25 complete conversations per page. Pins come first, followed by activity time (or wake time in Snoozed). Load more continues the current filter; Refresh starts over. These are live pages: edits can move a conversation across a boundary. The client deduplicates IDs; refresh to see new arrivals.

EmDash 0.38 limits each storage query to 100 rows. Complete thread reads, draft reads, mutations and snooze work iterate all native cursor pages. Thread lists use small materialized summaries. Writes atomically mark messages dirty, and repair uses revisions so a stale worker cannot replace newer projections or clear a concurrent update. Migration and repair advance in bounded batches on access and cron. While the initial index is incomplete, list/search responses explicitly report `indexing:true`; direct thread operations ask the caller to retry.

`POST threads/list` accepts `{status,limit?,cursor?}`; statuses are inbox/done/snoozed/all. Default limit25, maximum100. `list_threads` MCP uses the same page envelope `{items,cursor?,hasMore,indexing?}`. This replaces the former MCP bare array. `search_messages` has the same envelope and accepts `{query,limit?,cursor?}`. Search preserves case-insensitive subject/body substring matching; the storage API has no substring index, so it scans up to200 slim search documents per request. An empty search page can have `hasMore:true`; continue its cursor. Cursors are bound to filter/query/version. Legacy `messages/list` returns the complete mailbox and should be replaced by `threads/list` in new clients.

## Private storage setup

Create a separate R2 bucket and keep its public managed/custom domains disabled. Add to the host's source Wrangler config:

```jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "your-existing-public-media" },
  { "binding": "INBOX_ATTACHMENTS", "bucket_name": "your-private-inbox-files" }
]
```

Build and deploy the host. Do not configure `INBOX_ATTACHMENTS` as EmDash's media provider. The host media download routes are public; private email files must never share that bucket. Existing attachment-free mail continues to work without the new binding; attachment operations report configuration errors. The binding syntax follows [Wrangler's R2 configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#r2-buckets).

Upgrade the inbound sidecar to the supplied example. It POSTs `{rawMimeBase64}` using `X-Inbound-Secret`, preserving binary MIME bytes. Legacy `{rawMime}` strings are temporarily accepted. The host stores attachment bytes and attachment-bearing/large raw MIME privately; message DTOs omit raw MIME, object keys, and internal indexing state. Inline MIME parts are downloads; they are not rendered automatically.

## Limits and lifecycle

- Incoming raw MIME:8MiB maximum; decoded text plus HTML:256KiB maximum; at most32 attachments. Oversize messages fail ingestion explicitly. A deployment with an independent Proton forwarding path can still deliver that copy; monitor ingestion failures.
- Outgoing files:3MiB combined, at most32; decoded text plus HTML:256KiB. The server also checks a conservative encoded MIME estimate against5MiB. [Cloudflare Workers email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
- The HTTP/MCP upload uses base64 JSON, but the final Workers send call receives original bytes as an `ArrayBuffer`. A live recipient download showed that passing a base64 string to the binding delivered the encoded text as the file. Binary content follows Cloudflare's [attachment examples](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/). Local sends need a remote email binding because the local simulator cannot serialize binary attachment content.
- Files belong to saved drafts/messages. Upload creates an immutable object and CAS-appends its metadata; remove/discard must win the draft revision before cleanup. Send retains references on the sent row; transport rejection restores the draft. Failed object deletions enter a cron cleanup queue.
- Download reads verify message/attachment membership, return at most256KiB per chunk, and require the same administrator permission as mail. Browser downloads use an octet-stream Blob, never a public file URL. Filename and MIME metadata are untrusted and normalized.

HTTP routes are `attachments/upload` (`draftId,filename,mimeType?,contentBase64`), `attachments/remove` (`draftId,attachmentId`), and `attachments/read` (`messageId,attachmentId,offset?,limit?`). `messageId` here is the storage UUID (`id`), not the RFC Message-ID. Read returns `{attachment,contentBase64,offset,nextOffset,done}`. Upload returns `{attachment}`. Responses are wrapped in the host's normal API envelope. All three routes require `plugins:manage`.

MCP exposes `add_draft_attachment`, `remove_draft_attachment`, and `read_attachment`. Use save_draft → add_draft_attachment → send_draft. Get-thread/search results include storage IDs. The existing `mcp:tools:emdash-inbox` scope and host consent gate these tools.

After upgrading, refresh MCP consent in the plugin manager by disabling and re-enabling Inbox's MCP tools. EmDash 0.38 binds consent to the exact tool definitions, including schemas. Changed definitions invalidate previous consent even when the switch still appears enabled; clients then see no Inbox tools until consent is renewed. The 0.9 catalog contains 17 tools; 0.10 adds three delivery-recovery tools (20 total).

Remaining limits: sending is protected against concurrent claims, but crashes or ambiguous provider responses still need a durable delivery journal. Crash-orphan object reconciliation is not implemented; do not run a naive “draft missing means delete files” collector because sends claim/remove the draft before delivery. Very large single conversations and the legacy complete draft/thread reads remain unbounded response sizes. Pagination reduces transferred bodies, but upstream SQL ordering may still need a temporary sort. Exact indexed substring search requires a separate search backend.
