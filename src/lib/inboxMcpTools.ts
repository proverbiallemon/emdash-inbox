import { z } from "zod";

/**
 * Pure-logic tool catalog for the inbox MCP server. Each tool exposes a
 * name, a human-readable description (what the LLM sees), and a zod input
 * schema. The actual execution handlers live in `inboxMcpHandlers.ts` so
 * the catalog stays test-friendly — no DB, no ctx required.
 *
 * When extending the catalog: add the new tool's name to `InboxToolName`,
 * define its input schema below, and append it to `listInboxTools()`.
 * The exhaustive switch in `inboxMcpHandlers.ts` will type-error until
 * you add the handler — that's intentional.
 */

export type InboxToolName =
	| "list_threads"
	| "get_thread"
	| "search_messages"
	| "mark_read"
	| "pin_thread"
	| "snooze_thread"
	| "mark_done";

export interface InboxToolDef<TInput extends z.ZodType = z.ZodType> {
	name: InboxToolName;
	description: string;
	inputSchema: TInput;
}

const statusSchema = z.enum(["inbox", "snoozed", "done"]);

const listThreadsInput = z.object({
	status: statusSchema.optional().describe("Filter by status. Defaults to 'inbox'."),
	limit: z.number().int().positive().max(100).optional().describe("Max threads to return (1-100). Default 25."),
});

const getThreadInput = z.object({
	threadId: z.string().min(1).describe("Thread ID returned by list_threads."),
});

const searchMessagesInput = z.object({
	query: z.string().min(1).describe("Plain-text query matched against message subject and body."),
	limit: z.number().int().positive().max(50).optional().describe("Max matches to return. Default 20."),
});

const markReadInput = z.object({
	threadId: z.string().min(1).describe("Thread to mark read/unread."),
	read: z.boolean().describe("true to mark all messages in the thread read; false to unread."),
});

const pinThreadInput = z.object({
	threadId: z.string().min(1).describe("Thread to pin / unpin."),
	pinned: z.boolean().describe("true to pin (float to top); false to unpin."),
});

const snoozeThreadInput = z.object({
	threadId: z.string().min(1).describe("Thread to snooze."),
	until: z.string().datetime().describe("ISO 8601 timestamp when the thread should resurface in the inbox."),
});

const markDoneInput = z.object({
	threadId: z.string().min(1).describe("Thread to mark done (move out of inbox)."),
});

export function listInboxTools(): InboxToolDef[] {
	return [
		{
			name: "list_threads",
			description:
				"List threads in the inbox, optionally filtered by status (inbox/snoozed/done). Returns thread summaries (id, latest sender, subject, snippet, unread count, message count, sortAt).",
			inputSchema: listThreadsInput,
		},
		{
			name: "get_thread",
			description:
				"Get all messages in one thread, sorted chronologically. Returns full message bodies (text + html), sender, recipient, timestamps. Use this after list_threads or search_messages to read a conversation in full.",
			inputSchema: getThreadInput,
		},
		{
			name: "search_messages",
			description:
				"Plain-text search across message subject and body. Returns matching thread summaries with the matched message highlighted. Useful for finding conversations by topic when you don't know the thread ID.",
			inputSchema: searchMessagesInput,
		},
		{
			name: "mark_read",
			description:
				"Mark every message in a thread as read or unread. Equivalent to opening the thread in the UI (which auto-marks read).",
			inputSchema: markReadInput,
		},
		{
			name: "pin_thread",
			description:
				"Pin or unpin a thread. Pinned threads float to the top of the inbox regardless of date.",
			inputSchema: pinThreadInput,
		},
		{
			name: "snooze_thread",
			description:
				"Snooze a thread until the specified ISO 8601 timestamp. Snoozed threads disappear from the inbox and reappear at the wake time.",
			inputSchema: snoozeThreadInput,
		},
		{
			name: "mark_done",
			description:
				"Move a thread out of the inbox into the Done folder. Equivalent to clicking 'Done' in the UI.",
			inputSchema: markDoneInput,
		},
	];
}
