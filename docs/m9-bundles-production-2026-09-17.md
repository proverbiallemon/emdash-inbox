# M9.1 bundles production rollout — September 17, 2026

Daylight bundles are deployed at `https://pbweb.me/_emdash/admin/plugins/emdash-inbox` on EmDash 0.38.0. [PR #10](https://github.com/proverbiallemon/emdash-inbox/pull/10) merged as `54ff137d7e3787eee37822a6007f66f94e9fb738`. Inbox remains version 0.10.0; this is a deployment of a pinned development artifact, not a new npm release.

## Reproducible artifact

- Archive: `emdash-inbox-0.10.0-m9-a942c965a9.tgz`
- SHA-256: `a942c965a90a5bfca53f0f624ac9ef093aa14e38e114efc668b39ec982c99e6a`
- Archive source: `d7eab8fbec029e8fbd70b30681b340df97ace956`. The subsequent pre-merge change only extended three existing test timeouts; runtime source is identical.
- Worker version: `d3691c4c-6d94-455f-a0c1-e43f972da01d`, serving 100% of traffic.
- Previous Worker version: `0e15d23c-71c9-49e8-8e3a-98dce130c30d`
- Deployment message: `Inbox: Daylight bundles and resumable completion (PR 10)`
- Client asset: `/_astro/PluginRegistry.BdRTb2pr.js`
- Installed `dist/admin.mjs` SHA-256: `aa8ea73f8528eecdfafca86720a3b3a01cfc0deb31a9077488bf7c65c3b3b11a`
- Installed `dist/index.mjs` SHA-256: `f7147f5ae4350df126df4acaa8e28422dad25c8f4ac78f01bad3c5ebb1dbe3d0`

The host was built in an isolated copy of the current PBWeb checkout. All 38 source/public files matched both the original checkout and the previous rollout. Only the Inbox dependency and its archive changed. The exact archive, package metadata, lockfile and installed dependency were synchronized back to the original checkout. Final remote bindings and runtime settings matched the previous version; the domain and every-minute cron were retained. No core migration, email-routing, DNS or inbound Worker change was made.

## Validation

- The reviewed plugin passed **541 tests across 43 files**, TypeScript and native validation (20 MCP tools / 2 admin pages).
- Both final GitHub checks passed on `448b9dd`: [push](https://github.com/proverbiallemon/emdash-inbox/actions/runs/35199722863) and [pull request](https://github.com/proverbiallemon/emdash-inbox/actions/runs/35199727100).
- An earlier CI run exceeded the default five seconds in three SQLite workload tests, while the same tests passed on the other runner. Those cases now use the existing 15-second allowance; workloads and assertions are unchanged. All 24 mailbox-pagination tests passed locally after the adjustment.
- Host typecheck: 30 files, zero errors, warnings or hints. Voice lint, build and deployment dry run passed. The existing large-client-chunk advisory remains.
- `/`, `/about`, `/services`, `/work`, `/work/nsnresolve`, `/contact`, `/capability`, `/resume` and `/accessibility` returned **200** after deployment.
- Anonymous POSTs to bundle overview, listing and operation-status endpoints returned **401**.

## Live acceptance

The existing passkey-authenticated session was used; no new token or email was created.

- The first load showed bounded indexing explicitly. One Refresh completed the next pass and displayed five Inbox conversations, all read. Bundled Inbox and All conversations retained the same five-conversation scope.
- A pre-existing synthetic attachment-check conversation was moved into Orders, without enabling a future sender rule. Orders showed one conversation, zero unread; the Inbox total stayed five.
- Preparing completion confirmed a scope of exactly that one synthetic conversation. Completion reported one done, and the result list showed the actual conversation with `Marked done · Currently done`.
- The synthetic conversation was reopened and returned to Inbox. The results refreshed to `Marked done · Currently inbox`, retaining the saved outcome separately from current state.
- The result was dismissed, and the synthetic conversation was moved to No bundle. It finished read, unpinned, in Inbox and ordinary Conversations. No sender rule was created; the real pinned conversation was untouched.
- Disabling Updates, saving, reloading and reopening settings retained the choice and Left navigation. Updates was then re-enabled, restoring all six categories. The final Inbox displayed five conversations, zero unread, with no grouped matches.

## Remaining acceptance and follow-ups

Physical touch-device and screen-reader acceptance remain. Partial failures, lost-response recovery, future sender-rule conflicts and concurrent-arrival protection have local/native integration coverage; these failure conditions were not injected into production. Delivery and attachment transport were not re-tested by sending mail during this rollout.

The one-conversation completion confirmation still has plural copy to polish. Recovery tooling for unresolved ordinary-write intents and safe operation-record retention remain follow-ups; see the [bundle specification](m9-bundles-design.md#recovery-limits). Highlights, reminders and content linking remain separate M9 work.
