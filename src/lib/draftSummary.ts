import type { MessageDoc } from "../index";

/**
 * Pure mapping from a stored draft row to the shape the drafts list UI (and
 * the MCP `list_drafts` tool) render. No I/O, no ctx — keeps the recipient
 * fallback and snippet truncation rules unit-testable independent of storage.
 */

export interface DraftSummary {
	id: string;
	to: string[];
	subject: string;
	snippet: string;
	updatedAt: string;
	threadId: string | null;
}

export function draftSummaryOf(row: { id: string; data: MessageDoc }): DraftSummary {
	const d = row.data;
	return {
		id: row.id,
		to: d.toAll ?? (d.to ? [d.to] : []),
		subject: d.subject.trim() === "" ? "(no subject)" : d.subject,
		snippet: d.bodyText.replace(/\s+/g, " ").trim().slice(0, 120),
		updatedAt: d.sortAt,
		threadId: d.threadId,
	};
}
