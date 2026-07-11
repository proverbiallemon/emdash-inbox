import type { MessageDoc } from "../index";
import { normalizeRecipients, deriveReplyAll } from "./recipients";
import { replyDefaults, plainTextToHtml } from "./replyDefaults";

/**
 * Shared compose/draft operations. Both the HTTP routes (M8 Task 5) and the
 * MCP handlers (M8 Task 6) call these — the routing layer only translates
 * transport-specific input/output shapes and error types; all decisions
 * (recipient math, subject defaulting, quote-body assembly, draft upsert
 * rules, the "delete-then-deliver-then-restore-on-failure" send sequence)
 * live here exactly once.
 *
 * `ctx` is the same duck-typed plugin/route context every other handler in
 * this codebase receives (`ctx.storage.<collection>`, `ctx.kv`). `deliver`
 * is passed in rather than imported so this module stays import-cycle-free
 * (src/index.ts owns `deliverEmail` and supplies it here) and unit-testable
 * in isolation by handing in a stub.
 *
 * No vitest coverage for the functions below (project convention for thin
 * storage wrappers — see the header comment in `inboxMcpHandlers.ts`). Every
 * pure decision they make is required to live in a tested pure module
 * instead: `recipients.ts`, `replyDefaults.ts`, `draftSummary.ts`.
 */

export interface ComposeInput {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	text: string;
	html?: string;
}

export interface ReplyInput {
	threadId: string;
	text: string;
	html?: string;
	quoteOriginal?: boolean;
	replyAll: boolean;
	to?: string | string[];
	cc?: string | string[];
}

export interface DraftInput {
	draftId?: string;
	threadId?: string;
	to?: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject?: string;
	text?: string;
	html?: string;
}

export type Deliver = (
	ctx: unknown,
	event: { message: Record<string, unknown>; source: string },
) => Promise<{ id: string; threadId: string } | null>;

export interface DraftRow {
	id: string;
	data: MessageDoc;
}

/** Maps to badRequest at the HTTP/MCP surface. */
export class ComposeError extends Error {}
/** Maps to notFound at the HTTP/MCP surface. */
export class NotFoundError extends ComposeError {}

const SENDER_ADDRESS_KEY = "settings:senderAddress";

async function getSenderAddress(ctx: any): Promise<string> {
	return ((await ctx.kv.get(SENDER_ADDRESS_KEY)) as string | null) ?? "";
}

function normalizeOrThrow(input: string | string[] | undefined): string[] {
	const result = normalizeRecipients(input);
	if (!result.ok) throw new ComposeError(result.error);
	return result.value;
}

/**
 * Thread rows ordered oldest-first, same query shape used across the codebase.
 * Excludes unsent drafts saved onto the thread — they're not real messages and
 * must never be picked as a reply-anchor or inReplyTo source.
 */
async function loadThreadRows(ctx: any, threadId: string): Promise<{ id: string; data: MessageDoc }[]> {
	const result = await (ctx as any).storage.messages.query({
		where: { threadId },
		orderBy: { receivedAt: "asc" },
		limit: 500,
	});
	const rows = (result.items ?? []) as { id: string; data: MessageDoc }[];
	return rows.filter((r) => r.data.status !== "draft");
}

export async function composeSend(
	ctx: any,
	deliver: Deliver,
	input: ComposeInput,
): Promise<{ id: string | null; threadId: string | null }> {
	const to = normalizeOrThrow(input.to);
	if (to.length === 0) throw new ComposeError("to: at least one recipient is required");
	const cc = normalizeOrThrow(input.cc);
	const bcc = normalizeOrThrow(input.bcc);

	const subject = input.subject.trim();
	if (!subject) throw new ComposeError("subject: required non-empty string");
	if (!input.text || input.text.trim() === "") {
		throw new ComposeError("text: required non-empty string");
	}
	const text = input.text;
	const html = input.html ?? plainTextToHtml(text);

	const result = await deliver(ctx, {
		message: { to: to[0], toAll: to, cc, bcc, subject, text, html },
		source: "emdash-inbox:compose",
	});

	return { id: result?.id ?? null, threadId: result?.threadId ?? null };
}

export async function replySend(
	ctx: any,
	deliver: Deliver,
	input: ReplyInput,
): Promise<{ id: string | null; threadId: string | null }> {
	const rows = await loadThreadRows(ctx, input.threadId);
	if (rows.length === 0) {
		throw new NotFoundError(`thread ${input.threadId} not found`);
	}

	// rows are oldest-first; the last inbound row is the latest inbound one.
	// Fall back to the latest row of any direction (e.g. an outbound-only
	// thread, or one where we're replying to our own follow-up).
	const latestInbound = rows.filter((r) => r.data.direction === "inbound").pop();
	const latest = (latestInbound ?? rows[rows.length - 1]).data;

	const defaults = replyDefaults({
		direction: latest.direction,
		from: latest.from,
		to: latest.to,
		subject: latest.subject,
		bodyText: latest.bodyText,
		bodyHtml: latest.bodyHtml,
		receivedAt: latest.receivedAt,
	});

	let to: string[];
	let cc: string[] = [];
	if (input.to !== undefined) {
		// UI override path: caller already knows who to send to (e.g. the user
		// hand-edited the recipient chips), so normalize and trust it as-is.
		to = normalizeOrThrow(input.to);
		cc = normalizeOrThrow(input.cc);
	} else if (input.replyAll) {
		const senderAddress = await getSenderAddress(ctx);
		const derived = deriveReplyAll(
			{
				direction: latest.direction,
				from: latest.from,
				to: latest.to,
				toAll: latest.toAll,
				cc: latest.cc,
			},
			senderAddress,
		);
		to = derived.to;
		cc = derived.cc;
	} else {
		to = [defaults.to];
	}
	if (to.length === 0) throw new ComposeError("to: at least one recipient is required");

	const html =
		input.html !== undefined
			? input.html
			: plainTextToHtml(input.text) + (input.quoteOriginal !== false ? defaults.quoteHtml : "");

	const result = await deliver(ctx, {
		message: {
			to: to[0],
			toAll: to,
			cc,
			subject: defaults.subject,
			text: input.text,
			html,
			inReplyTo: latest.messageId,
		},
		source: "emdash-inbox:reply",
	});

	return { id: result?.id ?? null, threadId: result?.threadId ?? null };
}

export async function draftSave(ctx: any, input: DraftInput): Promise<{ draftId: string }> {
	const messages = (ctx as any).storage.messages;
	const now = new Date().toISOString();

	// Recipients are normalized but MAY be empty — drafts are allowed to be
	// incomplete. Only ComposeError-worthy failure here is a malformed address.
	const to = normalizeOrThrow(input.to);
	const cc = normalizeOrThrow(input.cc);
	const bcc = normalizeOrThrow(input.bcc);

	if (input.draftId) {
		const existing = (await messages.get(input.draftId)) as MessageDoc | null;
		if (!existing || existing.status !== "draft") {
			throw new NotFoundError(`draft ${input.draftId} not found`);
		}
		const next: MessageDoc = {
			...existing,
			...(input.to !== undefined ? { to: to[0] ?? "", toAll: to } : {}),
			...(input.cc !== undefined ? { cc } : {}),
			...(input.bcc !== undefined ? { bcc } : {}),
			...(input.subject !== undefined ? { subject: input.subject } : {}),
			...(input.text !== undefined ? { bodyText: input.text } : {}),
			...(input.html !== undefined ? { bodyHtml: input.html } : {}),
			sortAt: now,
		};
		if (input.threadId !== undefined) {
			next.threadId = input.threadId;
			const threadRows = await loadThreadRows(ctx, input.threadId);
			const threadLatest = threadRows[threadRows.length - 1]?.data ?? null;
			// threadId and inReplyTo must never disagree: if the thread has no
			// message to anchor to, clear inReplyTo rather than leaving it
			// pointed at whatever the draft was previously threaded under.
			next.inReplyTo = threadLatest ? threadLatest.messageId : null;
		}
		await messages.put(input.draftId, next);
		return { draftId: input.draftId };
	}

	const draftId = crypto.randomUUID();
	const senderAddress = await getSenderAddress(ctx);
	const doc: MessageDoc = {
		messageId: `<draft-${draftId}@local>`,
		direction: "outbound",
		from: senderAddress,
		to: to[0] ?? "",
		toAll: to,
		cc,
		bcc,
		subject: input.subject ?? "",
		bodyText: input.text ?? "",
		bodyHtml: input.html ?? null,
		bodyRaw: null,
		threadId: input.threadId ?? null,
		receivedAt: now,
		source: "emdash-inbox:draft",
		status: "draft",
		pinned: false,
		read: true,
		bundleId: null,
		sortAt: now,
		snoozeUntil: null,
		inReplyTo: null,
	};

	if (input.threadId) {
		const threadRows = await loadThreadRows(ctx, input.threadId);
		const threadLatest = threadRows[threadRows.length - 1]?.data ?? null;
		if (threadLatest) doc.inReplyTo = threadLatest.messageId;
	}

	await messages.put(draftId, doc);
	return { draftId };
}

export async function draftSend(
	ctx: any,
	deliver: Deliver,
	input: { draftId: string; edits?: Partial<ComposeInput> },
): Promise<{ id: string | null; threadId: string | null }> {
	const messages = (ctx as any).storage.messages;
	const draft = (await messages.get(input.draftId)) as MessageDoc | null;
	if (!draft || draft.status !== "draft") {
		throw new NotFoundError(`draft ${input.draftId} not found`);
	}

	const edits = input.edits ?? {};
	const to = normalizeOrThrow(edits.to !== undefined ? edits.to : (draft.toAll ?? draft.to));
	if (to.length === 0) throw new ComposeError("to: at least one recipient is required");
	const cc = normalizeOrThrow(edits.cc !== undefined ? edits.cc : draft.cc);
	const bcc = normalizeOrThrow(edits.bcc !== undefined ? edits.bcc : draft.bcc);

	const subject = (edits.subject !== undefined ? edits.subject : draft.subject).trim();
	if (!subject) throw new ComposeError("subject: required non-empty string");
	const text = edits.text !== undefined ? edits.text : draft.bodyText;
	if (!text || text.trim() === "") throw new ComposeError("text: required non-empty string");
	const html = (edits.html !== undefined ? edits.html : draft.bodyHtml) ?? plainTextToHtml(text);

	// Delete first so a resend never leaves a duplicate; restore on any
	// delivery failure so the user's text is never destroyed by a failed send.
	await messages.delete(input.draftId);
	try {
		const result = await deliver(ctx, {
			message: {
				to: to[0],
				toAll: to,
				cc,
				bcc,
				subject,
				text,
				html,
				...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
			},
			// Mirrors composeSend/replySend's source convention — a draft that
			// was threaded off another message sends as a reply, otherwise as
			// a fresh compose. Not specified verbatim in the brief; chosen for
			// consistency with the other two send paths' audit trail.
			source: draft.inReplyTo ? "emdash-inbox:reply" : "emdash-inbox:compose",
		});
		return { id: result?.id ?? null, threadId: result?.threadId ?? null };
	} catch (err) {
		await messages.put(input.draftId, draft);
		throw err;
	}
}

export async function draftDiscard(ctx: any, input: { draftId: string }): Promise<{ ok: true }> {
	const messages = (ctx as any).storage.messages;
	const draft = (await messages.get(input.draftId)) as MessageDoc | null;
	if (!draft || draft.status !== "draft") {
		throw new NotFoundError(`draft ${input.draftId} not found`);
	}
	await messages.delete(input.draftId);
	return { ok: true };
}

export async function listDrafts(ctx: any): Promise<DraftRow[]> {
	const messages = (ctx as any).storage.messages;
	const result = await messages.query({ where: { status: "draft" }, limit: 10000 });
	const rows = (result.items ?? []) as DraftRow[];
	return [...rows].sort((a, b) => (a.data.sortAt < b.data.sortAt ? 1 : a.data.sortAt > b.data.sortAt ? -1 : 0));
}
