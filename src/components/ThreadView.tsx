import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadActions } from "./ThreadActions";
import { ThreadMessage, type ThreadMessageRow } from "./ThreadMessage";
import { SnoozePicker } from "./SnoozePicker";
import { ReplyCompose, type ReplyComposeDefaults } from "./ReplyCompose";
import { replyDefaults } from "../lib/replyDefaults";
import { deriveReplyAll } from "../lib/recipients";
import { Dialog } from "../daylight/Dialog";
import { useMailNavigation } from "../daylight/navigation";

const API = "/_emdash/api/plugins/emdash-inbox";

// A thread row carries all the fields the sub-components need. Extends the
// basic thread shape with the fields ThreadActions needs (status, pinned),
// plus the M8 multi-recipient fields (toAll/cc) and threadId used for
// reply-all prefill and save-draft threading.
interface Row {
	id: string;
	data: ThreadMessageRow["data"] & {
		status: "inbox" | "snoozed" | "done" | "archived";
		pinned: boolean;
		messageId: string;
		toAll?: string[];
		cc?: string[];
		threadId: string | null;
	};
}

interface Props {
	messageId: string;
	debug: boolean;
	onBack: () => void;
	onRead?: (threadId: string) => void;
	onChanged?: () => void;
	senderAddress?: string;
}

export function ThreadView({ messageId, debug, onBack, onRead, onChanged, senderAddress }: Props) {
	const allow = useMailNavigation("replace");
	const [thread, setThread] = React.useState<Row[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [revealedImages, setRevealedImages] = React.useState<Set<string>>(new Set());
	const [snoozingOpen, setSnoozingOpen] = React.useState(false);
	const [historyOpen, setHistoryOpen] = React.useState(false);
	// Gate concurrent bulk calls so a second action can't clobber the first's
	// optimistic state or failure-revert. Action buttons disable while busy.
	const [busy, setBusy] = React.useState(false);
	// null = closed; "reply" prefills to the latest message's sender only;
	// "reply-all" additionally prefills cc via deriveReplyAll.
	const [replyMode, setReplyMode] = React.useState<"reply" | "reply-all" | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const onReadRef = React.useRef(onRead);
	onReadRef.current = onRead;

	const loadThread = React.useCallback(async (refresh = false) => {
		// Keep an open reply (including its delivery lock) mounted while
		// refreshing the authoritative rows after a thread action.
		if (!refresh) setLoading(true);
		setError(null);
		try {
			const res = await apiFetch(`${API}/messages/thread`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: messageId }),
			});
			const data = await parseApiResponse<{ items: Row[] }>(
				res,
				"Failed to load thread",
			);
			setThread(data.items);
			if (!refresh) setHistoryOpen(data.items.slice(0, -1).some(message => message.id === messageId));
			if (data.items[0]) onReadRef.current?.(data.items[0].data.threadId ?? data.items[0].data.messageId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [messageId]);

	React.useEffect(() => {
		void loadThread();
	}, [loadThread]);

	const actOnThread = async (action: Record<string, unknown>) => {
		if (busy || !thread.length) return;
		setBusy(true);
		try {
			const threadId = thread[0].data.threadId ?? thread[0].data.messageId;
			const res = await apiFetch(`${API}/threads/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId, ...action }) });
			await parseApiResponse(res, "Failed to update thread");
			await loadThread(true);
			onChanged?.();
		} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	};
	const handlePin = (pinned: boolean) => actOnThread({ action: "pin", pinned });
	const handleStatus = (status: "inbox" | "done") => actOnThread({ action: "status", status });

	const handleReply = async () => { if (replyMode !== "reply" && await allow()) setReplyMode("reply"); };
	const handleReplyAll = async () => { if (replyMode !== "reply-all" && await allow()) setReplyMode("reply-all"); };
	const handleReplySent = async () => {
		setReplyMode(null);
		setNotice("Reply accepted for delivery.");
		await loadThread();
		onChanged?.();
	};
	const handleReplyDiscard = () => setReplyMode(null);

	const handleSnoozeConfirm = async (snoozeUntil: string) => {
		setSnoozingOpen(false);
		await actOnThread({ action: "status", status: "snoozed", snoozeUntil });
	};

	if (loading) return <div className="p-6 text-muted-foreground">Loading thread…</div>;
	if (error && thread.length === 0) return (
		<div className="space-y-3">
			<button type="button" onClick={onBack} className="text-sm underline hover:no-underline">
				← Inbox
			</button>
			<div className="p-3 rounded-lg border border-destructive/50 bg-destructive/5 text-sm text-destructive">
				{error}
			</div>
		</div>
	);
	if (thread.length === 0) return (
		<div className="space-y-3">
			<button type="button" onClick={onBack} className="text-sm underline hover:no-underline">
				← Inbox
			</button>
			<div className="text-muted-foreground">Thread not found.</div>
		</div>
	);

	const subject = thread[0].data.subject;
	const participants = Array.from(
		new Set(
			thread.flatMap((m) =>
				m.data.direction === "inbound" ? [m.data.from] : [m.data.to],
			),
		),
	);

	// Anchor for reply defaults: prefer the latest INBOUND row so replying
	// prefills to the customer, not to ourselves when the newest row in the
	// thread happens to be our own outbound message. Falls back to the literal
	// last row only for outbound-only threads — mirrors replySend's rule on
	// the server (src/lib/composeOps.ts).
	const anchor = [...thread].reverse().find((r) => r.data.direction === "inbound") ?? thread[thread.length - 1];

	// Reply defaults for the plain Reply button — replies only to the anchor
	// message's sender/recipient, quoting its body.
	const buildReplyDefaults = (): ReplyComposeDefaults => {
		return replyDefaults({
			direction: anchor.data.direction,
			from: anchor.data.from,
			to: anchor.data.to,
			subject: anchor.data.subject,
			bodyText: anchor.data.bodyText,
			bodyHtml: anchor.data.bodyHtml,
			receivedAt: anchor.data.receivedAt,
		});
	};

	// Reply-all defaults: to/cc come from deriveReplyAll (client-side prefill;
	// the server refilters regardless), subject/quoteHtml are shared with the
	// plain Reply button. Sender address for the "minus my address" filter is
	// approximated from any outbound row's `from` in this thread.
	const buildReplyAllDefaults = (): ReplyComposeDefaults => {
		const ownAddress = senderAddress || thread.find((r) => r.data.direction === "outbound")?.data.from || "";
		const all = deriveReplyAll(
			{
				direction: anchor.data.direction,
				from: anchor.data.from,
				to: anchor.data.to,
				toAll: anchor.data.toAll,
				cc: anchor.data.cc,
			},
			ownAddress,
		);
		const base = buildReplyDefaults();
		return { to: all.to.join(", "), cc: all.cc.join(", "), subject: base.subject, quoteHtml: base.quoteHtml };
	};

	return (
		<div className="space-y-2">
			<button type="button" onClick={onBack} className="text-sm underline hover:no-underline">
				← Inbox
			</button>
			{error && <div role="alert" className="p-3 rounded-lg border border-destructive/50 bg-destructive/5 text-sm text-destructive">{error}</div>}
			{notice && <p role="status" className="dl-notice">{notice}</p>}
			<ThreadHeader subject={subject} participants={participants} messageCount={thread.length}>
				<ThreadActions
					thread={thread}
					busy={busy}
					onReply={handleReply}
					onReplyAll={handleReplyAll}
					onPin={handlePin}
					onStatus={handleStatus}
					onSnooze={() => setSnoozingOpen(true)}
				/>
			</ThreadHeader>
			<div className="relative">
				{thread.length > 1 && <details className="dl-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>{thread.length - 1} earlier {thread.length === 2 ? "message" : "messages"} · Show conversation</summary><div className="dl-history-content">{thread.slice(0, -1).map(m => <ThreadMessage key={m.id} row={m} showImages={revealedImages.has(m.id)} onRevealImages={() => setRevealedImages(current => new Set(current).add(m.id))} />)}</div></details>}
				{thread.slice(-1).map((m) => (
					<ThreadMessage
						key={m.id}
						row={m}
						showImages={revealedImages.has(m.id)}
						onRevealImages={() =>
							setRevealedImages((s) => {
								const next = new Set(s);
								next.add(m.id);
								return next;
							})
						}
					/>
				))}
				{replyMode !== null && thread.length > 0 && (
						<ReplyCompose
						key={replyMode}
						defaults={replyMode === "reply-all" ? buildReplyAllDefaults() : buildReplyDefaults()}
						inReplyTo={thread[thread.length - 1].data.messageId}
						threadId={thread[0].data.threadId}
						onSent={handleReplySent}
						onDiscard={handleReplyDiscard}
						onSaved={() => setNotice("Reply saved in Drafts.")}
					/>
				)}
				{snoozingOpen && (
					<Dialog title="Come back to this" onClose={() => setSnoozingOpen(false)}>
					<SnoozePicker
						debug={debug}
						onConfirm={handleSnoozeConfirm}
						onCancel={() => setSnoozingOpen(false)}
					/>
					</Dialog>
				)}
			</div>
		</div>
	);
}
