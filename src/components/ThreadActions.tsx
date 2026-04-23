import * as React from "react";

type Status = "inbox" | "snoozed" | "done" | "archived";

export interface ThreadActionsRow {
	id: string;
	data: {
		status: Status;
		pinned: boolean;
	};
}

interface Props {
	thread: ThreadActionsRow[];
	/** Disable buttons while a bulk action is in flight. */
	busy?: boolean;
	onReply: () => void;
	onPin: (nextPinned: boolean) => void;
	onStatus: (nextStatus: "inbox" | "done") => void;
	onSnooze: () => void;
}

export function ThreadActions({ thread, busy, onReply, onPin, onStatus, onSnooze }: Props) {
	const allPinned = thread.every((m) => m.data.pinned);
	const allDone = thread.every((m) => m.data.status === "done");
	const btnClass =
		"text-xs px-3 py-1 border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";

	return (
		<div className="flex gap-2 pt-3">
			<button
				type="button"
				className={btnClass}
				disabled={busy}
				onClick={onReply}
			>
				↩ Reply
			</button>
			<button
				type="button"
				className={btnClass}
				disabled={busy}
				onClick={() => onPin(!allPinned)}
			>
				{allPinned ? "📌 Unpin thread" : "📌 Pin thread"}
			</button>
			<button
				type="button"
				className={btnClass}
				disabled={busy}
				onClick={() => onStatus(allDone ? "inbox" : "done")}
			>
				{allDone ? "↩ Move to inbox" : "✓ Mark done"}
			</button>
			<button
				type="button"
				className={btnClass}
				disabled={busy}
				onClick={onSnooze}
			>
				⏰ Snooze thread
			</button>
		</div>
	);
}
