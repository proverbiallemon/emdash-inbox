# EmDash 0.38 compatibility and next steps

Reviewed September 16, 2026 against the published `emdash@0.38.0` package and its [tagged upstream source](https://github.com/emdash-cms/emdash/releases/tag/emdash%400.38.0), released September 15. Inbox 0.9.2 is deployed on the PBWeb Cloudflare host, including M8b pagination and private attachments. It has not been published as a plugin release. See the [production smoke-test report](production-smoke-2026-09-16.md) for observed behavior and remaining checks.

## What upstream provides

| Upstream feature | Implication for this project |
| --- | --- |
| Cloudflare's `cloudflare-email` provider sends email. It does not implement a mailbox, inbound storage, threaded conversations, drafts, or this inbox UI. | The plugin still fills a gap. Keep emdash-inbox selected as the exclusive email provider to record outbound messages. |
| EmDash's admin inbox is for comment moderation. | It does not replace the email inbox. |
| Native plugins can register MCP tools with private, permission-gated routes. The host manages transport, scope checks, namespacing, and consent. | Register all 17 inbox tools through native MCP; a custom proxy is no longer required. |
| Plugin storage exposes revision reads and conditional writes/deletes. | Require EmDash 0.38.x and use these operations to prevent overlapping draft sends and stale writes. |

Source: [Cloudflare provider](https://github.com/emdash-cms/emdash/blob/emdash%400.38.0/packages/cloudflare/src/plugins/cloudflare-email.ts), [plugin contracts](https://github.com/emdash-cms/emdash/blob/emdash%400.38.0/packages/core/src/plugins/types.ts), [native MCP discovery and consent](https://github.com/emdash-cms/emdash/blob/emdash%400.38.0/packages/core/src/emdash-runtime.ts), [MCP registration](https://github.com/emdash-cms/emdash/blob/emdash%400.38.0/packages/core/src/mcp/server.ts).

## Review findings addressed

- The legacy proxy accepted anonymous requests and supplied an admin token. It now requires the caller's own Bearer token, preserves authentication failures, and does not read a shared host secret. Existing deployments must replace/remove the old example and revoke that token.
- Hidden external images could still load through `srcset`, CSS and other resource attributes. Email rendering now allows structural formatting and selected attributes, removes source CSS and resource-bearing elements, and derives the reveal banner from sanitized image sources. This intentionally simplifies email styling.
- Draft text edits could retain stale HTML. Text changes now invalidate old HTML, which is regenerated at send time unless updated rich HTML is supplied.
- Server replies to HTML mail invoked a browser-only sanitizer. Server-generated quotes now use escaped plain text; HTML-only originals receive an omission note. The admin composer continues to supply sanitized rich quotes.
- Overlapping draft sends could both deliver. Revision-checked claims now allow one winner; saves/discards reject changed revisions, and failed sends restore their edits only when the row remains absent.
- Historical message migrations no longer rewrite drafts or recreate a concurrently sent/discarded draft from an old scan.
- Sent mail was stored under an invented Message-ID. Complete provider-returned identifiers are now normalized and retained; inbound and outbound messages retain References and replies include that chain. Historical invented IDs cannot be reconstructed automatically.
- Native MCP tools now use EmDash's authenticated endpoint, with `plugins:manage` permission and the `mcp:tools:emdash-inbox` token scope. Tools remain disabled until enabled through the host's consent UI.
- The admin entrypoint now participates in TypeScript checking. All version surfaces agree with the package. Validation checks native package output instead of treating it as a sandbox plugin; CI runs frozen installs, tests, typechecking, and native validation.

Cloudflare controls the delivered Message-ID; the plugin cannot override it through structured send headers. If the transport returns a missing or opaque ID, the sent row retains the original transport value (when present), uses a local identity, and logs that reply correlation is unavailable. It never guesses a provider domain or reports delivery failure after acceptance solely because of that ID. See [Cloudflare header rules](https://developers.cloudflare.com/email-service/reference/headers/) and [Workers send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

## Validation boundaries

The automated suite exercises the installed EmDash package with real migrations, temporary SQLite databases, plugin activation, route dispatch, draft contention, the snooze cron callback, and the published MCP HTTP adapter. Mail transport is mocked; SQL storage and host dispatch are real. The MCP adapter tests explicitly supply host-resolved authentication and plugin consent fixtures; they do not prove an OAuth login or a production consent flow.

A separate production-build smoke test used EmDash 0.38.0, Astro 7.3.2, `@astrojs/node` 11.1.5, `@astrojs/react` 6.0.5, React 19.3.0 and SQLite. The running host verified real personal-token authentication, the admin MCP consent/enable route, runtime discovery of all 14 tools, draft save/list over HTTP, insufficient-scope and editor-role denial, anonymous/invalid-token 401 responses, OAuth discovery metadata, and MCP notification handling. It did not run an interactive OAuth login or render the admin in a browser.

### Astro 7 / Vite 8 host bundling workaround

That host initially built successfully but returned 500 on startup: Kysely's `ImmediateValueTransformer` extended an undefined `OperationNodeTransformer` after bundling. The same failure occurred with emdash-inbox removed. Keeping Kysely external in the host resolved it:

```sh
pnpm add kysely@0.29.6
```

```js
// Merge into the host's astro.config.mjs; keep its other Vite settings.
vite: { ssr: { external: ["kysely"] } }
```

This is a verified Node-host workaround for that dependency combination, not a required change to the plugin or a tested Cloudflare adapter configuration. Recheck when upgrading the host bundler or EmDash.

Sanitizer tests use jsdom and inspect the resulting DOM; they do not prove browser network behavior during parsing. Subsequent production checks exercised the admin in a browser, real Cloudflare delivery, received Message-ID headers, inbound routing, and the deployed scheduled handler; their exact scope is recorded in the production report. The completed automated run passed 215 tests across 20 files on both the local Node 25.4.0 runtime and supported Node 24.15.0 LTS, plus full typechecking, native validation, and a frozen dependency install. The final production host was rebuilt and retested with the same compiled plugin entrypoint as this checkout.

The final M8b follow-up passed 360 tests across 30 files on Node 24.19.0 and verified a recipient-downloaded 512 KiB attachment, private storage isolation, 17-tool MCP discovery, and temporary token revocation. See the production report for the parser and transport defects found and corrected during live verification.

Revision checks prevent simultaneous sends of one stored draft. They do not guarantee exactly-once delivery across process crashes or ambiguous provider failures. A durable delivery journal with reconciliation is a separate reliability improvement.

## Where to pick up

1. Add a durable delivery journal and reconciliation before more automation. Revision claims prevent concurrent duplicate sends, but a crash after provider acceptance can still leave uncertain delivery. Preserve the accepted message identity and attachment references, and expose ambiguous attempts for review instead of blindly retrying.
2. Finish the remaining live checks in the production report: reply-all/CC/BCC and transport rejection followed by draft retry. Repeat an external-user reply with a sender whose provider does not deliver the destination internally.
3. Dogfood the implemented M8b pagination/search and private attachments, then add signatures and undo. The 0.9 implementation handles EmDash's 100-row query cap by following native cursors and paging materialized conversation summaries.
4. Prepare a reviewed GitHub change and versioned plugin release. Start M9 classification, reminders and content linking after those daily-use flows are reliable.

GitHub at review time had M1–M8 merged, no open implementation issues or PRs, and no tagged plugin releases. The README roadmap is the current backlog; the above ordering turns its next milestone into concrete work.
