import { ProviderDeliveryStatus } from "./ProviderDeliveryStatus";
import type { DeliverySummary } from "../lib/providerDelivery";
import * as React from "react";
import { ThreadMessageBody } from "./ThreadMessageBody";
import { AttachmentDownloads } from "./AttachmentDownloads";
import type { PublicAttachment } from "../lib/attachments";
export interface ThreadMessageRow {
 id: string;
 data: {
  providerDelivery?: DeliverySummary | null;
  direction: "inbound" | "outbound"; from: string; to: string; toAll?: string[]; cc?: string[];
  subject: string; bodyText: string; bodyHtml: string | null; receivedAt: string; attachments?: PublicAttachment[];
 };
}
export function ThreadMessage({ row, showImages, onRevealImages }: { row: ThreadMessageRow; showImages: boolean; onRevealImages: () => void }) {
 const m = row.data;
 const sender = m.direction === "outbound" ? "You" : m.from;
 const time = new Date(m.receivedAt);
 return <article className="dl-message">
  <div className="dl-message-heading">
   <span className="dl-avatar" aria-hidden="true">{sender.slice(0, 2).toUpperCase()}</span>
   <div className="dl-message-sender"><strong>{sender}</strong>
    <details className="dl-message-details"><summary>to {m.toAll?.length ? m.toAll.join(", ") : m.to}</summary>
     <dl><dt>From</dt><dd>{m.from}</dd><dt>To</dt><dd>{m.toAll?.length ? m.toAll.join(", ") : m.to}</dd>{!!m.cc?.length && <><dt>Cc</dt><dd>{m.cc.join(", ")}</dd></>}<dt>Sent</dt><dd>{time.toLocaleString()}</dd></dl>
    </details>
   </div>
   <time dateTime={m.receivedAt}>{time.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
  </div>
  {m.direction === "outbound" && <ProviderDeliveryStatus delivery={m.providerDelivery} />}
  <ThreadMessageBody bodyHtml={m.bodyHtml} bodyText={m.bodyText} showImages={showImages} onRevealImages={onRevealImages} />
  <AttachmentDownloads messageId={row.id} attachments={m.attachments ?? []} />
 </article>;
}
