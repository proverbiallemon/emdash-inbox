import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";
import { FilterTabs, type StatusFilter } from "./components/FilterTabs";
import { ThreadCard } from "./components/ThreadCard";
import type { ThreadSummary } from "./lib/threadSummary";
import { SnoozePicker } from "./components/SnoozePicker";
import { DateBuckets } from "./components/DateBuckets";
import { EmptyState } from "./components/EmptyState";
import { SkeletonList } from "./components/SkeletonList";
import { ThreadView } from "./components/ThreadView";

const API = "/_emdash/api/plugins/emdash-inbox";

function readStatusFromUrl(): StatusFilter {
	const s = new URLSearchParams(window.location.search).get("status");
	return s === "snoozed" || s === "done" || s === "all" ? s : "inbox";
}

function readMessageFromUrl(): string | null {
	return new URLSearchParams(window.location.search).get("message");
}

function readDebugFromUrl(): boolean {
	return new URLSearchParams(window.location.search).get("debug") === "1";
}

function writeUrl(status: StatusFilter, messageId: string | null) {
	const url = new URL(window.location.href);
	if (status === "inbox") url.searchParams.delete("status");
	else url.searchParams.set("status", status);
	if (messageId) url.searchParams.set("message", messageId);
	else url.searchParams.delete("message");
	window.history.replaceState({}, "", url.toString());
}

function InboxPage() {
	const [status, setStatus] = React.useState<StatusFilter>(readStatusFromUrl);
	const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(readMessageFromUrl);
	const [rows, setRows] = React.useState<ThreadSummary[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [snoozingThread, setSnoozingThread] = React.useState<ThreadSummary | null>(null);
	const [busyThreadIds, setBusyThreadIds] = React.useState<Set<string>>(new Set());
	const debug = React.useMemo(readDebugFromUrl, []);

	const refetch = React.useCallback(async (forStatus: StatusFilter) => {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch(`${API}/messages/list`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: forStatus }),
			});
			const data = await parseApiResponse<{ items: ThreadSummary[] }>(
				res,
				"Failed to load messages",
			);
			setRows(data.items);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		writeUrl(status, selectedMessageId);
		if (!selectedMessageId) void refetch(status);
	}, [status, selectedMessageId, refetch]);

	const handleOpen = (openMessageId: string) => setSelectedMessageId(openMessageId);
	const handleBack = () => setSelectedMessageId(null);

	// Fan out a thread-scope action across summary.messageIds. Optimistic UI
	// (apply transform immediately), then run the per-message API calls in
	// parallel; revert just the thread on full failure.
	const fanOut = React.useCallback(
		async (
			summary: ThreadSummary,
			transform: (s: ThreadSummary) => ThreadSummary,
			call: (messageId: string) => Promise<void>,
		) => {
			if (busyThreadIds.has(summary.id)) return;
			setBusyThreadIds((s) => new Set(s).add(summary.id));
			const prev = rows;
			setRows((list) => list.map((r) => (r.id === summary.id ? transform(r) : r)));
			try {
				const results = await Promise.allSettled(summary.messageIds.map(call));
				const failedCount = results.filter((r) => r.status === "rejected").length;
				if (failedCount > 0 && failedCount === summary.messageIds.length) {
					setRows(prev);
					setError(`Failed to update thread (${failedCount}/${summary.messageIds.length} messages).`);
				} else if (failedCount > 0) {
					setError(`Partial update: ${failedCount}/${summary.messageIds.length} messages failed.`);
				}
			} finally {
				setBusyThreadIds((s) => {
					const next = new Set(s);
					next.delete(summary.id);
					return next;
				});
			}
		},
		[rows, busyThreadIds],
	);

	const handlePinToggle = (summary: ThreadSummary, next: boolean) =>
		fanOut(
			summary,
			(s) => ({ ...s, pinned: next }),
			async (id) => {
				const res = await apiFetch(`${API}/messages/pin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, pinned: next }),
				});
				if (!res.ok) throw new Error(`pin ${id} failed (${res.status})`);
			},
		);

	const handleDone = (summary: ThreadSummary) =>
		fanOut(
			summary,
			(s) => ({ ...s, latest: { ...s.latest, status: "done" } }),
			async (id) => {
				const res = await apiFetch(`${API}/messages/status`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, status: "done" }),
				});
				if (!res.ok) throw new Error(`status ${id} failed (${res.status})`);
			},
		);

	const handleSnoozeConfirm = async (iso: string) => {
		const summary = snoozingThread;
		setSnoozingThread(null);
		if (!summary) return;
		await fanOut(
			summary,
			(s) => ({ ...s, latest: { ...s.latest, status: "snoozed", snoozeUntil: iso } }),
			async (id) => {
				const res = await apiFetch(`${API}/messages/status`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, status: "snoozed", snoozeUntil: iso }),
				});
				if (!res.ok) throw new Error(`snooze ${id} failed (${res.status})`);
			},
		);
	};

	if (selectedMessageId) {
		return (
			<div className="space-y-6">
				<ThreadView messageId={selectedMessageId} debug={debug} onBack={handleBack} />
			</div>
		);
	}

	const bucketField: "sortAt" | "snoozeUntil" = status === "snoozed" ? "snoozeUntil" : "sortAt";
	const bucketDirection = status === "snoozed" ? "future" : "past";

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-3xl font-bold">Inbox</h1>
				<p className="text-muted-foreground mt-1">
					All messages that passed through this site.
				</p>
			</div>

			<FilterTabs current={status} onChange={setStatus} />

			{error && (
				<div className="p-3 rounded-lg border border-destructive/50 bg-destructive/5 text-sm text-destructive">
					{error}
				</div>
			)}

			{loading ? (
				<SkeletonList />
			) : rows.length === 0 ? (
				<EmptyState status={status} />
			) : (
				<div className="relative">
					<DateBuckets
						rows={rows}
						field={bucketField}
						direction={bucketDirection}
						renderRow={(row) => (
							<ThreadCard
								key={row.id}
								row={row}
								busy={busyThreadIds.has(row.id)}
								onOpen={handleOpen}
								onPinToggle={handlePinToggle}
								onDone={handleDone}
								onSnoozeRequest={(s) => setSnoozingThread(s)}
							/>
						)}
					/>
					{snoozingThread && (
						<SnoozePicker
							debug={debug}
							onConfirm={handleSnoozeConfirm}
							onCancel={() => setSnoozingThread(null)}
						/>
					)}
				</div>
			)}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": InboxPage as unknown as PluginAdminExports["pages"][string],
};
