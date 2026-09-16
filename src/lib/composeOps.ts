import type { MessageDoc } from "../index";
import { normalizeRecipients, deriveReplyAll } from "./recipients";
import { replyDefaults, plainTextToHtml } from "./replyDefaults";
import { allRows, loadThreadRows } from "./mailboxStore";
import { cleanupAttachments, prepareOutgoingAttachments, validateOutgoingSize, type StoredAttachment } from "./attachments";
import { findDeliveryRequest, markDeliveryDraftDiscarded, type DeliveryResult } from "./deliveryJournal";

/**
 * Shared compose/draft operations. Both the messages/* HTTP routes and the
 * MCP tool handlers call these — the routing layer only translates
 * transport-specific input/output shapes and error types; all decisions
 * (recipient math, subject defaulting, quote-body assembly, draft upsert
 * rules, the durable journal handoff)
 * live here exactly once.
 *
 * `ctx` is the same duck-typed plugin/route context every other handler in
 * this codebase receives (`ctx.storage.<collection>`, `ctx.kv`). `deliver`
 * is passed in rather than imported so this module stays import-cycle-free
 * (src/index.ts owns `deliverEmail` and supplies it here) and unit-testable
 * in isolation by handing in a stub.
 *
 * Draft storage races and body consistency are covered in `composeOps.test.ts`;
 * recipient and reply decisions are also tested in their pure modules.
 */

export interface ComposeInput {
	requestId?: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	text: string;
	html?: string;
}

export interface ReplyInput {
	requestId?: string;
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
	event: {
		requestId?: string;
		requestPayload?: unknown;
		draftClaim?: { id: string; revision: string; snapshot: MessageDoc };
		message: {
			to: string;
			toAll?: string[];
			cc?: string[];
			bcc?: string[];
			subject: string;
			text: string;
			html?: string;
			inReplyTo?: string;
			attachments?: StoredAttachment[];
		};
		source: string;
	},
) => Promise<({ id: string | null; threadId: string | null } & Partial<DeliveryResult>) | null>;

export type SendResult = { id: string | null; threadId: string | null } & Partial<DeliveryResult>;

function requestPayload(operation: string, input: object): unknown {
	const { requestId: _requestId, ...payload } = input as Record<string, unknown>;
	return { operation, ...payload };
}

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

export async function composeSend(
	ctx: any,
	deliver: Deliver,
	input: ComposeInput,
): Promise<SendResult> {
	const payload = requestPayload("compose", input);
	if (input.requestId) {
		const previous = await findDeliveryRequest(ctx, input.requestId, payload);
		if (previous) return previous;
	}
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
	validateOutgoingSize([], text, html);

	const result = await deliver(ctx, {
		requestId: input.requestId, requestPayload: payload,
		message: { to: to[0], toAll: to, cc, bcc, subject, text, html },
		source: "emdash-inbox:compose",
	});

	return result ?? { id: null, threadId: null };
}

export async function replySend(
	ctx: any,
	deliver: Deliver,
	input: ReplyInput,
): Promise<SendResult> {
	const payload = requestPayload("reply", input);
	if (input.requestId) {
		const previous = await findDeliveryRequest(ctx, input.requestId, payload);
		if (previous) return previous;
	}
	if (typeof input.threadId !== "string" || input.threadId.trim() === "") {
		throw new ComposeError("threadId: required non-empty string");
	}
	if (typeof input.text !== "string" || input.text.trim() === "") {
		throw new ComposeError("text: required non-empty string");
	}

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
		bodyText: latest.bodyText || (latest.bodyHtml ? "[Original HTML message omitted from this quote.]" : ""),
		// Workers have no browser DOM for DOMPurify. Server-generated quotes use
		// escaped text; the admin editor can still supply its sanitized rich HTML.
		bodyHtml: null,
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
	validateOutgoingSize([], input.text, html);

	const result = await deliver(ctx, {
		requestId: input.requestId, requestPayload: payload,
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

	return result ?? { id: null, threadId: null };
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
		const current = (await messages.getVersioned(input.draftId)) as {
			value: MessageDoc;
			revision: string;
		} | null;
		if (!current || current.value.status !== "draft") {
			throw new NotFoundError(`draft ${input.draftId} not found`);
		}
		const existing = current.value;
		const next: MessageDoc = {
			...existing,
			...(input.to !== undefined ? { to: to[0] ?? "", toAll: to } : {}),
			...(input.cc !== undefined ? { cc } : {}),
			...(input.bcc !== undefined ? { bcc } : {}),
			...(input.subject !== undefined ? { subject: input.subject } : {}),
			...(input.text !== undefined ? { bodyText: input.text } : {}),
			bodyHtml:
				input.html ??
				(input.text !== undefined && input.text !== existing.bodyText ? null : existing.bodyHtml),
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
		validateOutgoingSize(next.attachments ?? [], next.bodyText, next.bodyHtml ?? "");
		const saved = await messages.compareAndSet(input.draftId, current.revision, next);
		if (!saved.applied) {
			throw new ComposeError(`draft ${input.draftId} changed or was removed; reload before saving`);
		}
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
	validateOutgoingSize([], doc.bodyText, doc.bodyHtml ?? "");

	await messages.put(draftId, doc);
	return { draftId };
}

export async function draftSend(
	ctx: any,
	deliver: Deliver,
	input: { draftId: string; edits?: Partial<ComposeInput>; requestId?: string },
): Promise<SendResult> {
	const payload = requestPayload("draft", input);
	if (input.requestId) {
		const previous = await findDeliveryRequest(ctx, input.requestId, payload);
		if (previous) return previous;
	}
	const messages = (ctx as any).storage.messages;
	const current = (await messages.getVersioned(input.draftId)) as {
		value: MessageDoc;
		revision: string;
	} | null;
	if (!current || current.value.status !== "draft") {
		throw new NotFoundError(`draft ${input.draftId} not found`);
	}
	const draft = current.value;

	const edits = input.edits ?? {};
	const to = normalizeOrThrow(edits.to !== undefined ? edits.to : (draft.toAll ?? draft.to));
	if (to.length === 0) throw new ComposeError("to: at least one recipient is required");
	const cc = normalizeOrThrow(edits.cc !== undefined ? edits.cc : draft.cc);
	const bcc = normalizeOrThrow(edits.bcc !== undefined ? edits.bcc : draft.bcc);

	const subject = (edits.subject !== undefined ? edits.subject : draft.subject).trim();
	if (!subject) throw new ComposeError("subject: required non-empty string");
	const text = edits.text !== undefined ? edits.text : draft.bodyText;
	if (!text || text.trim() === "") throw new ComposeError("text: required non-empty string");
	const html = edits.html ?? (text === draft.bodyText ? draft.bodyHtml : null) ?? plainTextToHtml(text);
	// Resolve and verify all bytes before claiming a draft. A missing object or
	// oversized body must never consume the draft or reach mail transport.
	await prepareOutgoingAttachments(ctx, draft.attachments ?? [], text, html);

	// The journal claims this exact revision and keeps the final edits durable.
	// A losing claim never reaches transport; unknown outcomes stay locked.
	const snapshot: MessageDoc = {
		...draft, to: to[0], toAll: to, cc, bcc, subject, bodyText: text, bodyHtml: html,
		sortAt: new Date().toISOString(),
	};
	const result = await deliver(ctx, {
		requestId: input.requestId, requestPayload: payload,
		draftClaim: { id: input.draftId, revision: current.revision, snapshot },
		message: {
			to: to[0], toAll: to, cc, bcc, subject, text, html,
			...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
			...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
		},
		source: draft.inReplyTo ? "emdash-inbox:reply" : "emdash-inbox:compose",
	});
	return result ?? { id: null, threadId: null };
}

export async function draftDiscard(ctx: any, input: { draftId: string }): Promise<{ ok: true }> {
	const messages = (ctx as any).storage.messages;
	const current = (await messages.getVersioned(input.draftId)) as {
		value: MessageDoc;
		revision: string;
	} | null;
	if (!current || current.value.status !== "draft") {
		throw new NotFoundError(`draft ${input.draftId} not found`);
	}
	// Persist deletion intent before removing a recovered draft. Otherwise a
	// later recovery scan could recreate it from the immutable send snapshot.
	if (current.value.deliveryAttemptId) {
		await markDeliveryDraftDiscarded(ctx, current.value.deliveryAttemptId, input.draftId);
	}
	const discarded = await messages.compareAndDelete(input.draftId, current.revision);
	if (!discarded.applied) {
		throw new ComposeError(`draft ${input.draftId} changed or was removed; reload before discarding`);
	}
	await cleanupAttachments(ctx, current.value.attachments ?? []);
	return { ok: true };
}

export async function listDrafts(ctx: any): Promise<DraftRow[]> {
	const messages = (ctx as any).storage.messages;
	const rows = await allRows<MessageDoc>(messages, { where: { status: "draft" } });
	return [...rows].sort((a, b) => (a.data.sortAt < b.data.sortAt ? 1 : a.data.sortAt > b.data.sortAt ? -1 : 0));
}
