# M9.1 — Daylight bundles

Status: approved and implemented locally on `codex/m9-bundles`, September 17, 2026. PBWeb remains on the deployed Daylight baseline. The prototype and local acceptance preview use synthetic mail.

[Start the prototype](https://www.figma.com/proto/WLQW6Xb9GEjPqCxq6iabg0?node-id=119-3200&page-id=100%3A411&starting-point-node-id=119%3A3200&scaling=scale-down).
[Open the bundled inbox design](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=102-411).

## Scope and direction

This is the first slice of M9: bundle membership, deterministic matching, manual corrections, and bundle triage. Highlights, reminders and content linking remain separate follow-ups; M9 as a whole is not complete.

Daylight retains Manrope, the pale blue canvas, cobalt actions, white conversation surfaces and apricot/mint accents. The default Top navigation and optional Left navigation remain. Pinned, Snoozed and Drafts stay above the inbox as useful shortcuts. The six bundles appear as compact stacks below ordinary conversations, referring to Google Inbox's grouping without introducing a separate category dashboard.

The default is a bundled Inbox with all six categories enabled. All conversations switches to the same Inbox without grouping; it must not silently change to the existing All mail folder. Search remains global and ungrouped.

## Membership and matching

A thread has one assignment: Orders, Shipping, Commissions, Fans, Promos, Updates, or explicitly no bundle. Assignments are independent of read state, pinning and Inbox/Snoozed/Done status. Moving a conversation never marks it read or changes its folder.

| Bundle | Intended matches |
| --- | --- |
| Orders | Purchase confirmations and receipts |
| Shipping | Dispatch, tracking and delivery notices |
| Commissions | Configured project enquiries and commission correspondence |
| Fans | Configured audience/supporter correspondence |
| Promos | Clear offers, discounts and promotional messages |
| Updates | Newsletters and service notifications |

Classification should be conservative and explainable. Use deterministic message evidence and configured sender rules. Commissions and Fans must not guess a sender's relationship from their name or writing style; use configured addresses or known integration metadata. Uncertain mail stays in Conversations.

Precedence:

1. Explicit thread override, including a stored **no bundle** override.
2. Exact-sender rule.
3. Built-in matching.
4. No bundle.

Explicit overrides survive replies and rule changes. Without an override, classify from the newest incoming message with relevant evidence; outgoing replies do not reclassify the conversation. A shipping update can supersede an order receipt in the same thread. Existing latest-message folder placement and threading semantics remain authoritative.

The first implementation should expose the assignment source and matched rule identifier, so the UI can explain why a conversation is grouped. Never let classification failure hide a conversation.

## Inbox behavior

- Ordinary and pinned Inbox conversations remain individually visible. A pin overrides grouped presentation, not the stored assignment.
- Non-pinned Inbox conversations with an enabled assignment appear once in their bundle. Disabled categories appear in Conversations instead. Pinning, snoozing or finishing a conversation recomputes the visible groups and counts.
- Counts represent conversations. A conversation is unread when its existing thread summary has at least one unread message. Neither disclosure nor moving changes that state.
- Bundle previews summarize sender names and conversation count. No extracted delivery dates, totals or receipt cards are promised in this slice.
- Personal rows use existing pinned-first/recent ordering. Bundle order is fixed to Orders, Shipping, Commissions, Fans, Promos, Updates for this first pass; contents use the existing thread ordering.
- Multiple bundles may remain expanded. Expansion is view state, retained while reading a thread and returning to Inbox.
- The same membership appears in Top and Left layouts. Desktop keeps the dashboard return link; mobile retains its bottom navigation and scrollable content.
- Empty bundles normally disappear. If the user just cleared an open bundle, retain its completion state until dismissed. When there are no grouped conversations, show the explanatory empty state while keeping ordinary mail visible.

The synthetic main fixture has 20 Inbox conversations and 12 unread conversations. Orders contains 3 conversations, 2 unread. Moving Paper & Clay to Shipping leaves the total unchanged; Orders becomes 2/1 unread and Shipping becomes 3/2 unread. Clearing Orders leaves 17 Inbox conversations and 10 unread. A partial result with only Paper & Clay remaining leaves 18/11.

## Correcting misplaced mail

Paper & Clay intentionally demonstrates a shipping notice initially placed in Orders.

Open the conversation menu, choose its destination and confirm. **This conversation only** is the default. No bundle is a real destination and a persistent manual override.

The separate future-mail option names the exact normalized address, using synthetic `receipts@paperandclay.example` in the prototype. Opting in saves a sender rule and moves the current conversation. It does not reclassify other existing conversations. A sender rule never overrides another thread's explicit assignment. Multiple rules for the same exact sender must be prevented or explicitly replaced.

Pending saves disable repeat submission. On failure retain the original membership, keep the dialog open and preserve the chosen destination/scope for retry. If moving the conversation succeeds but saving its sender rule fails, report those outcomes separately rather than claiming both succeeded. The two failure cases are specified here; they do not yet have dedicated Figma frames.

The prototype demonstrates moving to Shipping and toggling the future-mail option. Other destinations establish the visual pattern, rather than a fully parameterized prototype.

## Marking a bundle done

The action belongs to the expanded bundle and names its scope, for example **Mark 3 done**. Confirmation repeats the total and unread count and explains that mail remains available in Done.

The server must establish the eligible scope, including unloaded pages. It excludes pinned conversations, drafts, Outbox entries, and conversations outside Inbox. The client must not build a bulk action from only the rendered page.

Use a bounded, resumable operation with an idempotency key and per-conversation outcomes. Membership, pin and latest-message revision must be checked at mutation time. A conversation with new incoming mail after the confirmed snapshot is skipped and remains in Inbox; later arrivals are never swept into an earlier operation.

A full result preserves the open empty bundle with a link to the affected conversations in Done. Marking done does not mark read. Dismissal removes the empty stack and keeps the updated totals.

A partial result states how many succeeded and leaves failures visible. Retrying touches only unresolved eligible conversations and rechecks their revisions. Keeping the remainder in Inbox dismisses the result without reverting successful changes. An unknown response must reconcile the operation before offering another mutation.

General-purpose Undo remains outside M9.1. The Done view is the durable place to find completed mail. The existing thread-status endpoint can be reused for individual operations, but its current behavior is not a substitute for the snapshot-aware bundle operation above.

## Preferences and accessibility

Bundle enablement follows the existing account-scoped preference model. Turning off grouping does not delete assignments or sender rules. Saving settings should preserve the current Top/Left choice. The prototype shows the settings layout and close/save route; it does not simulate arbitrary combinations of six toggles.

Disclosures should use native buttons with `aria-expanded`, `aria-controls`, and accessible names including category, conversation count and unread count. Expanding must not steal focus. After a thread move or bundle completion, restore focus to the next available item or its bundle header and announce the result once.

New action targets are at least 44px. Keep visible focus outlines and do not communicate unread or failure through color alone. Confirmation/correction dialogs inherit Daylight's focus trapping, Escape behavior, cancellation and focus restoration. Long addresses wrap, and mobile content scrolls without hiding the bottom navigation.

## Implementation boundaries

The implementation extends `ThreadSummary`, indexed thread pagination, global search, per-thread actions and Daylight's layout preferences. `src/lib/mailboxStore.ts` contains the thread projection; `src/lib/threadSummary.ts` defines the public summary. The existing `threads/list` and `threads/action` routes remain available.

The backend is split into:

1. `bundles.ts`: versioned assignments and conservative matching. A failed classification is distinct from an ordinary no-match; automatic grouping falls back to Conversations when classification fails.
2. `bundleStore.ts`: durable thread overrides, unique exact-sender rules, whole-mailbox counts and indexed section pages. Sender-rule evidence is recorded at ingestion, so a new rule does not reclassify other historical conversations.
3. `bundleOperations.ts`: owner-scoped preparation, confirmation, bounded execution, status reconciliation and affected-conversation pages. Source revisions and durable outcomes protect against new arrivals and repeat requests.
4. `threadMutation.ts`: ordinary ingestion and triage register an intent before changing eligibility. Bulk completion skips threads with an unresolved intent.

All bundle routes retain `plugins:manage` authorization. Bulk operations additionally require an authenticated user and verify operation ownership. The canonical incoming sender is returned with the summary; future-mail corrections send that displayed address back for validation before saving a rule. A changed sender requires another review rather than silently targeting a different address.

Mailbox and admission backfills advance in bounded pages. Indexing is a loading state, not an empty Inbox. Per-category pages and overview counts come from server projections across the mailbox; the browser does not group only its currently loaded rows.

| Private route | Purpose |
| --- | --- |
| `bundles/overview` | Whole-Inbox totals and per-bundle conversation/unread counts |
| `bundles/list` | A cursor page from Conversations or one category; disabled categories remain in Conversations |
| `bundles/move` | A thread override, with optional future exact-sender rule and explicit conflict replacement |
| `bundles/rules` | Saved sender rules and an explanation of their scope |
| `bundles/done-prepare` | Advance preparation using the same request key until confirmation is ready |
| `bundles/done-run` | Confirm and execute bounded batches; explicitly retry unresolved failures |
| `bundles/done-status` | Read progress and reconcile saved outcomes without completing new mail |
| `bundles/done-threads` | Page through affected conversations, with their current summaries and saved outcomes |

Operation IDs are opaque. A client persists its request key and operation reference under the current account, reconciles an unknown response, and never substitutes a freshly enumerated target list. The confirmed scope includes unloaded pages. Category preferences use the existing authenticated account settings; sender rules and thread assignments belong to the shared mailbox.

### Recovery limits

An interrupted ordinary write or failed intent cleanup can conservatively exclude that conversation from bundle completion until the unresolved intent is diagnosed. There is no age-based deletion: a paused writer might resume. Ordinary reading and individual triage remain available. Logs and the durable intent's ID, thread and timestamp support diagnosis.

Preparation seals bounded pages before exposing confirmation. Overlapping requests replay the same saved page, so a late preparer cannot expand an already confirmed scope. Operation journals currently have no retention policy. Changed sources can be skipped even when they still appear eligible, because their original revision is no longer safe to complete. The affected-conversation list reports the operation's outcome alongside the conversation's current folder; later arrivals or reopening can return completed mail to Inbox. There is no general-purpose Undo.

Automated coverage includes manual no-bundle precedence, outgoing replies, sender-rule opt-in, disabled categories, pinned exclusions, counts across pages, duplicate requests, new-arrival races, partial/unknown results, authentication and preference isolation.

## Local implementation verification

The local preview serves the actual admin components through a synthetic adapter. Use `pnpm dev:preview` (port 4317 by default; this worktree uses 4318). Its scenario selector provides normal, partial, unknown-response, sender-conflict, correction-error, partial-rule-save, settings-error, indexing and overview-error flows. **Reset sample mail** restores the fixture; ordinary refresh retains the synthetic operation so reload recovery can be checked.

Browser acceptance on September 17 covered:

| Flow | Observed result |
| --- | --- |
| Grouped and ungrouped Inbox | All 20 conversations remain in the same Inbox; global search uses ungrouped results |
| Disclosure and read/back | Disclosure preserves unread state; Orders and Shipping stay expanded across reading and returning |
| Paper & Clay correction | Orders 3/2 unread → 2/1; Shipping 2/1 → 3/2; Inbox stays 20/12 |
| Correction failure and sender scope | Destination retained on error; No bundle supported; exact address shown; conflicting future rule needs explicit replacement; moved/rule-failed outcomes reported separately |
| Partial completion | Two Orders done, Paper & Clay stays unread; Inbox becomes 18/11; explicit retry reaches 17/10 |
| Completed results | Actual summaries refresh after reading and folder changes; a read/snoozed conversation retains its saved Marked done outcome while showing Currently snoozed |
| Lost response and reload | Saved operation is reconciled on reload; explicit continuation completes the remaining batch |
| Settings | Failed save preserves edits; saving disabled categories preserves Left navigation; all categories off keeps mail visible with explanatory copy |
| Loading and errors | Indexing and overview failures do not claim the Inbox is empty; Refresh recovers |
| Narrow screens and keyboard | Top/Left desktop and actual 390/320px viewports inspected; new controls at least 44px; bottom navigation visible; wrapped sender address and scrollable dialogs; Tab wrapping and Escape focus restoration exercised |

Final implementation validation at `5c87fb5`: **541 tests across 43 files passed**, TypeScript passed, and native validation built both exports and checked 20 MCP tools / 2 admin pages. Browser follow-up confirmed conversation-only recovery after declining a conflicting sender rule, refreshed operation results after reading/snoozing, and the full-window/dashboard-view round trip. These checks use synthetic mail; no live email was sent and no production deployment occurred. Physical touch-device and screen-reader acceptance remain unverified.

## Figma coverage

File: `WLQW6Xb9GEjPqCxq6iabg0`. New page: `100:411` (Daylight — M9 bundles). Original approved pages were preserved.

The first pass contains **29 screens/dialogs/review frames**, a reusable **six-variant Bundle heading** component set (`101:477`), and **53 explicit navigation links** after removing inherited UI-kit demo interactions. The component variants cover desktop/mobile × collapsed/expanded/empty.

| State | Figma node |
| --- | --- |
| Inbox / Bundles collapsed | [102:411](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=102-411) |
| Inbox / Orders expanded | [105:580](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=105-580) |
| Move conversation / This conversation only | [106:836](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=106-836) |
| Mark bundle done / Confirm | [107:870](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=107-870) |
| Move conversation / Future sender rule | [108:872](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=108-872) |
| Inbox / Conversation moved | [108:933](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=108-933) |
| Inbox / Cleared | [109:1071](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=109-1071) |
| Inbox / Partial failure | [109:1403](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=109-1403) |
| Manage bundles | [111:1441](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=111-1441) |
| How grouping works | [111:1487](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=111-1487) |
| Inbox / Left navigation | [111:1514](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=111-1514) |
| Mobile / Bundles collapsed | [113:1631](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=113-1631) |
| Mobile / Orders expanded | [114:1742](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=114-1742) |
| Mobile / Move conversation | [114:1947](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=114-1947) |
| Inbox / No bundles yet | [115:1919](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=115-1919) |
| Done / Orders after clearing | [115:2151](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=115-2151) |
| Inbox / All conversations | [117:2142](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=117-2142) |
| Inbox / Left Orders expanded | [118:2716](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=118-2716) |
| Mobile / Confirm bundle done | [118:3044](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=118-3044) |
| Mobile / Orders cleared | [118:3061](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=118-3061) |
| Mobile / Conversation moved | [118:3254](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=118-3254) |
| Review guide | [119:3200](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=119-3200) |
| Inbox / After clearing | [120:3227](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=120-3227) |
| Inbox / Partial result kept | [120:3451](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=120-3451) |
| Inbox / Moved with sender rule | [120:3673](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=120-3673) |
| Mobile / After clearing | [120:3775](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=120-3775) |
| Mobile / Move with sender rule | [120:3921](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=120-3921) |
| Inbox / Correction applied | [121:3897](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=121-3897) |
| Mobile / Manage bundles | [122:4019](https://www.figma.com/design/WLQW6Xb9GEjPqCxq6iabg0?node-id=122-4019) |

The primary interactive path covers Top Inbox → Orders expansion → conversation correction or bundle completion → resulting Inbox. Mobile has expansion, correction, confirmation and completion routes. Left has the layout and in-place expansion route. Partial failure and no-bundles states have separate review-guide entries. Existing compose/search/folder controls and non-Orders category disclosures remain contextual.

## Design-pass validation and limits

- Inspected existing components and library availability before extending the file.
- Reused Daylight conversation, shortcut, navigation and button components.
- Added ten small foundation tokens and five Manrope text styles. The new muted/control colors match the deployed contrast corrections; existing concept pages were not recolored.
- Visually inspected the main Inbox, expanded bundle, Left layout and expansion, mobile Inbox and expansion, correction dialogs, completion confirmation, settings, empty state, partial failure and review guide.
- Programmatic inspection found only Manrope text, no missing fonts, no placeholder labels, no overflow in unclipped auto-layout containers, no overlapping top-level design frames and no broken navigation targets.
- Figma navigation targets were validated structurally. Real browser interaction and screen-reader acceptance are still required when implementing the UI.
- No production deployment, mail send, database migration, or application-code change was performed for this design pass.
