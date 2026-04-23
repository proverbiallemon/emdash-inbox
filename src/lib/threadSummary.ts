import type { MessageDoc } from "../index";
import { deriveParticipantChips, type ParticipantChip } from "./participantChips";

export type StatusFilter = "inbox" | "snoozed" | "done" | "all";

export interface ThreadSummary {
	id: string;
	threadId: string;
	openMessageId: string;
	latest: MessageDoc;
	previous: MessageDoc | null;
	messageCount: number;
	unreadCount: number;
	messageIds: string[];
	participants: ParticipantChip[];
	pinned: boolean;
	sortAt: string;
	snoozeUntil: string | null;
}

interface MessageRow {
	id: string;
	data: MessageDoc;
}

/**
 * Group messages by threadId, derive a summary per thread, filter by latest-
 * message status, sort with pinned threads floating to top within the result
 * window. Latest-message-wins is the rule for tab placement (M6 design §1).
 *
 * Snoozed-tab sort is by latest.snoozeUntil ascending (matches the per-message
 * behavior from M3). Other tabs sort by latest.sortAt descending.
 *
 * Pure function — no I/O. Test surface is small and easy to assert on.
 */
export function aggregateThreads(
	messages: MessageRow[],
	filter: StatusFilter,
	senderAddress: string,
): ThreadSummary[] {
	// Group by threadId. Defensive fallback to messageId for the (post-M4
	// shouldn't-happen) case where threadId is null.
	const byThread = new Map<string, MessageRow[]>();
	for (const r of messages) {
		const tid = r.data.threadId ?? r.data.messageId;
		const bucket = byThread.get(tid);
		if (bucket) {
			bucket.push(r);
		} else {
			byThread.set(tid, [r]);
		}
	}

	// Build summaries.
	const summaries: ThreadSummary[] = [];
	for (const [tid, group] of byThread) {
		// Sort each thread's messages by receivedAt ascending.
		const sorted = [...group].sort((a, b) =>
			a.data.receivedAt < b.data.receivedAt ? -1 : a.data.receivedAt > b.data.receivedAt ? 1 : 0,
		);

		const latest = sorted[sorted.length - 1];
		const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

		summaries.push({
			id: tid,
			threadId: tid,
			openMessageId: latest.id,
			latest: latest.data,
			previous: previous ? previous.data : null,
			messageCount: sorted.length,
			unreadCount: sorted.filter((r) => r.data.read === false).length,
			messageIds: sorted.map((r) => r.id),
			participants: deriveParticipantChips(
				sorted.map((r) => r.data),
				senderAddress,
			),
			pinned: sorted.some((r) => r.data.pinned),
			sortAt: latest.data.sortAt,
			snoozeUntil: latest.data.snoozeUntil,
		});
	}

	// Filter by latest-message status.
	const filtered =
		filter === "all"
			? summaries
			: summaries.filter((s) => s.latest.status === filter);

	// Sort.
	const sortField: "sortAt" | "snoozeUntil" = filter === "snoozed" ? "snoozeUntil" : "sortAt";
	const direction: 1 | -1 = filter === "snoozed" ? 1 : -1;

	filtered.sort((a, b) => {
		const av = a[sortField] ?? "";
		const bv = b[sortField] ?? "";
		if (av === bv) return 0;
		return av < bv ? -1 * direction : 1 * direction;
	});

	// Pinned floats to top within the result window (post-sort pass, matches
	// the existing per-message behavior in messages/list).
	filtered.sort((a, b) => {
		if (a.pinned && !b.pinned) return -1;
		if (!a.pinned && b.pinned) return 1;
		return 0;
	});

	return filtered;
}
