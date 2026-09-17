# Daylight implementation handoff

Status: core mail UI deployed on PBWeb from `codex/daylight-mail-ui` on September 17, 2026. Baseline is EmDash 0.38.0 and Inbox 0.10.0. No new npm release has been published. See the [production rollout report](daylight-production-2026-09-17.md) for the exact artifact and acceptance evidence.

## Approved direction

[Daylight design and mail flows](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=30-412) use Manrope, a pale blue canvas, cobalt actions, white conversation surfaces, and apricot/mint shortcuts. Top navigation is the default; Left navigation is an account preference.

[Interactive design prototype](https://www.figma.com/proto/WLQW6Xb9GEjPqCxq6iabg0?node-id=30-412&page-id=30%3A411&starting-point-node-id=30%3A412&scaling=scale-down). The Figma review guide is node `84:3089`; the conversation screens live on page `30:411`. The design contains future tools as well as the implemented slice.

## Coverage

| Surface | Figma node(s) | Implementation | Verification | Remaining gap |
| --- | --- | --- | --- | --- |
| Main inbox, Top navigation | 30:412 | Daylight shell, greeting, dates, unread states, functional folder shortcuts | Local desktop browser inspection; existing mailbox tests | Highlights remain future. Bundles are deployed as the addition below. Shortcuts open Pinned, Snoozed, and Drafts. |
| M9.1 bundles | Page 100:411 | Grouped Inbox, manual correction, exact-sender rules, settings, durable completion and results; mobile bottom navigation | 541 automated tests, typecheck/native validation, Top/Left and 390/320px browser checks; live correction, completion and preference checks | Physical assistive-technology acceptance remains |
| Left navigation / appearance | 37:1539 | Account-scoped Top/Left preference; responsive fallback | Live preference persisted across dashboard return; layout switch retained unsaved draft text; isolation and failed-save tests | Real touch-device acceptance |
| Expanded Inbox | Inbox layout states | Stable portal host fills the browser viewport; dashboard return link; restores background state on exit | Live expanded/embedded round trip; draft DOM identity, modal reopening, inert/scroll restoration tests | Small-screen browser chrome acceptance |
| Read thread / history | 68:412, 74:2519, 76:959 | Desktop split pane, narrow thread page, recipient details, collapsed earlier messages, pin/done/snooze | Desktop and 390px container inspection; existing thread-action tests | No new threading semantics |
| Compose / reply / reply all | 70:542, 73:679, 82:1148, 82:1400, 77:984 | Real TipTap editor, formatting, CC/BCC for new mail, self-address filtering for reply-all, explicit save and discard | Real editor in local browser; dirty-navigation and existing compose/delivery regressions | Autosave, signatures, templates, forward, and scheduling remain future |
| Drafts | 79:1051 | Existing save/resume/delete operations with updated presentation | Existing attachment/draft tests; local sample draft save | No silent background autosave |
| Attachments | 68:2336, 80:1061, 82:1125 | Authenticated chunked download; image/plain-text modal preview; original download; draft attach/remove | Existing byte/download tests, passive-format validation, browser text preview | PDF visual preview is still a design; PDFs and other types download |
| Send and recovery states | 79:1031, 79:1067, 79:1083, 86:1437 | Accepted-for-delivery notice, durable Outbox status, blocked pending/uncertain sends, retry/recovery semantics preserved | Delivery suite; new pending/uncertain reply-mode lock regressions | No real email sent during this UI work |
| Mobile inbox / navigation | 36:1461 | Drawer navigation, wrapping actions, narrow composer, 44px core action targets | 390px container browser inspection | Real touch device, browser zoom, and assistive-technology acceptance |
| Search and Pinned | Inbox controls | Global subject/body search with resumable scan; indexed pinned-only pagination | Empty search scan, stale response, cursor isolation, 115-thread SQLite fixture | Search is substring matching, not full-text ranking or advanced filters |
| Future mail tools | Figma future-tool states | Retained in design only | Design review only | Highlights, reminders, labels, undo, scheduled sending and writing tools need separately scoped functionality |

## Implementation details

- `src/admin.tsx` owns the mailbox workspace; `src/daylight/` contains the shell, preference hook, safe preview, navigation guards, and scoped styles.
- `ui/preferences` and `ui/preferences-save` are private plugin routes requiring `plugins:manage`. Saved layout keys come from the authenticated EmDash user, never a body-supplied identity. Token-only visits can change layout for the visit without writing another user's preference.
- `messages/search` exposes the existing search operation to the private UI. Pinned-only queries bound the existing indexed sort key, preserving pagination without a schema migration or in-memory page filtering.
- Expanded mode moves one portal host between the plugin slot and `document.body`. The editor stays mounted; native dialogs reopen after the move. It fills the browser window without requiring the browser Fullscreen API.
- Left navigation collapses to Top below 1050px of available plugin width and to a drawer below 700px. These are container queries, so the embedded EmDash sidebar is accounted for.
- The native plugin entrypoint embeds its scoped CSS, icon data, and font. It needs no external stylesheet/font request.
- Existing HTML sanitization and remote-image gating are preserved. Attachment preview accepts plain text and signature-checked PNG/JPEG/GIF/WebP only. HTML/SVG are never injected, and generated object URLs are revoked on close. Downloads keep the original authenticated octet-stream path.
- Pending, uncertain, and unconfirmed delivery attempts remain protected. Leaving to review Outbox is allowed; replacing a reply with another reply mode cannot remove its lock.
- Explicit save remains the product behavior. Plugin navigation and page links (including EmDash's own sidebar) ask before abandoning unsaved changes, and in-flight mutations prevent navigation. New-tab links and downloads remain usable. The existing send/recipient validation remains authoritative.
- Confirmation and link-editing popups use Daylight dialogs with named actions, focus restoration, and explicit Tab wrapping. Closing/reloading a browser tab still uses its native warning. The [accessibility and interaction review](daylight-accessibility-2026-09-17.md) records contrast, keyboard, mobile and recovery checks.

## Local preview and validation

```sh
pnpm dev:preview
# http://127.0.0.1:4317/
pnpm typecheck
pnpm test
pnpm validate
```

The preview uses the actual admin components with a development-only API adapter. All mail, recipients, attachments, send results, and account settings are synthetic. Bundle-operation and correction state can persist in browser storage for reload-recovery checks; **Reset sample mail** restores the fixture. The adapter makes no network requests. It is not included in the published package files.

Checks on September 16, 2026:
- TypeScript passed.
- Full suite: 450 tests across 36 files passed.
- Final delivery-lock change: both affected suites passed (29 tests, including two newly added pending/uncertain regressions). Total suite inventory is now 452 tests.
- Native validation built both exports and verified 20 MCP tools / 2 admin pages.
- Browser checks covered Top inbox, Left navigation, expanded mode while editing, desktop thread, 390px inbox/thread/reply/composer, untouched reply closing, draft saving, and text attachment preview. These are local fixture checks, not live mailbox acceptance.
- No production deployment, live mail send, or new MCP consent occurred.

September 17 follow-up: deployed the real host integration, added a regression for EmDash sidebar navigation, and reran the full suite on Node 24.19.0: **466 tests across 37 files passed**. TypeScript, native validation, and the host build passed. See the rollout report for live acceptance and limitations.

## Assets and provenance

Six icons are exact SVG exports from the approved Figma design, embedded in `src/daylight/assets.ts`:

| Icon | Figma export asset |
| --- | --- |
| Search | 5fd2b60a-cb9c-4be2-8d95-c29cecb70d2b |
| Settings | c69ebb72-c310-4ea5-b8c3-b493360ea85e |
| Pin | 50fc0a00-5f29-4197-b6bd-431038166903 |
| Snooze | c07ccae1-a1e9-4a0c-ba76-42885d4b12ce |
| Done | 12e071a0-7f04-4d5e-a02b-fdda15ac70c8 |
| Attachment | eb0fb415-4f2e-4309-913f-dcc8a9d5cb6c |

Export URL form: `https://www.figma.com/api/mcp/asset/<asset-id>.svg`.

M9.1 adds the exact Figma chevron export `10571f81-0530-4c57-aa60-8e570374c68b`, embedded in the bundle styles and rotated for expanded groups.

Manrope is the Google Fonts variable font from [google/fonts](https://github.com/google/fonts/tree/main/ofl/manrope), converted from TTF to WOFF2 without changing glyphs. The embedded WOFF2 is 53,876 bytes. Its SIL Open Font License and copyright are in `src/daylight/Manrope-OFL.txt`.

## Next slice

M9.1 is deployed: see the [bundle rollout report](m9-bundles-production-2026-09-17.md) and [specification](m9-bundles-design.md). The Figma page and implementation cover grouping, corrections, completion and recovery in Top, Left and mobile layouts.

Take on highlights as a separate backend and UI slice; reminders and content linking remain later work. Complete real touch-device and assistive-technology acceptance. Keep future controls in Figma until their behavior exists. PBWeb's checkout pins the exact deployed M9.1 archive.
