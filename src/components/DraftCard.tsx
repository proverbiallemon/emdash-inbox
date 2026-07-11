import * as React from "react";

export interface DraftListItem {
	id: string;
	to: string[];
	subject: string;
	snippet: string;
	updatedAt: string;
	threadId: string | null;
}

interface Props {
	draft: DraftListItem;
	onOpen: (draftId: string) => void;
}

export function DraftCard({ draft, onOpen }: Props) {
	const recipients = draft.to.length > 0 ? draft.to.join(", ") : "(no recipients)";
	const updated = new Date(draft.updatedAt).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return (
		<button
			type="button"
			onClick={() => onOpen(draft.id)}
			className="w-full text-left border rounded-lg p-4 hover:bg-muted/50 transition-colors"
		>
			<div className="flex items-baseline justify-between gap-4">
				<span className="text-sm font-medium truncate">{recipients}</span>
				<span className="text-xs text-muted-foreground shrink-0">{updated}</span>
			</div>
			<div className="text-sm font-semibold mt-1">{draft.subject}</div>
			{draft.snippet !== "" && (
				<div className="text-sm text-muted-foreground truncate mt-0.5">{draft.snippet}</div>
			)}
		</button>
	);
}
