import * as React from "react";
import type { ThreadSummary } from "../lib/threadSummary";

type Direction = "inbound" | "outbound";
type Status = "inbox" | "snoozed" | "done" | "archived";

export type ThreadCardRow = ThreadSummary;

interface Props {
	row: ThreadSummary;
	/** True while a fan-out action against this thread is in flight. Disables
	 *  hover buttons + pin to prevent a second click racing the rollback. */
	busy: boolean;
	onOpen: (openMessageId: string) => void;
	onPinToggle: (summary: ThreadSummary, nextPinned: boolean) => void;
	onDone: (summary: ThreadSummary) => void;
	onSnoozeRequest: (summary: ThreadSummary) => void;
}

function stripClass(direction: Direction, status: Status): string {
	if (status === "snoozed") return "bg-amber-500";
	if (status === "done") return "bg-muted-foreground";
	return direction === "inbound" ? "bg-emerald-500" : "bg-sky-500";
}

function formatWhen(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function preview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
}

const MAX_VISIBLE_CHIPS = 3;

export function ThreadCard({ row, busy, onOpen, onPinToggle, onDone, onSnoozeRequest }: Props) {
	const latest = row.latest;
	const previous = row.previous;
	const subject = latest.subject || "(no subject)";
	const isUnread = row.unreadCount > 0;

	const visibleChips = row.participants.slice(0, MAX_VISIBLE_CHIPS);
	const overflowCount = Math.max(0, row.participants.length - MAX_VISIBLE_CHIPS);
	const namesLine = row.participants.map((p) => p.label).join(", ");

	const dateIso = latest.status === "snoozed" && latest.snoozeUntil ? latest.snoozeUntil : latest.sortAt;

	// Look up the previous message's sender label from the already-derived
	// participants list so it matches the chip treatment (e.g. "pocketbear"
	// instead of "you"). Falls back to from-local-part if the lookup misses
	// (shouldn't happen — every message contributes a chip).
	const previousLabel = (() => {
		if (!previous) return null;
		if (previous.direction === "outbound") {
			return row.participants.find((p) => p.isYou)?.label ?? "you";
		}
		const fromLocal = previous.from.toLowerCase().split("@")[0] || previous.from;
		return row.participants.find((p) => !p.isYou && p.label === fromLocal)?.label ?? fromLocal;
	})();

	return (
		<div
			className="group relative border rounded-lg pl-4 pr-3 py-3 bg-card hover:bg-muted/30 overflow-hidden cursor-pointer"
			role="button"
			tabIndex={0}
			onClick={() => onOpen(row.openMessageId)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen(row.openMessageId);
				}
			}}
		>
			<span className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripClass(latest.direction, latest.status)}`} />

			<button
				type="button"
				className="absolute top-2 right-2 text-sm"
				disabled={busy}
				onClick={(e) => {
					e.stopPropagation();
					onPinToggle(row, !row.pinned);
				}}
				aria-label={row.pinned ? "Unpin" : "Pin"}
				title={row.pinned ? "Pinned — click to unpin" : "Pin"}
			>
				<span className={row.pinned ? "opacity-100" : "opacity-25 group-hover:opacity-50"}>
					📌
				</span>
			</button>

			<div className="flex justify-between items-baseline gap-2 pr-6">
				<span className={`text-sm truncate ${isUnread ? "font-semibold" : "font-medium text-muted-foreground"}`}>
					{visibleChips.map((c, i) => (
						<span
							key={`${c.label}-${i}`}
							className={`inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded mr-1 align-middle ${c.isYou ? "bg-blue-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"}`}
							title={c.label}
						>
							{c.initial}
						</span>
					))}
					{overflowCount > 0 && (
						<span className="inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded mr-1 align-middle bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
							+{overflowCount}
						</span>
					)}
					{namesLine}
					{row.messageCount >= 2 && (
						<span
							className={`inline-block text-[10px] px-1.5 py-0.5 rounded ml-1.5 align-middle ${isUnread ? "bg-blue-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"}`}
							title={isUnread ? `${row.unreadCount} unread of ${row.messageCount}` : `${row.messageCount} messages`}
						>
							{row.messageCount}
						</span>
					)}
				</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">
					{formatWhen(dateIso)}
				</span>
			</div>

			<div className={`text-xs mt-0.5 truncate ${isUnread ? "font-semibold opacity-100" : "opacity-90"}`}>{subject}</div>
			<div className="text-xs text-muted-foreground mt-1 truncate">{preview(latest.bodyText)}</div>
			{previous && (
				<div className="text-xs text-muted-foreground/70 mt-0.5 truncate">
					↳ {previousLabel} · {preview(previous.bodyText)}
				</div>
			)}

			<div className="mt-2 pt-2 border-t border-dashed flex gap-2 invisible group-hover:visible">
				<button
					type="button"
					className="text-[10px] px-2 py-0.5 border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={busy}
					onClick={(e) => {
						e.stopPropagation();
						onDone(row);
					}}
				>
					✓ Done
				</button>
				<button
					type="button"
					className="text-[10px] px-2 py-0.5 border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={busy}
					onClick={(e) => {
						e.stopPropagation();
						onSnoozeRequest(row);
					}}
				>
					⏰ Snooze
				</button>
			</div>
		</div>
	);
}
