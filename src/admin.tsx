import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";
import { FilterTabs, type StatusFilter, type TabId } from "./components/FilterTabs";
import { ThreadCard } from "./components/ThreadCard";
import { PageSession } from "./lib/pageSession";
import type { ThreadSummary } from "./lib/threadSummary";
import { SnoozePicker } from "./components/SnoozePicker";
import { DateBuckets } from "./components/DateBuckets";
import { EmptyState } from "./components/EmptyState";
import { SkeletonList } from "./components/SkeletonList";
import { ThreadView } from "./components/ThreadView";
import { SettingsPage } from "./components/SettingsPage";
import { ComposeView } from "./components/ComposeView";
import { DraftCard, type DraftListItem } from "./components/DraftCard";

const API = "/_emdash/api/plugins/emdash-inbox";

function readStatusFromUrl(): TabId {
	const s = new URLSearchParams(window.location.search).get("status");
	return s === "snoozed" || s === "done" || s === "all" || s === "drafts" ? s : "inbox";
}

function readMessageFromUrl(): string | null {
	return new URLSearchParams(window.location.search).get("message");
}

function readDebugFromUrl(): boolean {
	return new URLSearchParams(window.location.search).get("debug") === "1";
}

function readComposeFromUrl(): string | null {
	return new URLSearchParams(window.location.search).get("compose");
}

function writeUrl(status: TabId, messageId: string | null, composeId: string | null) {
	const url = new URL(window.location.href);
	if (status === "inbox") url.searchParams.delete("status");
	else url.searchParams.set("status", status);
	if (messageId) url.searchParams.set("message", messageId);
	else url.searchParams.delete("message");
	if (composeId) url.searchParams.set("compose", composeId);
	else url.searchParams.delete("compose");
	window.history.replaceState({}, "", url.toString());
}

function InboxPage() {
	const [status, setStatus] = React.useState<TabId>(readStatusFromUrl);
	const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(readMessageFromUrl);
	const [composeId, setComposeId] = React.useState<string | null>(readComposeFromUrl);
	const viewId = `${status}|${selectedMessageId ?? ""}|${composeId ?? ""}`;
	const viewRef = React.useRef(viewId);
	viewRef.current = viewId;
	const [rows, setRows] = React.useState<ThreadSummary[]>([]);
	const [drafts, setDrafts] = React.useState<DraftListItem[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [snoozingThread, setSnoozingThread] = React.useState<ThreadSummary | null>(null);
	const [busyThreadIds, setBusyThreadIds] = React.useState<Set<string>>(new Set());
	const debug = React.useMemo(readDebugFromUrl, []);
	const pages = React.useRef(new PageSession<ThreadSummary>());
	const pageGeneration = React.useRef(0);
	const [cursor, setCursor] = React.useState<string | undefined>();
	const [hasMore, setHasMore] = React.useState(false);
	const [loadingMore, setLoadingMore] = React.useState(false);
	const [indexing, setIndexing] = React.useState(false);

	const refetch = React.useCallback(async (forStatus: StatusFilter, nextCursor?: string, append = false) => {
		const generation = append ? pageGeneration.current : (pageGeneration.current = pages.current.reset());
		if (append) setLoadingMore(true); else { setLoading(true); setRows([]); setHasMore(false); }
		setError(null);
		setIndexing(false);
		try {
			for (let attempt = 0; attempt < 20; attempt++) {
				const res = await apiFetch(`${API}/threads/list`, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: forStatus, limit: 25, cursor: nextCursor }),
				});
				const data = await parseApiResponse<{ items: ThreadSummary[]; cursor?: string; hasMore: boolean; indexing?: boolean }>(res, "Failed to load messages");
				if (!pages.current.current(generation)) return;
				setIndexing(Boolean(data.indexing));
				if (data.indexing) {
					if (attempt === 19) throw new Error("Mailbox indexing is still in progress. Use Refresh to continue.");
					await new Promise(resolve => setTimeout(resolve, 350));
					if (!pages.current.current(generation)) return;
					continue;
				}
				const items = pages.current.accept(generation, data.items, append);
				if (items) setRows(items);
				setCursor(data.cursor); setHasMore(data.hasMore);
				break;
			}
		} catch (err) {
			if (pages.current.current(generation)) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (pages.current.current(generation)) { setLoading(false); setLoadingMore(false); }
		}
	}, []);

	const refetchDrafts = React.useCallback(async () => {
		const generation = pageGeneration.current = pages.current.reset();
		setLoading(true);
		setError(null);
		setIndexing(false);
		try {
			const res = await apiFetch(`${API}/messages/drafts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			const data = await parseApiResponse<{ items: DraftListItem[] }>(res, "Failed to load drafts");
			if (pages.current.current(generation)) setDrafts(data.items);
		} catch (err) {
			if (pages.current.current(generation)) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (pages.current.current(generation)) setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		writeUrl(status, selectedMessageId, composeId);
		if (!selectedMessageId && composeId === null) {
			status === "drafts" ? void refetchDrafts() : void refetch(status);
		}
			return () => { pages.current.reset(); };
	}, [status, selectedMessageId, composeId, refetch, refetchDrafts]);

	const handleOpen = (openMessageId: string) => setSelectedMessageId(openMessageId);
	const handleBack = () => setSelectedMessageId(null);

	const actOnThread = async (summary: ThreadSummary, action: Record<string, unknown>) => {
		if (busyThreadIds.has(summary.id)) return;
		const actionView = viewRef.current;
		setBusyThreadIds(s => new Set(s).add(summary.id));
		setError(null);
		try {
			const res = await apiFetch(`${API}/threads/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: summary.threadId, ...action }) });
			await parseApiResponse(res, "Failed to update thread");
			if (status !== "drafts" && viewRef.current === actionView) await refetch(status);
		} catch (err) { if (viewRef.current === actionView) setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusyThreadIds(s => { const next = new Set(s); next.delete(summary.id); return next; }); }
	};
	const handlePinToggle = (summary: ThreadSummary, pinned: boolean) => actOnThread(summary, { action: "pin", pinned });
	const handleDone = (summary: ThreadSummary) => actOnThread(summary, { action: "status", status: "done" });
	const handleSnoozeConfirm = async (snoozeUntil: string) => {
		const summary = snoozingThread; setSnoozingThread(null);
		if (summary) await actOnThread(summary, { action: "status", status: "snoozed", snoozeUntil });
	};

	if (composeId !== null) {
		return (
			<div className="space-y-6">
				<ComposeView
					key={composeId}
					draftId={composeId === "new" ? null : composeId}
					onClose={() => {
						setComposeId(null);
						status === "drafts" ? void refetchDrafts() : void refetch(status);
					}}
				/>
			</div>
		);
	}

	if (selectedMessageId) {
		return (
			<div className="space-y-6">
				<ThreadView messageId={selectedMessageId} debug={debug} onBack={handleBack} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between">
				<div>
					<h1 className="text-3xl font-bold">Inbox</h1>
					<p className="text-muted-foreground mt-1">
						All messages that passed through this site.
					</p>
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						className="text-sm px-4 py-2 rounded bg-primary text-primary-foreground hover:opacity-90"
						onClick={() => setComposeId("new")}
					>
						✉ New email
					</button>
					<a
						href="/_emdash/admin/plugins/emdash-inbox/settings"
						className="text-sm px-3 py-2 rounded border hover:bg-muted"
						title="Inbox Settings"
					>
						⚙ Settings
					</a>
				</div>
			</div>

			<div className="flex items-center justify-between gap-3">
				<FilterTabs current={status} onChange={setStatus} />
				<button type="button" className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" disabled={loading} onClick={() => status === "drafts" ? void refetchDrafts() : void refetch(status)}>Refresh</button>
			</div>

			{indexing && <p role="status" className="text-sm text-muted-foreground">Updating the mailbox index…</p>}
			{error && (
				<div className="p-3 rounded-lg border border-destructive/50 bg-destructive/5 text-sm text-destructive">
					{error}
				</div>
			)}

			{status === "drafts" ? (
				loading ? (
					<SkeletonList />
				) : drafts.length === 0 ? (
					<div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
						No drafts. Start one with “New email”.
					</div>
				) : (
					<div className="space-y-2">
						{drafts.map((d) => (
							<DraftCard key={d.id} draft={d} onOpen={(id) => setComposeId(id)} />
						))}
					</div>
				)
			) : loading ? (
				<SkeletonList />
			) : rows.length === 0 && !error && !indexing ? (
				<EmptyState status={status} />
			) : (
				<div className="relative">
					<DateBuckets
						rows={rows}
						field={status === "snoozed" ? "snoozeUntil" : "sortAt"}
						direction={status === "snoozed" ? "future" : "past"}
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
					{hasMore && <button type="button" disabled={loadingMore} className="mt-4 rounded border px-4 py-2 text-sm disabled:opacity-50" onClick={() => void refetch(status, cursor, true)}>{loadingMore ? "Loading…" : "Load more conversations"}</button>}
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
	"/": InboxPage,
	"/settings": SettingsPage,
};
