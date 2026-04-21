import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadActions } from "./ThreadActions";
import { ThreadMessage, type ThreadMessageRow } from "./ThreadMessage";
import { SnoozePicker } from "./SnoozePicker";

const API = "/_emdash/api/plugins/emdash-inbox";

// A thread row carries all the fields the sub-components need. Extends the
// basic thread shape with the fields ThreadActions needs (status, pinned).
interface Row {
	id: string;
	data: ThreadMessageRow["data"] & {
		status: "inbox" | "snoozed" | "done" | "archived";
		pinned: boolean;
		messageId: string;
	};
}

interface Props {
	messageId: string;
	debug: boolean;
	onBack: () => void;
}

export function ThreadView({ messageId, debug, onBack }: Props) {
	const [thread, setThread] = React.useState<Row[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [revealedImages, setRevealedImages] = React.useState<Set<string>>(new Set());
	const [snoozingOpen, setSnoozingOpen] = React.useState(false);
	// Gate concurrent bulk calls so a second action can't clobber the first's
	// optimistic state or failure-revert. Action buttons disable while busy.
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		let cancelled = false;
		void (async () => {
			setLoading(true);
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
				if (!cancelled) setThread(data.items);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [messageId]);

	// Bulk action orchestrator. Applies `transform` to every row locally,
	// fires `call` in parallel; reverts just the failed rows on error.
	// Gated by `busy` so two rapid clicks can't race on the same thread's state.
	const bulk = React.useCallback(
		async (
			transform: (r: Row) => Row,
			call: (r: Row) => Promise<void>,
		) => {
			if (busy) return;
			setBusy(true);
			const prev = thread;
			setThread(thread.map(transform));
			try {
				const results = await Promise.allSettled(thread.map(call));
				const failedIds = results
					.map((r, i) => (r.status === "rejected" ? thread[i].id : null))
					.filter((id): id is string => id !== null);
				if (failedIds.length > 0) {
					setThread((curr) =>
						curr.map((m) => (failedIds.includes(m.id) ? prev.find((p) => p.id === m.id)! : m)),
					);
					setError(`Failed to update ${failedIds.length} message(s).`);
				}
			} finally {
				setBusy(false);
			}
		},
		[thread, busy],
	);

	const handlePin = (nextPinned: boolean) =>
		bulk(
			(r) => ({ ...r, data: { ...r.data, pinned: nextPinned } }),
			async (r) => {
				const res = await apiFetch(`${API}/messages/pin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: r.id, pinned: nextPinned }),
				});
				if (!res.ok) throw new Error(`pin ${r.id} failed (${res.status})`);
			},
		);

	const handleStatus = (nextStatus: "inbox" | "done") =>
		bulk(
			(r) => ({ ...r, data: { ...r.data, status: nextStatus } }),
			async (r) => {
				const res = await apiFetch(`${API}/messages/status`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: r.id, status: nextStatus }),
				});
				if (!res.ok) throw new Error(`status ${r.id} failed (${res.status})`);
			},
		);

	const handleSnoozeConfirm = async (iso: string) => {
		setSnoozingOpen(false);
		await bulk(
			(r) => ({ ...r, data: { ...r.data, status: "snoozed" } }),
			async (r) => {
				const res = await apiFetch(`${API}/messages/status`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: r.id, status: "snoozed", snoozeUntil: iso }),
				});
				if (!res.ok) throw new Error(`snooze ${r.id} failed (${res.status})`);
			},
		);
	};

	if (loading) return <div className="p-6 text-muted-foreground">Loading thread…</div>;
	if (error) return (
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

	return (
		<div className="space-y-2">
			<button type="button" onClick={onBack} className="text-sm underline hover:no-underline">
				← Inbox
			</button>
			<ThreadHeader subject={subject} participants={participants} messageCount={thread.length}>
				<ThreadActions
					thread={thread}
					busy={busy}
					onPin={handlePin}
					onStatus={handleStatus}
					onSnooze={() => setSnoozingOpen(true)}
				/>
			</ThreadHeader>
			<div className="relative">
				{thread.map((m) => (
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
				{snoozingOpen && (
					<SnoozePicker
						debug={debug}
						onConfirm={handleSnoozeConfirm}
						onCancel={() => setSnoozingOpen(false)}
					/>
				)}
			</div>
		</div>
	);
}
