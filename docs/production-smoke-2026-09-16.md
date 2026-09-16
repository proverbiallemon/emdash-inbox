# Production smoke test — September 16, 2026

**Current result:** PBWeb runs EmDash 0.38.0 with Inbox 0.10.0. Durable send recovery, complete-conversation pagination, private attachments, and all 20 native MCP tools are deployed. The latest live check delivered one synthetic message to the Proton desktop app; replaying its request returned the same attempt and message IDs. All temporary tokens were revoked. The final automated run passed 440 tests across 33 files.

## Initial host upgrade

PBWeb was upgraded from EmDash 0.29.0 to 0.38.0 with the current Inbox 0.8.0 development package. Core and the Cloudflare integration are pinned together. The host vendors the exact Inbox tarball and uses a relative file dependency, so rebuilding does not silently retrieve the old GitHub package.

## Deployment

- Host: `https://pbweb.me`, Cloudflare Worker `pbweb`.
- Deployed version: `798b0062-d870-4c77-a4f1-0c53f4dfc93d`.
- Host retains Astro 7.0.7, Cloudflare adapter 14.1.2, React 19.2.4 and Wrangler 4.110.0. Build and checks use Node 24.19.0.
- All 27 pending core migrations (051–077) applied through the official CLI against its verified target fingerprint. The follow-up check reports no pending or unknown migrations. Existing Inbox message/contact counts were preserved.
- A pre-migration D1 Time Travel bookmark and previous Worker version were recorded privately. SQL export failed because Cloudflare does not export databases containing FTS virtual tables; no tables were removed to work around that limitation.
- The existing encryption key was promoted to a runtime secret, as required since EmDash 0.31. The existing session KV namespace is explicitly pinned. Database, media, email, Worker Loader, and every-minute scheduled-trigger bindings are retained.
- Source integration preserves the host's existing uncommitted content/design work. The focused changes are package metadata/lockfile, the vendored package, and the existing SESSION binding ID.

## Verified behavior

- Host build, typecheck (zero errors/warnings), voice lint, and Wrangler packaging dry-run passed. Nine public pages returned 200 after deployment. Anonymous Inbox access returned 401. Passkey sign-in succeeded and the admin displays version 0.38.0.
- A draft was saved, reopened, revised, and sent from the admin. Proton Mail's desktop app received the final revised body. The draft disappeared after successful sending and one outbound record remained.
- Headers downloaded from Proton confirm that the received RFC Message-ID exactly equals both the provider-returned identifier and Inbox's stored message/thread identity. Delivery came from Cloudflare SMTP.
- An independent, self-addressed SMTP reply sent through Cloudflare reached the existing inbound Worker, was stored as an inbound message, and joined the outbound thread through In-Reply-To/References. The admin rendered both messages together, including the incoming HTML formatting.
- A separate incoming HTML message from an owned test address was opened and replied to through the admin composer. The reply arrived in Proton, remained in the original Inbox thread, and Cloudflare's raw sent message contained the correct In-Reply-To and References values.
- The host had no persisted Inbox activation or snooze task before this check. Disabling and re-enabling Inbox through the plugin manager registered `wake-snoozed-messages` on `*/5 * * * *`; a real scheduled invocation was observed. The plugin remains active.
- Both messages in the first test thread were snoozed until 07:01:03 UTC. The actual scheduled run at 07:05:10 UTC moved both back to `inbox` and cleared their snooze timestamps. No manual cron invocation or database status rewrite was used.
- The plugin manager discovers all 14 native MCP tools. Agent access was initially disabled; the authenticated follow-up below records explicit consent, a real token test, and revocation.

## Provider-routing observation

The initial Proton-to-Inbox test stayed inside Proton: its headers contain `X-Pm-Origin: internal` and end-to-end encryption, and no corresponding Inbox record was created. Proton recognizes the destination as one of its addresses and skips the domain's public Cloudflare route for that delivery. A later Cloudflare SMTP test did traverse the inbound route successfully. No MX records, email-routing rules, or Proton address settings were changed.

This distinction matters when repeating tests: an internally delivered Proton message does not exercise the inbound Worker. The tested SMTP reply used an owned-domain address and supplied reference headers; it is not evidence of a Proton-generated reply traversing that route.

## Checks beyond this live run

- Exercise reply-all/CC/BCC and a transport rejection followed by draft retry. These have automated coverage but were not established by this live run.
- Verify browser network blocking for hostile remote-image markup. The sanitizer's DOM regression tests are passing, but this run does not claim a network trace.

The M8b follow-up adds pagination/search and private attachments. A durable send journal remains separate work for ambiguous delivery failures and crashes.

### Authenticated MCP follow-up (07:21 UTC)

With explicit approval, enabled Inbox's 14 native MCP tools and created a temporary personal access token restricted to `mcp:tools:emdash-inbox` (7-day expiry). The official MCP SDK Streamable HTTP client initialized successfully and listed all 14 namespaced tools. It read the existing two-message synthetic conversation, created/updated/listed a synthetic draft, and discarded it. No email was sent by this test. Anonymous access returned HTTP 401. Revoked the token through admin settings, verified the revoked credential also returns HTTP 401, and removed the temporary local secret. Inbox MCP consent remains enabled; the temporary credential does not.

## M8b deployment and attachment verification

The pagination/private-attachment implementation was initially deployed as Inbox 0.9.0, with a separate private R2 bucket bound as `INBOX_ATTACHMENTS`. The existing public media binding remains separate. Both managed public access and custom bucket domains are disabled. The inbound sidecar now carries raw MIME as base64 bytes and retains its existing Proton forwarding behavior. Email routing and DNS were unchanged.

The first live incoming text attachment exposed a parser defect: postal-mime 2.7.4 converted the 41-byte file to 42 bytes by adding a newline. The independently downloaded Proton copy retained 41 bytes. Local reproductions also showed CRLF normalization in unencoded/quoted-printable files and calendar normalization. This was a release verification failure, not a passing round trip. A targeted check found only the synthetic fixture had received an attachment during that deployment window. Its original MIME remains privately retained; the test row was not silently rewritten.

MCP consent needed renewal after the catalog changed from 14 to 17 tools. EmDash 0.38 compares the exact serialized tool definitions to stored consent, even when the UI switch remains enabled. Disabling and re-enabling through the plugin manager restored discovery for the Inbox-scoped client.

Anonymous access to the attachment route returned 401. The matching object key through the public EmDash media route returned 404, and the disabled R2 managed domain returned 401. The admin displayed the incoming attachment with its filename/size. These checks establish routing/authentication isolation; they are not a broader security audit.

Inbox 0.9.1 bundled the corrected MIME parser. A fresh text/binary SMTP message then matched the privately retained raw MIME byte for byte, independently decoded with Python's email parser. The text file reached Cloudflare ingestion with canonical CRLF (42 bytes), while the REST submission had LF (41 bytes); that normalization occurred before parsing. The binary file remained exactly 8 bytes. The parser no longer adds or normalizes line endings itself.

The recipient-side outgoing check found a second defect: a 512 KiB binary file arrived in Proton as 699,052 bytes of base64 text. Inbox's stored copy and authenticated downloads were correct, so checking those alone would have missed the transport problem. Inbox 0.9.2 passes the original bytes as `ArrayBuffer` to the Workers binding. Only the synthetic test message had sent attachments during the earlier deployment window. The final verification below must compare the downloaded recipient file, not just the stored copy.

### Final 0.9.2 verification (08:18 UTC)

- Host Worker version: `10a297ef-03ba-4c86-a8df-20081a09e5f8`. Byte-preserving inbound sidecar version: `541d28ec-88ec-48c8-ada8-e297dc8f2efe`.
- Deployed package: `emdash-inbox-0.9.2.tgz`, SHA-256 `42be6f915c40f64b78ad98efa97df4325c533ed878c05808b2ec1beb7b77271f`. The host uses the exact vendored tarball as a relative file dependency.
- Node 24.19.0: **360 tests / 30 files passed**, full TypeScript checks, bundled-parser provenance checks, build, and native package validation (17 tools / 2 admin pages). Host install/build and Wrangler dry-run passed before deployment.
- The official MCP SDK initialized with an Inbox-only token, discovered 17 namespaced tools, and paged two conversations plus two distinct continuations. Incoming text/binary attachment downloads matched the independently decoded retained MIME. Public message data did not expose object keys or raw MIME.
- A saved draft accepted the synthetic 512 KiB binary file. Two 256 KiB download chunks matched before sending and on the sent record. The provider Message-ID matched Inbox's stored thread identity. The provider's raw MIME attachment and the actual file downloaded from Proton both matched all 524,288 original bytes: SHA-256 `33bc8aab40703678c3ebe94d2dd8f2afff285dd901f9234e841e4679f8204fd5`.
- Anonymous attachment requests returned HTTP 401; the new file through the public media route returned 404. The admin rendered the file and its size, and showed the attachment picker in the compose UI. Upload/remove/partial-failure UI behavior has automated DOM coverage; this run used MCP for the live upload.
- Revoked the temporary Inbox-scoped token through admin settings, confirmed HTTP 401 with that credential, removed the mode-0600 local token file, and cleared its temporary UI capture. Admin settings shows no remaining personal API tokens. Inbox MCP consent remains enabled.
- Eight public page routes returned 200 after the final deployment. All 38 monitored host source/public files remained byte-identical; public content/design, existing bindings, mail routing, and DNS were preserved.

## Durable send recovery: 0.10.0 verification (08:53 UTC)

- Host Worker version: `67413f26-cb5d-4b8d-a784-675e10cd2ea1`. The inbound sidecar is unchanged from the 0.9.2 verification.
- Deployed package: `emdash-inbox-0.10.0.tgz`, SHA-256 `a2d2a0db0e630737d941faa00d58e4ca9e233a787d9f9a690c49eb98cc501ad2`. The host uses the exact vendored artifact.
- Node 24.19.0: **432 tests / 33 files passed**, TypeScript, bundled-parser provenance checks, package build, and native validation (20 tools / 2 admin pages). Host installation/build and Wrangler dry-run passed before deployment.
- SQLite fault tests cover interrupted preparation, lost write acknowledgements, concurrent request-key claims, uncertain delivery, accepted-receipt projection recovery, final-edit preservation, late receipts racing operator resolution, and discarded-draft resurrection. DOM tests cover lost-response retries, locked composers, missing drafts, and explicit recovery acknowledgement. Faults were injected only locally.
- Refreshed plugin MCP consent and used an Inbox-only temporary token. The SDK discovered 20 tools. Sending a synthetic message produced `deliveryStatus: sent`; replaying the identical request returned the same attempt/message IDs, while reusing the key with a changed subject was rejected.
- The saved provider Message-ID is `<Q3gGPICSeHPE2XcbgOlborZW5IQFr5vbttB6@pbweb.me>`. Inbox returned one message in that thread. Proton desktop search showed one matching conversation and one received body, with the expected synthetic text.
- The deployed Outbox shows Sent and the provider receipt. UI and MCP reconciliation reported zero errors and no unresolved attempts. Delivery summaries omit bodies, BCC, and private object keys. Anonymous delivery-list access returned HTTP 401.
- Revoked `Inbox durable smoke 2026-09-16 temporary`; confirmed HTTP 401 using that credential, removed the local secret, and cleared the temporary browser capture. Admin settings shows no remaining personal API tokens. Inbox MCP consent remains enabled.
- Nine public routes returned HTTP 200. All 38 monitored host source/public files remain byte-identical. Existing bindings, public content/design, mail routing, and DNS are preserved.

The code is on `feature/emdash-038-reliability`; this is a deployed development build, not a published npm/GitHub release. Host integration changes remain separate from its pre-existing content/design changes. Next priorities are signatures and reversible mailbox actions, followed by bundle classification. See [durable-send limits](durable-send-recovery.md#operational-limits): provider acceptance before receipt persistence still requires operator review.

## PR review regressions

Final review found and fixed two additional issues. Thread actions now refresh messages without unmounting an open reply, preserving unsaved edits and delivery retry state; refresh/action errors display inline. Mutations of historical messages now derive their ancestry before marking them migrated, so snooze wake and pin actions during an unfinished backfill preserve conversation membership.

Six DOM regression cases and two native SQLite cases failed before these fixes and passed afterward. The full run passed **440 tests / 33 files**, TypeScript checks, and native package validation. The 08:53 deployment evidence above predates these two fixes.
