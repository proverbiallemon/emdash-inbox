import { ProviderDeliveryStatus } from "./ProviderDeliveryStatus";
import type { DeliverySummary } from "../lib/providerDelivery";
import * as React from "react";
import { postInbox } from "../lib/attachmentClient";

interface DeliveryItem {
	providerDelivery?: DeliverySummary | null;
	attemptId: string;
	messageId: string;
	state: "prepared" | "sending" | "accepted" | "uncertain" | "failed" | "sent" | "restored";
	subject: string;
	to: string[];
	createdAt: string;
	updatedAt: string;
	error?: string;
	providerMessageId?: string;
	draftId?: string;
	canResolve: boolean;
}
interface DeliveryPage { items: DeliveryItem[]; cursor?: string; hasMore: boolean }
interface Resolution { attemptId: string; mode: "sent" | "restore" }
const LABELS: Record<DeliveryItem["state"], string> = {
	prepared: "Preparing", sending: "Sending", accepted: "Accepted — mailbox update pending",
	uncertain: "Delivery uncertain", failed: "Delivery failed", sent: "Accepted for delivery", restored: "Restored as draft",
};
const buttonClass = "rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";

export function OutboxView() {
	const [items, setItems] = React.useState<DeliveryItem[]>([]);
	const [cursor, setCursor] = React.useState<string | undefined>();
	const [hasMore, setHasMore] = React.useState(false);
	const [busy, setBusy] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [draftId, setDraftId] = React.useState<string | undefined>();
	const [resolution, setResolution] = React.useState<Resolution | null>(null);
	const [acknowledged, setAcknowledged] = React.useState(false);
	const [providerMessageId, setProviderMessageId] = React.useState("");
	const locked = React.useRef(false);
	const generation = React.useRef(0);

	const load = async (forGeneration: number, nextCursor?: string) => {
		const page = await postInbox<DeliveryPage>("deliveries/list", { limit: 25, cursor: nextCursor });
		if (forGeneration !== generation.current) return;
		setItems(current => nextCursor
			? [...new Map([...current, ...page.items].map(item => [item.attemptId, item])).values()]
			: page.items);
		setCursor(page.cursor); setHasMore(page.hasMore);
	};
	const refresh = React.useCallback(async (reconcile = false, nextCursor?: string) => {
		if (locked.current) return;
		locked.current = true; setBusy(true); setError(null);
		const current = ++generation.current;
		try {
			if (reconcile) {
				const counts = await postInbox<{ recovered: number; restored: number; uncertain: number }>("deliveries/reconcile", {});
				if (current === generation.current) setNotice(`Recovery checked: ${counts.recovered} recovered, ${counts.restored} restored as drafts, ${counts.uncertain} uncertain.`);
			}
			await load(current, nextCursor);
		} catch (caught) {
			if (current === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (current === generation.current) { locked.current = false; setBusy(false); }
		}
	}, []);
	React.useEffect(() => {
		void refresh();
		return () => { generation.current++; locked.current = false; };
	}, [refresh]);

	const chooseResolution = (attemptId: string, mode: Resolution["mode"]) => {
		setResolution({ attemptId, mode }); setAcknowledged(false); setProviderMessageId(""); setError(null);
	};
	const resolve = async () => {
		if (!resolution || !acknowledged || locked.current) return;
		locked.current = true; setBusy(true); setError(null);
		const current = ++generation.current;
		try {
			const result = await postInbox<{ ok: true; draftId?: string; id?: string; threadId?: string }>("deliveries/resolve", {
				attemptId: resolution.attemptId, resolution: resolution.mode,
				...(resolution.mode === "restore" ? { confirmDuplicateRisk: true } : providerMessageId.trim() ? { providerMessageId: providerMessageId.trim() } : {}),
			});
			if (current !== generation.current) return;
			setNotice(result.draftId ? "Draft restored. Review it before deciding whether to send again." : "Recorded as sent. No email was sent by this action.");
			setDraftId(result.draftId); setResolution(null);
			await load(current);
		} catch (caught) {
			if (current === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (current === generation.current) { locked.current = false; setBusy(false); }
		}
	};

	return <section aria-label="Outbox deliveries" className="space-y-4">
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div><h2 className="text-xl font-semibold">Outbox</h2><p className="text-sm text-muted-foreground mt-1">Track delivery and recover interrupted sends. Refresh and resolution actions do not send email.</p></div>
			<button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh(true)}>Refresh and reconcile</button>
		</div>
		{notice && <div role="status" className="rounded border p-3 text-sm">{notice}{draftId && <> <a className="underline" href={`/_emdash/admin/plugins/emdash-inbox?status=drafts&compose=${encodeURIComponent(draftId)}`}>Open restored draft</a></>}</div>}
		{error && <p role="alert" className="rounded border border-destructive/50 p-3 text-sm text-destructive">{error}</p>}
		{busy && <p role="status" className="text-sm text-muted-foreground">Updating Outbox…</p>}
		{!busy && !error && items.length === 0 && <p className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">No deliveries need attention.</p>}
		{items.map(item => <article key={item.attemptId} className="rounded-lg border p-4 space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium break-words">{item.subject || "(no subject)"}</h3><span className="rounded bg-muted px-2 py-1 text-xs">{LABELS[item.state]}</span></div>
			<p className="text-sm break-words">To: {item.to.join(", ") || "(no recipients)"}</p>
			<ProviderDeliveryStatus delivery={item.providerDelivery} />
			<p className="text-xs text-muted-foreground">Updated {new Date(item.updatedAt).toLocaleString()}</p>
			{item.state === "uncertain" && <p className="text-sm">The provider may have accepted this email. Check its delivery logs or ask the recipient before choosing a resolution.</p>}
			{item.state === "accepted" && <p className="text-sm">The provider accepted this email and its receipt is saved. The mailbox update still needs recovery. Use Refresh and reconcile; do not send it again.</p>}
			{item.state === "accepted" && item.error === "accepted_message_changed" && <p className="text-sm">The saved message changed before recovery could finish. Its accepted receipt is retained for review.</p>}
			{item.error && <p className="text-sm text-muted-foreground">{item.error}</p>}
			{item.providerMessageId && <p className="text-xs break-all">Provider Message-ID: {item.providerMessageId}</p>}
			{item.draftId && (item.state === "failed" || item.state === "restored") && <a className="inline-block text-sm underline" href={`/_emdash/admin/plugins/emdash-inbox?status=drafts&compose=${encodeURIComponent(item.draftId)}`}>Open draft</a>}
			{item.canResolve && item.state === "uncertain" && (resolution?.attemptId === item.attemptId ? <div className="rounded border bg-muted/30 p-3 space-y-3">
				<p className="text-sm">{resolution.mode === "restore" ? "Restoring unlocks an editable draft. It does not send email. Sending that draft later may deliver a duplicate." : "Record this email as sent only after verifying delivery with the provider or recipient. This action does not send email."}</p>
				{resolution.mode === "sent" && <label className="block text-xs font-medium">Provider Message-ID (optional)<input type="text" className="mt-1 block w-full rounded border px-2 py-1 text-sm" disabled={busy} value={providerMessageId} onChange={event => setProviderMessageId(event.target.value)} /></label>}
				<label className="flex gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />{resolution.mode === "restore" ? "I understand that sending this draft again could deliver a duplicate." : "I have verified that this email was sent."}</label>
				<div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy || !acknowledged} onClick={() => void resolve()}>{resolution.mode === "restore" ? "Restore draft" : "Record as sent"}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setResolution(null)}>Cancel</button></div>
			</div> : <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => chooseResolution(item.attemptId, "sent")}>Confirm sent</button><button type="button" className={buttonClass} disabled={busy} onClick={() => chooseResolution(item.attemptId, "restore")}>Restore as draft</button></div>)}
		</article>)}
		{hasMore && <button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh(false, cursor)}>Load more deliveries</button>}
	</section>;
}
