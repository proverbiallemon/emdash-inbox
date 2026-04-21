import * as React from "react";
import { ThreadMessageBody } from "./ThreadMessageBody";

type Direction = "inbound" | "outbound";

export interface ThreadMessageRow {
	id: string;
	data: {
		direction: Direction;
		from: string;
		to: string;
		subject: string;
		bodyText: string;
		bodyHtml: string | null;
		receivedAt: string;
	};
}

interface Props {
	row: ThreadMessageRow;
	showImages: boolean;
	onRevealImages: () => void;
}

function formatFull(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function ThreadMessage({ row, showImages, onRevealImages }: Props) {
	const m = row.data;
	const counterparty = m.direction === "inbound" ? m.from : `→ ${m.to}`;

	return (
		<div className="border-b last:border-0 py-4">
			<div className="mb-2 flex items-baseline justify-between gap-4 text-sm">
				<span className="font-semibold">{counterparty}</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">
					{formatFull(m.receivedAt)}
				</span>
			</div>
			<ThreadMessageBody
				bodyHtml={m.bodyHtml}
				bodyText={m.bodyText}
				showImages={showImages}
				onRevealImages={onRevealImages}
			/>
		</div>
	);
}
