# Daylight accessibility and interaction review

September 17, 2026. Targeted review against WCAG 2.1 AA, plus a 44px mobile target goal. This covers the implemented mail interface, with the real TipTap editor and synthetic mailbox data in the local browser preview.

## Findings addressed

| Finding | Change | Verification |
| --- | --- | --- |
| Native confirmation popups interrupted the mail flow | Daylight dialogs for leaving unsaved compose/reply and deleting drafts; link editing also uses a Daylight dialog | Cancel preserves the editor; accepted leave preserves saved drafts; explicit discard targets only the chosen draft; real link insertion verified |
| Initial focus could land on the close icon | Destructive confirmations focus **Keep editing**; link editing focuses **Link address** | Fresh browser-load focus inspection |
| Tab could escape the last native dialog control | Explicit Tab/Shift-Tab wrapping between visible controls | Browser verification in both directions, plus a failing-then-passing regression |
| Muted text fell below 4.5:1 on tinted cards | Darkened the shared muted-text token from `#60718c` to `#596c87` | Ratios below, calculated from final tokens |
| Form boundaries were too faint | Added `#7d8a9e` for input/editor outlines, retaining pale decorative separators | Control outlines exceed 3:1 against white and canvas |
| Three shortcut columns became difficult to read at 320px | Compact rows below 420px; heading can wrap separately from New message below 360px | 320px and 390px emulated browser viewports; no horizontal overflow inside Inbox |
| Some mobile controls were under the chosen 44px target | Increased key navigation, compose, footer, attachment and dialog controls | DOM geometry inspection and screenshots |
| Conversation buttons omitted useful nonvisual context | Added descriptions with sender, unread count, message count, pinned state and time | Accessible DOM inspection; no full message body in the button description |
| Accepted New message could retain the previous composer | A new compose instance is allocated after confirmation | Regression covers cancel, clearing recipients/subject, and avoiding the previous saved-draft association |
| Historical search matches opened hidden | Expand earlier messages when the requested message is historical | Regression verifies matching content in open history |

## Contrast

| Foreground / background | Ratio | Target | Result |
| --- | ---: | ---: | --- |
| Muted text / selected blue | 4.696:1 | 4.5:1 | Pass |
| Muted text / apricot | 4.797:1 | 4.5:1 | Pass |
| Muted text / mint | 4.780:1 | 4.5:1 | Pass |
| Form outline / white | 3.499:1 | 3:1 | Pass |
| Form outline / canvas | 3.235:1 | 3:1 | Pass |
| White / primary blue | 5.757:1 | 4.5:1 | Pass |
| White / destructive red | 7.003:1 | 4.5:1 | Pass |

The text threshold follows [WCAG contrast minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html). The 44px touch target is an additional goal; [WCAG 2.1 target size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html) is Level AAA, not an AA requirement.

## Keyboard and state

- Confirmation: Keep editing receives focus; Tab and Shift-Tab wrap; Escape cancels; focus returns to the invoking control; editor content remains intact.
- Link editor: the address input receives focus; saving applies a link to the selected real editor text; Escape restores the toolbar without closing compose. Source review also exercised unsafe-scheme rejection and removing a link with the real TipTap editor.
- Native modal behavior prevents interaction with the background. The implementation follows the [WAI modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- Host links wait for the asynchronous confirmation. Downloads, new tabs and same-page anchors retain their normal behavior.
- Pending, uncertain and unconfirmed delivery states remain protected when clicking the selected conversation or changing reply mode.
- A second destination cannot queue behind an existing confirmation, and removing an editor cancels its suspended operation.
- Closing or reloading the browser tab retains the native `beforeunload` warning. A page cannot substitute an asynchronous custom dialog at that boundary.

## Scope still requiring manual acceptance

Physical touch devices, VoiceOver/NVDA output, and browser-chrome zoom at 200% were not exercised. The viewport, accessible DOM, contrast calculations, keyboard checks and integration tests above are the recorded evidence; this report is not a full WCAG conformance assessment.
