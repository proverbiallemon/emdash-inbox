import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";
import { FilterTabs, type StatusFilter } from "./components/FilterTabs";
import { MessageCard, type MessageCardRow } from "./components/MessageCard";
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
	const [rows, setRows] = React.useState<MessageCardRow[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [snoozingId, setSnoozingId] = React.useState<string | null>(null);
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
			const data = await parseApiResponse<{ items: MessageCardRow[] }>(
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

	const handleOpen = (id: string) => setSelectedMessageId(id);
	const handleBack = () => setSelectedMessageId(null);

	const handlePinToggle = async (id: string, next: boolean) => {
		setRows((prev) =>
			prev.map((r) => (r.id === id ? { ...r, data: { ...r.data, pinned: next } } : r)),
		);
		try {
			await apiFetch(`${API}/messages/pin`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, pinned: next }),
			});
		} catch (err) {
			setRows((prev) =>
				prev.map((r) => (r.id === id ? { ...r, data: { ...r.data, pinned: !next } } : r)),
			);
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDone = async (id: string) => {
		const prev = rows;
		setRows((list) => list.filter((r) => r.id !== id));
		try {
			await apiFetch(`${API}/messages/status`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, status: "done" }),
			});
		} catch (err) {
			setRows(prev);
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSnoozeConfirm = async (iso: string) => {
		const id = snoozingId;
		setSnoozingId(null);
		if (!id) return;
		const prev = rows;
		setRows((list) => list.filter((r) => r.id !== id));
		try {
			await apiFetch(`${API}/messages/status`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, status: "snoozed", snoozeUntil: iso }),
			});
		} catch (err) {
			setRows(prev);
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// Thread view takes precedence.
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
							<MessageCard
								key={row.id}
								row={row}
								onOpen={handleOpen}
								onPinToggle={handlePinToggle}
								onDone={handleDone}
								onSnoozeRequest={(id) => setSnoozingId(id)}
							/>
						)}
					/>
					{snoozingId && (
						<SnoozePicker
							debug={debug}
							onConfirm={handleSnoozeConfirm}
							onCancel={() => setSnoozingId(null)}
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
