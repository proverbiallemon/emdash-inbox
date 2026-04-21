import * as React from "react";

type Direction = "inbound" | "outbound";
type Status = "inbox" | "snoozed" | "done" | "archived";

export interface MessageCardRow {
	id: string;
	data: {
		direction: Direction;
		from: string;
		to: string;
		subject: string;
		bodyText: string;
		sortAt: string;
		snoozeUntil: string | null;
		status: Status;
		pinned: boolean;
	};
}

interface Props {
	row: MessageCardRow;
	onOpen: (id: string) => void;
	onPinToggle: (id: string, nextPinned: boolean) => void;
	onDone: (id: string) => void;
	onSnoozeRequest: (id: string) => void;
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

export function MessageCard({ row, onOpen, onPinToggle, onDone, onSnoozeRequest }: Props) {
	const m = row.data;
	const counterparty = m.direction === "inbound" ? m.from : `→ ${m.to}`;
	const subject = m.subject || "(no subject)";

	return (
		<div
			className="group relative border rounded-lg pl-4 pr-3 py-3 bg-card hover:bg-muted/30 overflow-hidden cursor-pointer"
			role="button"
			tabIndex={0}
			onClick={() => onOpen(row.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen(row.id);
				}
			}}
		>
			<span className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripClass(m.direction, m.status)}`} />

			<button
				type="button"
				className="absolute top-2 right-2 text-sm"
				onClick={(e) => {
					e.stopPropagation();
					onPinToggle(row.id, !m.pinned);
				}}
				aria-label={m.pinned ? "Unpin" : "Pin"}
				title={m.pinned ? "Pinned — click to unpin" : "Pin"}
			>
				<span className={m.pinned ? "opacity-100" : "opacity-25 group-hover:opacity-50"}>
					📌
				</span>
			</button>

			<div className="flex justify-between items-baseline gap-2 pr-6">
				<span className="text-sm font-semibold truncate">{counterparty}</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">
					{formatWhen(m.status === "snoozed" && m.snoozeUntil ? m.snoozeUntil : m.sortAt)}
				</span>
			</div>
			<div className="text-xs mt-0.5 truncate opacity-90">{subject}</div>
			<div className="text-xs text-muted-foreground mt-1 truncate">{preview(m.bodyText)}</div>

			<div className="mt-2 pt-2 border-t border-dashed flex gap-2 invisible group-hover:visible">
				<button
					type="button"
					className="text-[10px] px-2 py-0.5 border rounded hover:bg-muted"
					onClick={(e) => {
						e.stopPropagation();
						onDone(row.id);
					}}
				>
					✓ Done
				</button>
				<button
					type="button"
					className="text-[10px] px-2 py-0.5 border rounded hover:bg-muted"
					onClick={(e) => {
						e.stopPropagation();
						onSnoozeRequest(row.id);
					}}
				>
					⏰ Snooze
				</button>
			</div>
		</div>
	);
}
