# Rich signatures production rollout — September 24, 2026

Rich email signatures are deployed on PBWeb with EmDash 0.38.0. The plugin remains version 0.10.0; this is a pinned development artifact, not a new npm release.

## Deployed artifact

- Source commit: `a2b7bcc` (`codex/email-signatures`).
- Archive: `emdash-inbox-0.10.0-signatures-b7b06e4bf6.tgz`.
- Archive SHA-256: `b7b06e4bf6ba79dbea91be3dd04727bbc2e5ca8dc8fdb141e00dcdf06ee3933e`.
- Worker version: `e8c77951-5b1c-4ada-8dba-66bbaa969175`, serving 100% of traffic.
- Previous Worker version: `4e257660-4ad2-407c-a10e-fc29451b69a0`.
- Deployment: September 24, 2026 at 17:37 UTC.
- Client asset: `/_astro/PluginRegistry.CY10KmLa.js`.
- Installed `dist/index.mjs` SHA-256: `f083e26890a4770bb566ebb4ab99d9bc083a109e6e4d49748dbafb1d26d1ce3c`.
- Installed `dist/admin.mjs` SHA-256: `feee85347f7c23cb48724929d7ad319771dc097446f81abc7adebc04baf2262c`.

The current PBWeb host was copied into an isolated build directory, then updated with the exact archive. All 54 source/public files remained byte-identical. The deployed archive, dependency metadata, lockfile, and installed plugin were synchronized back to the PBWeb checkout. Remote bindings and runtime settings matched the previous deployment, with only the deployment annotation changed. Both custom domains and the every-minute cron were retained. No database migration, mail-routing change, or inbound Worker deployment was required.

## Verification

- Implementation validation: 566 tests across 46 files passed, TypeScript passed, and native validation checked both exports, 20 MCP tools, and two admin pages.
- Host validation on Node 24.15.0: 40 files checked with zero errors, warnings, or hints; voice lint, production build, and Wrangler dry run passed. The existing large-client-chunk build advisory remains.
- Nine public pages and both PDF downloads returned HTTP 200 after deployment.
- Anonymous same-origin POSTs to `signature/get`, `signature/save`, and `bundles/overview` returned HTTP 401. Requests without the required Origin header were rejected earlier with HTTP 403.
- The existing authenticated admin session loaded the rich signature editor. A temporary signature with Georgia, 18px blue text, and an inline PNG was saved on the live host. Opening a new message retrieved the persisted formatting and the logo with its 100px width and description.
- The untouched composer closed without saving a draft or sending mail. The temporary signature was cleared and saved, restoring the original empty signature and both original inclusion choices.

Recipient-side rendering and real email delivery were not re-tested in this rollout. Local native-route tests verify inline MIME parts, matching Content-IDs, exact image bytes, preserved stored HTML, and idempotent send replay. Cross-client font rendering, physical touch devices, and assistive-technology acceptance remain unverified.
