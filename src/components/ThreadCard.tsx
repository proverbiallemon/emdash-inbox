import { useId } from "react";
import type { ThreadSummary } from "../lib/threadSummary";
import { Icon } from "../daylight/Icon";
export type ThreadCardRow = ThreadSummary;
interface Props {
 row: ThreadSummary; busy: boolean; selected?: boolean;
 onOpen: (id: string) => void;
 onMove?: (summary: ThreadSummary) => void;
 onPinToggle: (summary: ThreadSummary, pinned: boolean) => void;
 onDone: (summary: ThreadSummary) => void;
 onSnoozeRequest: (summary: ThreadSummary) => void;
}
export function ThreadCard({ row, busy, selected, onOpen, onPinToggle, onDone, onSnoozeRequest, onMove }: Props) {
 const descriptionId = useId();
 const subject = row.latest.subject || "(no subject)";
 const sender = row.participants.map(person => person.label).join(", ") || row.latest.from;
 const date = new Date(row.snoozeUntil ?? row.sortAt);
 const sameDay = date.toDateString() === new Date().toDateString();
 const time = date.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
 return <article className="dl-thread-card" data-read={row.unreadCount === 0} data-selected={selected}>
  <button type="button" className="dl-thread-open" aria-label={`Open ${subject}`} aria-describedby={descriptionId} aria-current={selected ? "true" : undefined} onClick={() => onOpen(row.openMessageId)}>
   <span className="dl-sr-only" id={descriptionId}>{row.unreadCount ? `${row.unreadCount} unread. ` : "Read. "}{sender}. {row.messageCount} {row.messageCount === 1 ? "message" : "messages"}. {row.pinned ? "Pinned. " : ""}{time}.</span>
   <span className="dl-unread-dot" style={{ opacity: row.unreadCount > 0 ? 1 : 0 }} />
   <span className="dl-avatar" aria-hidden="true">{(row.participants[0]?.initial ?? sender.slice(0, 2)).toUpperCase()}</span>
   <span className="dl-sender"><strong>{sender}</strong><small>{row.pinned ? "Pinned · " : ""}{row.messageCount} {row.messageCount === 1 ? "message" : "messages"}</small></span>
   <span className="dl-thread-copy"><strong>{subject}</strong><span>{row.latest.bodyText.replace(/\s+/g, " ").trim().slice(0, 240) || "No preview available"}</span></span>
   <time className="dl-thread-time" dateTime={date.toISOString()}>{time}</time>
  </button>
  <div className="dl-row-actions" aria-label={`Actions for ${subject}`}>
   {onMove && <button type="button" className="dl-icon-button dl-move-button" disabled={busy} aria-label={`Move conversation: ${subject}`} title="Move conversation" onClick={() => onMove(row)}>↪</button>}
   <button type="button" className="dl-icon-button" disabled={busy} aria-label={row.pinned ? "Unpin" : "Pin"} aria-pressed={row.pinned} title={row.pinned ? "Unpin" : "Pin"} onClick={() => onPinToggle(row, !row.pinned)}><Icon name="pin" /></button>
   <button type="button" className="dl-icon-button" disabled={busy} aria-label="Snooze" title="Snooze" onClick={() => onSnoozeRequest(row)}><Icon name="snooze" /></button>
   <button type="button" className="dl-icon-button" disabled={busy} title="Mark done" onClick={() => onDone(row)}><Icon name="done" /><span className="dl-sr-only">✓ Done</span></button>
  </div>
 </article>;
}
