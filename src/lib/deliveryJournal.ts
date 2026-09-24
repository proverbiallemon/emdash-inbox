import { readProviderDelivery } from "./providerDelivery";
import { beginThreadMutation, endThreadMutation, finishMessageAdmission } from "./threadMutation";
import type { MessageDoc } from "../index";
import { prepareMessage } from "./mailboxStore";
import { normalizeMessageId } from "./messageIdentity";

export type DeliveryState = "prepared" | "sending" | "accepted" | "uncertain" | "failed" | "sent" | "restored";
export interface DeliveryReceipt { messageId?: string; [key: string]: unknown }
export interface DeliveryAttempt {
	attemptId: string;
	messageId: string;
	fingerprint: string;
	snapshot: MessageDoc;
	state: DeliveryState;
	createdAt: string;
	updatedAt: string;
	receipt?: DeliveryReceipt;
	error?: string;
	resolution?: { type: "sent" | "restore"; at: string; duplicateRiskAcknowledged?: boolean };
	draftRevision?: string;
	/** A later draft claim or discard permanently fences historical recreation. */
	restoreSuppressed?: boolean;
}
export interface DeliveryResult {
	id: string | null;
	threadId: string | null;
	attemptId: string;
	deliveryStatus: "sent" | "pending" | "uncertain" | "failed";
	error?: string;
	draftId?: string;
	providerAccepted?: boolean;
}
export type ProjectSent = (ctx: any, attempt: DeliveryAttempt) => Promise<{ id: string; threadId: string }>;
export interface DeliveryCallbacks {
	transport: (snapshot: MessageDoc) => Promise<DeliveryReceipt>;
	projectSent: ProjectSent;
}
export interface DeliveryInput {
	snapshot: MessageDoc;
	messageId?: string;
	expectedRevision?: string;
	draftClaim?: { id: string; revision: string };
	requestId?: string;
	/** Original API payload, excluding requestId; must stay identical on a retry. */
	requestPayload?: unknown;
}
export class DeliveryError extends Error {
	constructor(message: string) { super(message); this.name = "DeliveryError"; }
}
export const deliveryCollections = { deliveries: { indexes: ["state", "messageId"] } };
export const deliveryMessageIndexes = ["deliveryAttemptId"];
const RETRIES = 8;
const STALE_MS = 5 * 60_000;
const RECOVERY_KEY = "state:delivery-recovery:v1";
type OutboxMessage = MessageDoc & {
	deliveryAttemptId?: string;
	deliveryFingerprint?: string;
	deliveryCreatedAt?: string;
	deliveryProjected?: boolean;
};

function stable(value: any): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
async function hash(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validateRequestId(requestId: string): void {
	if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200) throw new DeliveryError("requestId must contain 1 to 200 characters");
}
async function requestAttemptId(requestId: string): Promise<string> {
	validateRequestId(requestId);
	return `request-${await hash(requestId)}`;
}
function receiptId(attempt: DeliveryAttempt): string {
	return normalizeMessageId(attempt.receipt?.messageId) ?? `<sent-${attempt.messageId}@local>`;
}
function result(attempt: DeliveryAttempt): DeliveryResult {
	const sent = attempt.state === "sent";
	const failed = attempt.state === "failed" || attempt.state === "restored";
	return {
		id: sent ? attempt.messageId : null,
		threadId: sent ? attempt.snapshot.threadId ?? receiptId(attempt) : null,
		attemptId: attempt.attemptId,
		deliveryStatus: sent ? "sent" : failed ? "failed" : attempt.state === "uncertain" ? "uncertain" : "pending",
		...(attempt.error ? { error: attempt.error } : {}),
		...(failed ? { draftId: attempt.messageId } : {}),
		...(attempt.receipt ? { providerAccepted: true } : {}),
	};
}
function pending(attempt: DeliveryAttempt): DeliveryResult {
	return { id: null, threadId: null, attemptId: attempt.attemptId, deliveryStatus: "pending" };
}
function fromOutbox(messageId: string, message: OutboxMessage): DeliveryAttempt {
	if (!message.deliveryAttemptId || !message.deliveryFingerprint || !message.deliveryCreatedAt) throw new DeliveryError("Outbox message is missing its recovery metadata");
	return {
		attemptId: message.deliveryAttemptId, messageId, fingerprint: message.deliveryFingerprint,
		snapshot: message, state: "prepared", createdAt: message.deliveryCreatedAt, updatedAt: message.deliveryCreatedAt,
	};
}
async function readAttempt(ctx: any, attemptId: string): Promise<DeliveryAttempt | null> {
	return (await ctx.storage.deliveries.getVersioned(attemptId))?.value ?? null;
}

/** Looks up the immutable request before any current draft/thread state is consulted. */
export async function findDeliveryRequest(ctx: any, requestId: string, requestPayload: unknown): Promise<DeliveryResult | null> {
	const attemptId = await requestAttemptId(requestId);
	let attempt = await readAttempt(ctx, attemptId);
	if (!attempt) {
		// A claim may have committed before journal creation. The outbox itself
		// is the durable snapshot and also reserves the request key in that gap.
		const page = await ctx.storage.messages.query({ where: { deliveryAttemptId: attemptId }, limit: 1 });
		const row = page.items[0];
		if (row) attempt = fromOutbox(row.id, row.data);
	}
	if (!attempt) return null;
	if (attempt.fingerprint !== await hash(requestPayload)) throw new DeliveryError("requestId was already used with a different payload");
	return result(attempt);
}

async function transition(ctx: any, attemptId: string, update: (attempt: DeliveryAttempt) => DeliveryAttempt | null): Promise<DeliveryAttempt> {
	for (let i = 0; i < RETRIES; i++) {
		const current = await ctx.storage.deliveries.getVersioned(attemptId);
		if (!current) throw new DeliveryError("Delivery attempt not found");
		const next = update(current.value);
		if (!next) return current.value;
		const changed = { ...next, updatedAt: new Date().toISOString() };
		if ((await ctx.storage.deliveries.compareAndSet(attemptId, current.revision, changed)).applied) return changed;
	}
	throw new DeliveryError("Delivery changed repeatedly; refresh its status");
}

function comparableSnapshot(message: MessageDoc): unknown {
	// Only send content participates. Mutable mailbox triage and recovery
	// metadata do not make an untouched restored draft look edited.
	return {
		from: message.from, to: message.to, toAll: message.toAll, cc: message.cc, bcc: message.bcc,
		subject: message.subject, bodyText: message.bodyText, bodyHtml: message.bodyHtml,
		attachments: message.attachments, inReplyTo: message.inReplyTo, references: message.references,
	};
}

/** CAS projection used by the host callback. Repeated recovery preserves user triage. */
export async function projectDeliveryMessage(ctx: any, attempt: DeliveryAttempt, sentMessage: MessageDoc): Promise<{ id: string; threadId: string }> {
 const existing = await ctx.storage.messages.get(attempt.messageId);
 const identity = receiptId(attempt);
 const destination = existing?.deliveryProjected ? (existing.threadId === existing.messageId ? identity : existing.threadId ?? identity) : sentMessage.threadId ?? identity;
 const guard = await beginThreadMutation(ctx, [existing?.threadId ?? existing?.messageId ?? identity, destination]);
 try {
  const result = await projectDeliveryWithinGuard(ctx, attempt, sentMessage, new Set(guard.intents.map(intent=>intent.threadId)));
  await finishMessageAdmission(ctx, attempt.messageId);
  await endThreadMutation(ctx, guard);
  return result;
 } catch(error) {
  if(error instanceof DeliveryError) await endThreadMutation(ctx,guard);
  throw error;
 }
}
async function projectDeliveryWithinGuard(ctx: any, attempt: DeliveryAttempt, sentMessage: MessageDoc, guardedThreads: Set<string>): Promise<{ id: string; threadId: string }> {
	for (let i = 0; i < RETRIES; i++) {
		const current = await ctx.storage.messages.getVersioned(attempt.messageId);
		// Read the journal AFTER the row revision. A stale projector cannot
		// overwrite a later receipt's projection even when callbacks race.
		const latest = await readAttempt(ctx, attempt.attemptId);
		if (!latest?.receipt || !["accepted", "sent"].includes(latest.state) || stable(latest.receipt) !== stable(attempt.receipt)) throw new DeliveryError("Delivery receipt changed; reconcile again");
		if (!current || current.value.deliveryAttemptId !== attempt.attemptId) throw new ProjectionConflict();
		const message = current.value as OutboxMessage;
		const identity = receiptId(attempt);
		if (message.deliveryProjected && message.messageId === identity) return { id: attempt.messageId, threadId: message.threadId ?? identity };
		if (!message.deliveryProjected && message.status !== "outbox" && !(message.status === "draft" && stable(comparableSnapshot(message)) === stable(comparableSnapshot(attempt.snapshot)))) throw new ProjectionConflict();
		const next = message.deliveryProjected ? {
			...message, messageId: identity,
			threadId: message.threadId === message.messageId ? identity : message.threadId,
			bodyRaw: sentMessage.bodyRaw, transportMessageId: sentMessage.transportMessageId, indexDirty: true,
		} : {
			...sentMessage, messageId: identity, threadId: sentMessage.threadId ?? identity,
			deliveryAttemptId: attempt.attemptId, deliveryFingerprint: attempt.fingerprint,
			deliveryCreatedAt: attempt.createdAt, deliveryProjected: true, indexDirty: true,
		};
		if (!guardedThreads.has(message.threadId ?? message.messageId) || !guardedThreads.has(next.threadId ?? identity)) throw new DeliveryError("Delivery conversation changed; reconcile again");
        if ((await ctx.storage.messages.compareAndSet(attempt.messageId, current.revision, prepareMessage(attempt.messageId, {...next, publicationPending: !message.admittedAt}, message))).applied) return { id: attempt.messageId, threadId: next.threadId ?? identity };
	}
	throw new DeliveryError("Delivery message changed repeatedly; reconcile again");
}

class ProjectionConflict extends DeliveryError {
	constructor() { super("Mail was accepted, but its draft changed. Verify the provider receipt and review the draft before sending again."); }
}

async function restoreMessage(ctx: any, attempt: DeliveryAttempt): Promise<"restored" | "unchanged" | false> {
	for (let i = 0; i < RETRIES; i++) {
		const current = await ctx.storage.messages.getVersioned(attempt.messageId);
		const latest = await readAttempt(ctx, attempt.attemptId);
		if (!latest || latest.receipt || !["failed", "restored"].includes(latest.state)) return false;
		const originalUnclaimedDraft = current?.value.status === "draft" && current.revision === attempt.draftRevision;
		if (current?.value.status === "draft" && !originalUnclaimedDraft && (current.value.deliveryAttemptId === attempt.attemptId || attempt.draftRevision)) return "unchanged";
		if (current && !originalUnclaimedDraft && (current.value.deliveryAttemptId !== attempt.attemptId || current.value.status !== "outbox")) return false;
		if (!current && (attempt.draftRevision || latest.restoreSuppressed)) return false; // Never recreate a discarded or superseded draft.
		const next = { ...attempt.snapshot, status: "draft", sortAt: new Date().toISOString(), deliveryAttemptId: attempt.attemptId, deliveryFingerprint: attempt.fingerprint, deliveryCreatedAt: attempt.createdAt, deliveryProjected: false };
		if ((await ctx.storage.messages.compareAndSet(attempt.messageId, current?.revision ?? null, next)).applied) return "restored";
	}
	throw new DeliveryError("Delivery message changed repeatedly; reconcile again");
}

/** Persist discard intent BEFORE deleting a recovered draft, including lost delete acks. */
export async function markDeliveryDraftDiscarded(ctx: any, attemptId: string, messageId: string): Promise<void> {
	await transition(ctx, attemptId, (attempt) => {
		if (attempt.messageId !== messageId) throw new DeliveryError("Delivery does not own this draft");
		if (attempt.receipt || !["failed", "restored"].includes(attempt.state)) throw new DeliveryError("Delivery status changed; refresh before changing its draft");
		return attempt.restoreSuppressed ? null : { ...attempt, restoreSuppressed: true };
	});
}

async function finishAccepted(ctx: any, projectSent: ProjectSent, attempt: DeliveryAttempt): Promise<DeliveryResult> {
	let projected: { id: string; threadId: string };
	try { projected = await projectSent(ctx, attempt); }
	catch (error) {
		await transition(ctx, attempt.attemptId, (current) => current.state === "accepted" && stable(current.receipt) === stable(attempt.receipt) ? {
			...current, error: error instanceof ProjectionConflict ? error.message : "sent_projection_pending",
		} : null);
		throw error;
	}
	const saved = await transition(ctx, attempt.attemptId, (current) => {
		if (current.state === "sent" || stable(current.receipt) !== stable(attempt.receipt)) return null;
		if (current.state !== "accepted") return null;
		return { ...current, state: "sent", error: undefined };
	});
	return saved.state === "sent" ? { ...result(saved), ...projected } : result(saved);
}

/** The only function that invokes transport, and only after an acknowledged sending CAS. */
export async function runDelivery(ctx: any, input: DeliveryInput, callbacks: DeliveryCallbacks): Promise<DeliveryResult> {
	const requestPayload = input.requestPayload ?? comparableSnapshot(input.snapshot);
	if (input.requestId !== undefined) {
		const previous = await findDeliveryRequest(ctx, input.requestId, requestPayload);
		if (previous) return previous;
	}
	const attemptId = input.requestId !== undefined ? await requestAttemptId(input.requestId) : crypto.randomUUID();
	const messageId = input.draftClaim?.id ?? input.messageId ?? `outbox-${attemptId}`;
	const expectedRevision = input.draftClaim?.revision ?? input.expectedRevision ?? null;
	const now = new Date().toISOString();
	const fingerprint = await hash(requestPayload);
	const snapshot = { ...input.snapshot, status: "outbox", deliveryAttemptId: attemptId, deliveryFingerprint: fingerprint, deliveryCreatedAt: now, deliveryProjected: false } as OutboxMessage;
	const attempt: DeliveryAttempt = { attemptId, messageId, fingerprint, snapshot, state: "prepared", createdAt: now, updatedAt: now, ...(expectedRevision ? { draftRevision: expectedRevision } : {}) };
	// Reserve a request globally before touching a draft. Otherwise two calls
	// using one key on different draft IDs could both claim a different row.
	try {
		const created = await ctx.storage.deliveries.compareAndSet(attemptId, null, attempt);
		if (!created.applied) {
			const existing = (await readAttempt(ctx, attemptId))!;
			if (existing.fingerprint !== fingerprint) throw new DeliveryError("requestId was already used with a different payload");
			return result(existing);
		}
	} catch (error) {
		if (error instanceof DeliveryError) throw error;
		// A confirmed absent reservation means no claim or transport happened.
		// Surface that ordinary storage failure instead of a phantom Outbox row.
		let existing: DeliveryAttempt | null;
		try { existing = await readAttempt(ctx, attemptId); } catch { throw error; }
		if (!existing) throw error;
		return pending(attempt);
	}
	try {
		const previousAttempt = (input.snapshot as OutboxMessage).deliveryAttemptId;
		if (previousAttempt && previousAttempt !== attemptId) await markDeliveryDraftDiscarded(ctx, previousAttempt, messageId);
		const claim = await ctx.storage.messages.compareAndSet(messageId, expectedRevision, snapshot);
		if (!claim.applied) {
			if (input.requestId !== undefined) {
				const previous = await findDeliveryRequest(ctx, input.requestId, requestPayload);
				if (previous) return previous;
			}
			throw new DeliveryError("Draft changed or was removed; reload before sending");
		}
	} catch (error) {
		// An acknowledgement failure cannot grant a transport permit. If the
		// row committed, expose its durable recovery state to the caller.
		const current = await ctx.storage.messages.getVersioned(messageId);
		if (current?.value.deliveryAttemptId === attemptId) return pending(attempt);
		await transition(ctx, attemptId, (currentAttempt) => currentAttempt.state === "prepared" ? { ...currentAttempt, state: "restored", error: "draft_changed" } : null);
		throw error;
	}
	try {
		const prepared = await ctx.storage.deliveries.getVersioned(attemptId);
		if (!prepared || prepared.value.state !== "prepared") return result(prepared?.value ?? attempt);
		const sending = { ...prepared.value, state: "sending", updatedAt: new Date().toISOString() };
		// This CAS, not a later read, is the sole transport permission.
		const permit = await ctx.storage.deliveries.compareAndSet(attemptId, prepared.revision, sending);
		if (!permit.applied) return result((await readAttempt(ctx, attemptId))!);
	} catch { return pending(attempt); }

	let receipt: DeliveryReceipt;
	try {
		receipt = await callbacks.transport(snapshot);
	} catch (error) {
		const definitive = !!error && typeof error === "object" && "definitive" in error && error.definitive === true;
		const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : definitive ? "provider_rejected" : "delivery_outcome_unknown";
		try {
			const failed = await transition(ctx, attemptId, (current) => current.receipt || !["sending", "uncertain"].includes(current.state) ? null : { ...current, state: definitive ? "failed" : "uncertain", error: code });
			if (failed.state === "failed") await restoreMessage(ctx, failed);
			return result(failed);
		} catch { return { ...pending(attempt), deliveryStatus: "uncertain", error: "delivery_outcome_unknown" }; }
	}
	try {
		// Acceptance outranks a stale operator restore. Projection can still
		// refuse to replace an edited/new draft; the receipt remains durable.
		const accepted = await transition(ctx, attemptId, (current) => ({ ...current, state: "accepted", receipt: receipt ?? {}, error: undefined }));
		return await finishAccepted(ctx, callbacks.projectSent, accepted);
	} catch {
		// The provider accepted. Never restore/resend because persisting the
		// receipt or projecting the mailbox failed (including lost write acks).
		try {
			const current = await readAttempt(ctx, attemptId);
			if (current && ["accepted", "sent"].includes(current.state) && current.receipt) return { ...result(current), providerAccepted: true };
		} catch { /* Recovery will read the persisted state. */ }
		return { ...pending(attempt), providerAccepted: true };
	}
}

export async function listDeliveries(ctx: any, input: { limit?: number; cursor?: string } = {}) {
	const limit = input.limit ?? 30;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeliveryError("limit must be an integer from 1 to 100");
	if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096)) throw new DeliveryError("Invalid delivery cursor");
	const page = await ctx.storage.deliveries.query({ limit, cursor: input.cursor });
	const items = [];
	for (const { data: attempt } of page.items as { data: DeliveryAttempt }[]) {
		const draft = ["failed", "restored"].includes(attempt.state) ? await ctx.storage.messages.getVersioned(attempt.messageId) : null;
		items.push({
			attemptId: attempt.attemptId, messageId: attempt.messageId, state: attempt.state,
			subject: attempt.snapshot.subject, to: attempt.snapshot.toAll ?? [attempt.snapshot.to],
			createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
			...(attempt.error ? { error: attempt.error } : {}),
			...(attempt.receipt?.messageId ? { providerMessageId: attempt.receipt.messageId } : {}),
			...(draft?.value.status === "draft" && draft.value.deliveryAttemptId === attempt.attemptId ? { draftId: attempt.messageId } : {}),
			canResolve: attempt.state === "uncertain",
			...(attempt.receipt?.messageId ? { providerDelivery: await readProviderDelivery(ctx, { ...attempt.snapshot, transportMessageId: attempt.receipt.messageId }, true) } : {}),
		});
	}
	return {
		items, cursor: page.cursor, hasMore: !!page.hasMore,
	};
}

/** Bounded, resumable recovery. It has no access to a transport callback. */
export async function reconcileDeliveries(ctx: any, projectSent: ProjectSent, options: { limit?: number; staleAfterMs?: number; now?: number } = {}) {
	const limit = options.limit ?? 30;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeliveryError("limit must be an integer from 1 to 100");
	const cutoff = (options.now ?? Date.now()) - (options.staleAfterMs ?? STALE_MS);
	const counts = { recovered: 0, restored: 0, uncertain: 0, errors: 0, inspected: 0, hasMore: false };
	const checkpoint = await ctx.kv.getVersioned(RECOVERY_KEY);
	const cursors = checkpoint?.value as { deliveries?: string; outbox?: string } | undefined;
	const outbox = await ctx.storage.messages.query({ where: { status: "outbox" }, limit, cursor: cursors?.outbox });
	for (const row of outbox.items) {
		try {
			const attempt = fromOutbox(row.id, row.data);
			if (!(await readAttempt(ctx, attempt.attemptId))) await ctx.storage.deliveries.compareAndSet(attempt.attemptId, null, attempt);
		} catch { counts.errors++; }
	}
	const page = await ctx.storage.deliveries.query({ limit, cursor: cursors?.deliveries });
	for (const row of page.items as { id: string; data: DeliveryAttempt }[]) {
		counts.inspected++;
		try {
			let attempt = (await readAttempt(ctx, row.id))!;
			if (attempt.state === "prepared" && Date.parse(attempt.updatedAt) <= cutoff) {
				attempt = await transition(ctx, row.id, (current) => current.state === "prepared" && Date.parse(current.updatedAt) <= cutoff ? { ...current, state: "restored", error: "preparation_interrupted", resolution: { type: "restore", at: new Date().toISOString() } } : null);
			}
			if (attempt.state === "sending" && Date.parse(attempt.updatedAt) <= cutoff) {
				attempt = await transition(ctx, row.id, (current) => current.state === "sending" && Date.parse(current.updatedAt) <= cutoff ? { ...current, state: "uncertain", error: "delivery_outcome_unknown" } : null);
				if (attempt.state === "uncertain") counts.uncertain++;
			}
			if (attempt.state === "accepted") {
				if ((await finishAccepted(ctx, projectSent, attempt)).deliveryStatus === "sent") counts.recovered++;
			} else if (attempt.state === "failed" || attempt.state === "restored") {
				if (await restoreMessage(ctx, attempt) === "restored") counts.restored++;
			}
		} catch { counts.errors++; }
	}
	counts.hasMore = !!page.hasMore || !!outbox.hasMore;
	await ctx.kv.compareAndSet(RECOVERY_KEY, checkpoint?.revision ?? null, {
		deliveries: page.hasMore ? page.cursor : undefined,
		outbox: outbox.hasMore ? outbox.cursor : undefined,
	});
	return counts;
}

export async function resolveDelivery(ctx: any, projectSent: ProjectSent, input: { attemptId: string; resolution: "sent" | "restore"; confirmDuplicateRisk?: boolean; providerMessageId?: string }): Promise<{ ok: true; draftId?: string; id?: string; threadId?: string }> {
	if (typeof input.attemptId !== "string" || !input.attemptId || !["sent", "restore"].includes(input.resolution)) throw new DeliveryError("Invalid delivery resolution");
	if (input.providerMessageId !== undefined && (typeof input.providerMessageId !== "string" || input.providerMessageId.length > 998 || !/^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/.test(input.providerMessageId))) throw new DeliveryError("providerMessageId must be a valid RFC Message-ID");
	let attempt = await transition(ctx, input.attemptId, (current) => {
		if (current.receipt || current.state === "sent" || current.state === "accepted") return null;
		if (current.state === "restored") {
			if (input.resolution === "restore") return null;
			throw new DeliveryError("This delivery was already restored; refresh its status");
		}
		if (!["uncertain", "failed"].includes(current.state)) throw new DeliveryError("Only uncertain or failed deliveries can be resolved");
		if (current.state === "failed" && input.resolution === "sent") throw new DeliveryError("A definitively rejected delivery can only be restored as a draft");
		if (input.resolution === "restore" && current.state === "uncertain" && input.confirmDuplicateRisk !== true) throw new DeliveryError("Restoring this draft requires acknowledging that another send may deliver a duplicate");
		const resolution = { type: input.resolution, at: new Date().toISOString(), ...(input.confirmDuplicateRisk ? { duplicateRiskAcknowledged: true } : {}) };
		return input.resolution === "sent" ? { ...current, state: "accepted", receipt: input.providerMessageId ? { messageId: input.providerMessageId } : {}, resolution, error: undefined } : { ...current, state: "restored", resolution };
	});
	if (attempt.receipt) {
		const sent = await finishAccepted(ctx, projectSent, attempt);
		if (sent.deliveryStatus !== "sent") throw new DeliveryError("Receipt changed; reconcile again");
		return { ok: true, id: sent.id!, threadId: sent.threadId! };
	}
	if (await restoreMessage(ctx, attempt)) return { ok: true, draftId: attempt.messageId };
	// A live provider response can supersede the operator CAS during restore.
	attempt = (await readAttempt(ctx, input.attemptId))!;
	if (attempt.receipt) {
		const sent = await finishAccepted(ctx, projectSent, attempt);
		return { ok: true, ...(sent.id ? { id: sent.id, threadId: sent.threadId! } : {}) };
	}
	throw new DeliveryError("Delivery message changed; refresh its status");
}
