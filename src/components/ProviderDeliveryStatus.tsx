import * as React from "react";
import type { DeliverySummary, RecipientDelivery } from "../lib/providerDelivery";
const labels: Record<RecipientDelivery["status"], string> = {
	delivered: "Delivered", deferred: "Delayed", bounced: "Bounced", failed: "Delivery failed", rejected: "Rejected", complained: "Spam complaint", unconfirmed: "Awaiting delivery confirmation",
};
export function ProviderDeliveryStatus({ delivery }: { delivery?: DeliverySummary | null }) {
	if (!delivery?.recipients.length) return null;
	return <details className="dl-provider-delivery">
		<summary>{delivery.recipients.length === 1 ? labels[delivery.recipients[0].status] : `Delivery: ${delivery.recipients.filter(row => row.status === "delivered").length}/${delivery.recipients.length} accepted by recipient servers`}</summary>
		<p>Delivered means the recipient’s mail server accepted the message. It does not confirm inbox placement or reading.</p>
		<ul>{delivery.recipients.map(row => <li key={row.recipient}><strong>{row.recipient}: {labels[row.status]}</strong>{row.at && <> · <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></>}{row.reason && <div>{row.reason}</div>}{row.status === "unconfirmed" && <div>No provider result is recorded yet. Older messages may predate delivery tracking.</div>}{row.status === "deferred" && <div>The provider is retrying delivery. Do not resend this message.</div>}</li>)}</ul>
	</details>;
}
