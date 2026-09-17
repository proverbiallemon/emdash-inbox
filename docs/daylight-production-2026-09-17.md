# Daylight production rollout — September 17, 2026

Daylight is deployed at `https://pbweb.me/_emdash/admin/plugins/emdash-inbox` on EmDash 0.38.0. The package remains version 0.10.0; this deployment does not constitute a new npm release.

## Reproducible artifact

- Archive: `emdash-inbox-0.10.0-daylight-5a1bc055de.tgz`
- SHA-256: `5a1bc055de44fc062ef3b8660903ab49d023dccee43227b9320a60a38e41af8a`
- Final Worker version: `cd1db83f-a9a3-4d19-8921-ef5989fb3fb2`
- Deployment message: `Inbox: Daylight with protected dashboard navigation`
- Previous production version before Daylight: `198e1ab4-63db-4702-9720-5b1e0eaf6a2f`
- Published client asset: `/_astro/PluginRegistry.CbOH5DP5.js`
- Installed `dist/admin.mjs` SHA-256: `560745e72b9dd3ad8ce71f792f70a198ceafcef0776eb50ef7322a44663cf331`
- Installed `dist/index.mjs` SHA-256: `402bb902b5c92092b0c30da991a5959460c9a0b31c61c49104b723d9ec214cd2`

The host was built and deployed from an isolated copy of the existing PBWeb checkout. All 38 source/public files were verified unchanged against the original checkout and previous deployment source. Only Inbox's dependency entry and resolved package changed. The exact archive, package metadata, lockfile, and installed dependency were synchronized back to the original host checkout. Existing bindings, variables, and cron were preserved; no schema migration or email-routing change was required.

## Validation

- Node 24.19.0; plugin TypeScript passed.
- Full suite: **454 tests in 36 files passed**.
- Native validation built both exports and verified **20 MCP tools / 2 admin pages**.
- Original host integration typecheck: 30 files, no errors, warnings, or hints.
- Host build and initial Wrangler dry-run passed. Final host build and deployment also passed. The existing large-client-chunk advisory remains.
- Final public checks: `/`, `/about`, `/services`, `/work`, `/work/nsnresolve`, `/contact`, `/capability`, `/resume`, `/accessibility` all returned **200**.
- Anonymous requests to Inbox preferences and attachment-read endpoints returned **401**.

## Live acceptance

The existing normal passkey-authenticated production session was used.

- Real inbox and conversation views rendered in the EmDash host.
- Expanded mode filled the available browser viewport; returning to embedded dashboard view preserved the editor.
- Changing Top/Left and full-window preferences while editing retained exact unsaved message text. The saved Left preference persisted after leaving for Dashboard and returning to Inbox.
- A temporary draft addressed to the user's own mailbox was saved, reopened, edited, saved again, and restored after a browser reload. No email was sent.
- A pre-existing synthetic attachment message showed the correct plain-text content through the authenticated preview route. The binary attachment showed the download fallback, and its original-download control was exercised. This check does not independently certify downloaded file bytes; the byte-preservation integration suite covers that contract.
- The deployed Inbox Settings page rendered its configured sender and inbound-secret controls without changing configuration.
- Initial live testing found that EmDash's sidebar could bypass the plugin's unsaved-change guard. Link interception now runs at document capture before the host router. A failing regression reproduced the issue; the fixed regression verifies blocked navigation preserves the editor and allowed navigation reaches the host. Separate checks cover downloads, new tabs, and local anchors.

## Acceptance limits

- The browser automation interface did not reliably expose native JavaScript confirmation dialogs. Live navigation reached the dashboard, but cancellation was not reliably observable; cancellation behavior is verified by the regression suite. Do not count this as a completed manual native-dialog cancellation check.
- Temporary draft cleanup is pending confirmation of the browser's native discard dialog. The temporary draft is `Daylight host verification 20260917`; its saved draft ID is `b639aaa7-94e5-4e7c-a88e-e20582b4aaa0`. No other draft is part of cleanup.
- Real touch-device, browser zoom, and assistive-technology acceptance remain.
- No real send or new MCP authorization was performed for this visual rollout. Existing delivery and attachment behavior is covered by the full integration suite and prior production smoke tests.
- An isolated local host was prepared, but automatic approval review rejected its development authentication shortcut. No bypass was used. Local build checks and normal production authentication supplied the acceptance evidence.

Bundles/highlights, reminders, labels, bulk triage, undo, scheduled sending, signatures, templates, forwarding, and PDF visual previews remain future work in the design specification.
