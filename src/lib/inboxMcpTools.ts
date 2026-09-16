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
	| "mark_done"
	| "compose_email"
	| "reply_to_thread"
	| "reply_all_to_thread"
	| "save_draft"
	| "list_drafts"
	| "send_draft"
	| "discard_draft"
	| "add_draft_attachment"
	| "remove_draft_attachment"
	| "read_attachment";

export interface InboxToolDef<TInput extends z.ZodType = z.ZodType> {
	name: InboxToolName;
	description: string;
	inputSchema: TInput;
}

const statusSchema = z.enum(["inbox", "snoozed", "done", "all"]);

const listThreadsInput = z.object({
	status: statusSchema.optional().describe("Filter by status. Defaults to 'inbox'."),
	limit: z.number().int().positive().max(100).optional().describe("Max threads to return (1-100). Default 25."),
	cursor: z.string().min(1).max(4096).optional().describe("Continuation from the previous page, keeping the same status filter."),
});

const getThreadInput = z.object({
	threadId: z.string().min(1).describe("Thread ID returned by list_threads."),
});

const searchMessagesInput = z.object({
	query: z.string().min(1).max(1000).describe("Plain-text query matched against message subject and body."),
	limit: z.number().int().positive().max(50).optional().describe("Max matches to return. Default 20."),
	cursor: z.string().min(1).max(4096).optional().describe("Continuation from the previous search page, keeping the same query."),
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

const recipientField = z
	.union([z.string(), z.array(z.string())])
	.describe("One address, a comma-separated list, or an array of addresses.");

const composeEmailInput = z.object({
	to: recipientField,
	cc: recipientField.optional(),
	bcc: recipientField.optional(),
	subject: z.string().min(1).describe("Email subject."),
	text: z.string().min(1).describe("Plain-text body. HTML is generated from it unless `html` is given."),
	html: z.string().optional().describe("Optional HTML body."),
});

const replyToThreadInput = z.object({
	threadId: z.string().min(1).describe("Thread to reply to (from list_threads / get_thread)."),
	text: z.string().min(1).describe("Plain-text reply body."),
	quoteOriginal: z.boolean().default(true).describe("Quote the original message below your reply. Default true."),
});

const replyAllToThreadInput = replyToThreadInput;

const saveDraftInput = z.object({
	draftId: z.string().optional().describe("Existing draft to update. Omit to create."),
	threadId: z.string().optional().describe("Set to make this a reply draft on that thread."),
	to: recipientField.optional(),
	cc: recipientField.optional(),
	bcc: recipientField.optional(),
	subject: z.string().optional(),
	text: z.string().optional(),
});

const listDraftsInput = z.object({});

const sendDraftInput = z.object({
	draftId: z.string().min(1).describe("Draft to send (from list_drafts / save_draft)."),
	edits: z
		.object({
			to: recipientField.optional(),
			cc: recipientField.optional(),
			bcc: recipientField.optional(),
			subject: z.string().optional(),
			text: z.string().optional(),
		})
		.optional()
		.describe("Last-minute changes applied before sending."),
});

const discardDraftInput = z.object({
	draftId: z.string().min(1).describe("Draft to delete permanently."),
});

export function listInboxTools(): InboxToolDef[] {
	return [
		{ name: "add_draft_attachment", description: "Attach a file to a saved draft. Provide canonical base64 bytes; at most 3 MiB combined across 32 attachments. Returns metadata without private storage keys.", inputSchema: z.object({ draftId: z.string().min(1), filename: z.string().min(1).max(1000), mimeType: z.string().max(127).optional(), contentBase64: z.string().max(4 * 1024 * 1024) }) },
		{ name: "remove_draft_attachment", description: "Remove one attachment belonging to a saved draft.", inputSchema: z.object({ draftId: z.string().min(1), attachmentId: z.string().min(1) }) },
		{ name: "read_attachment", description: "Read a file belonging to a message or draft in base64 chunks of up to 256 KiB. Continue at nextOffset until done. Requires both the storage message ID and its attachment ID.", inputSchema: z.object({ messageId: z.string().min(1), attachmentId: z.string().min(1), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(256 * 1024).optional() }) },
		{
			name: "list_threads",
			description:
				"List complete threads by status (inbox/snoozed/done/all). Returns {items,cursor,hasMore,indexing?}; pass cursor to continue. If indexing is true, retry the same request while the mailbox index is prepared.",
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
				"Case-insensitive substring search across message subject and body. Returns {items,cursor,hasMore,indexing?} with matching messages. Continue whenever hasMore is true, including empty pages; if indexing is true, retry the same request.",
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
		{
			name: "compose_email",
			description:
				"Send a brand-new email (starts a new thread). Requires to, subject, text. Returns the new message and thread IDs.",
			inputSchema: composeEmailInput,
		},
		{
			name: "reply_to_thread",
			description:
				"Reply to the sender of a thread's latest message. Subject and In-Reply-To are derived automatically; the original is quoted below your text unless quoteOriginal is false.",
			inputSchema: replyToThreadInput,
		},
		{
			name: "reply_all_to_thread",
			description:
				"Like reply_to_thread but also CCs everyone on the latest message (original to + cc), excluding this mailbox's own address.",
			inputSchema: replyAllToThreadInput,
		},
		{
			name: "save_draft",
			description:
				"Save an unfinished email as a draft instead of sending. Pass threadId to make it a reply draft. Returns a draftId you can update, send with send_draft, or delete with discard_draft.",
			inputSchema: saveDraftInput,
		},
		{
			name: "list_drafts",
			description: "List unsent drafts, newest first (id, recipients, subject, snippet, updated time).",
			inputSchema: listDraftsInput,
		},
		{
			name: "send_draft",
			description:
				"Send a saved draft, optionally applying last-minute edits. The draft is deleted on success; on delivery failure it is preserved unchanged.",
			inputSchema: sendDraftInput,
		},
		{
			name: "discard_draft",
			description: "Permanently delete a draft. This cannot be undone.",
			inputSchema: discardDraftInput,
		},
	];
}
