import { bundleOperationCollections, bundleOperationRoutes } from "./lib/bundleOperations";
import { threadMutationCollections, finishMessageAdmission } from "./lib/threadMutation";
import { bundleCollections, bundleRoutes } from "./lib/bundleStore";
import { definePlugin, PluginRouteError } from "emdash";
import type { PluginDescriptor } from "emdash";
import { DeliverError, wrapBindingError, type EmailBinding } from "./lib/cfBindingError";
import PostalMime from "./lib/mimeParser";
import { validateTransition } from "./lib/statusTransitions";
import { deriveThreadInfo } from "./lib/threadDerive";
import { aggregateThreads, isDraftRow, type StatusFilter } from "./lib/threadSummary";
import {
	composeSend,
	replySend,
	draftSave,
	draftSend,
	draftDiscard,
	listDrafts,
	ComposeError,
	NotFoundError,
	type ComposeInput,
	type ReplyInput,
	type DraftInput,
	type Deliver,
} from "./lib/composeOps";
import { runDelivery, findDeliveryRequest, projectDeliveryMessage, listDeliveries, reconcileDeliveries, resolveDelivery, deliveryCollections, deliveryMessageIndexes, DeliveryError, type DeliveryAttempt, type DeliveryResult } from "./lib/deliveryJournal";
import { draftSummaryOf } from "./lib/draftSummary";
import { normalizeRecipients } from "./lib/recipients";
import { extractAddresses } from "./lib/inboundAddresses";
import { nativeInboxMcp } from "./lib/nativeMcp";
import { listDeliveriesInput, resolveDeliveryInput } from "./lib/inboxMcpTools";
import { normalizeMessageId, replyReferences } from "./lib/messageIdentity";
import { VERSION } from "./version";
import { readInboxPreferences, saveInboxPreferences } from "./lib/uiPreferences";
import { readSignature, saveSignature } from "./lib/signatureSettings";
import { embedInlineImages } from "./lib/inlineImages";
import { recordProviderEvent, readProviderDelivery, type DeliveryEventScope } from "./lib/providerDelivery";
import { requireMailboxReady, MailboxInputError, mailboxCollections, mailboxMessageIndexes, allRows, loadThreadRows, putMessage, mutateMessage, mutateThread, ensureMailboxIndex, listThreadPage, searchMessagePage, wakeSnoozed } from "./lib/mailboxStore";
import { attachmentCollections, AttachmentError, type StoredAttachment, publicMessage, uploadDraftAttachment, removeDraftAttachment, readAttachment, storeInboundFiles, prepareOutgoingAttachments, retryAttachmentCleanup, decodeBase64, MAX_INBOUND_BYTES, MAX_BODY_BYTES } from "./lib/attachments";

/**
 * Plugin descriptor — imported in the host site's `astro.config.mjs`.
 * Runs at build time in Vite; must be side-effect-free (no runtime APIs).
 */
export function emdashInboxPlugin(options: { deliveryEvents?: DeliveryEventScope } = {}): PluginDescriptor {
	return {
		id: "emdash-inbox",
		version: VERSION,
		format: "native",
		entrypoint: "emdash-inbox",
		adminEntry: "emdash-inbox/admin",
		adminPages: [
			{ path: "/", label: "Inbox", icon: "envelope" },
			{ path: "/settings", label: "Inbox Settings", icon: "envelope" },
		],
		options,
	};
}

const SETTINGS = {
	senderAddress: "settings:senderAddress",
	inboundSecret: "settings:inboundSecret",
} as const;

/**
 * Storage collections. Each document is an arbitrary JSON blob; declared fields
 * get indexed for querying. `ctx.storage.<collection>` gives get/put/query.
 *
 * Design:
 *   - `messages.id` is a UUID we mint; the RFC Message-ID is kept as a
 *     unique-indexed field so we can de-dupe on re-ingest without colliding
 *     on quirks in the header.
 *   - Status is an enum (inbox/snoozed/done/archived) rather than three bools
 *     to prevent illegal states like "snoozed AND done". `pinned` stays a
 *     separate bool because pinning is orthogonal to the status machine.
 *   - Thread IDs are derived at ingest from `In-Reply-To`/`References`
 *     headers (M3 work). Outbound rows get `threadId: null` until we teach
 *     the caller how to thread (M3).
 *   - `contacts.id` is the lowercased normalized email so upsert is a
 *     straight `get(id)` → mutate → `put(id)` with no hashing indirection.
 */
export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "inbox" | "snoozed" | "done" | "archived" | "draft" | "outbox";

export interface MessageDoc {
	admittedAt?: string;
	publicationPending?: boolean;
	bulkReceipt?: { operationId: string; candidateId: string };
	bundleEvidence?: import("./lib/bundles").BundleEvidence;
	deliveryAttemptId?: string;
	deliveryFingerprint?: string;
	deliveryCreatedAt?: string;
	deliveryProjected?: boolean;
	attachments?: StoredAttachment[];
	rawObjectKey?: string;
	indexDirty?: boolean;
	messageKey?: string;
	indexPreviousThreadIds?: string[];
	indexSchemaVersion?: number;
	/** RFC 5322 Message-ID (angle-bracketed). Unique per document. */
	messageId: string;
	/** Original transport ID, retained even if the provider returns an opaque ID. */
	transportMessageId?: string;
	/** Validated RFC ancestor identifiers, oldest first. Absent on older rows. */
	references?: string[];
	direction: MessageDirection;
	from: string;
	to: string;
	/** M8. All recipients when composing to multiple. First entry mirrored
	 *  into legacy `to` so pre-M8 readers keep working. Readers use
	 *  `toAll ?? [to]`. */
	toAll?: string[];
	/** M8. CC recipients. Absent on pre-M8 rows. */
	cc?: string[];
	/** M8. BCC recipients. Absent on pre-M8 rows; never rendered in thread
	 *  views of received copies (only stored on our own outbound rows). */
	bcc?: string[];
	subject: string;
	bodyText: string;
	bodyHtml: string | null;
	/** Original RFC822 MIME. Populated for inbound (M2). Null for outbound — CF builds the MIME itself. */
	bodyRaw: string | null;
	/** Derived from In-Reply-To/References at inbound ingest. Null until threaded (M3). */
	threadId: string | null;
	/** ISO8601. For outbound this is sent-time; for inbound it is receive-time. */
	receivedAt: string;
	/** Where the message originated. Plugin ID for plugin sends, "inbound" for incoming mail. */
	source: string;
	status: MessageStatus;
	pinned: boolean;
	/** M6. true once the user has opened the thread containing this message.
	 *  Inbound defaults false (just-arrived); outbound defaults true (we sent
	 *  it). Pre-M6 rows backfill to true (already-seen). */
	read: boolean;
	/** M4. Null until the bundle classifier runs. */
	bundleId: string | null;
	/** ISO8601. Drives inbox sort order. Equals receivedAt on create;
	 *  updated to wake-time when a snoozed message resurfaces. */
	sortAt: string;
	/** ISO8601. Only meaningful when status === "snoozed". Null otherwise. */
	snoozeUntil: string | null;
	/** Parent message's RFC 5322 Message-ID (angle-bracketed). Null when this
	 *  message starts a thread. Set at ingest from the In-Reply-To header
	 *  (inbound) or from the caller's inReplyTo field (outbound). Preserved
	 *  even when parent lookup fails, so the orphan-retry backfill pass can
	 *  retry linkage later. */
	inReplyTo: string | null;
}

export interface ContactDoc {
	email: string;
	name: string | null;
	firstSeenAt: string;
	lastContactAt: string;
	messageCount: number;
	inboundCount: number;
	outboundCount: number;
}

/** Project an accepted receipt into the same durable row; recovery never sends. */
async function projectSent(ctx: any, attempt: DeliveryAttempt): Promise<{ id: string; threadId: string }> {
	const deliveredMessageId = attempt.receipt?.messageId;
	const messageId = normalizeMessageId(deliveredMessageId) ?? `<sent-${attempt.messageId}@local>`;
	const snapshot = attempt.snapshot;
	return projectDeliveryMessage(ctx, attempt, {
		...snapshot,
		messageId, transportMessageId: deliveredMessageId,
		threadId: snapshot.inReplyTo ? snapshot.threadId ?? snapshot.inReplyTo : messageId,
		status: "done", read: true,
	});
}

/** Contact statistics are best effort; a mail receipt never depends on them. */
async function recordOutboundContact(ctx: any, email: string, at: string): Promise<void> {
	const id = email.trim().toLowerCase();
	for (let retry = 0; retry < 5; retry++) {
		const current = await ctx.storage.contacts.getVersioned(id);
		const prior = current?.value as ContactDoc | undefined;
		const next: ContactDoc = prior ? {
			...prior, lastContactAt: prior.lastContactAt > at ? prior.lastContactAt : at,
			messageCount: prior.messageCount + 1, outboundCount: prior.outboundCount + 1,
		} : { email, name: null, firstSeenAt: at, lastContactAt: at, messageCount: 1, inboundCount: 0, outboundCount: 1 };
		if ((await ctx.storage.contacts.compareAndSet(id, current?.revision ?? null, next)).applied) return;
	}
}

/** Advance bounded mailbox migration/repair; route callers can retry indexing. */
async function ensureMigrations(ctx: any): Promise<void> {
	await ensureMailboxIndex(ctx);
	if (ctx.cron) await ctx.cron.schedule("wake-snoozed-messages", { schedule: "*/5 * * * *" });
}

/**
 * Extract a single header value from raw RFC 822 text. Case-insensitive.
 * Handles folded continuations (RFC 5322 §2.2.3) by joining continuation
 * lines that start with whitespace. Returns trimmed value or null.
 */
function parseHeader(raw: string, name: string): string | null {
	const lines = raw.split(/\r?\n/);
	const prefix = name.toLowerCase() + ":";
	let found: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].toLowerCase().startsWith(prefix)) {
			let value = lines[i].slice(prefix.length).trim();
			// Fold continuation lines.
			while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
				value += " " + lines[i + 1].trim();
				i++;
			}
			found = value;
			break;
		}
		// Headers end at the first blank line.
		if (lines[i] === "") break;
	}
	return found;
}

async function persistInbound(
	ctx: any,
	rawMime: Uint8Array,
): Promise<{ msgId: string; from: string }> {
	const parsed = await PostalMime.parse(rawMime);
	const bodyBytes = new TextEncoder().encode(parsed.text ?? "").length + new TextEncoder().encode(parsed.html ?? "").length;
	if (bodyBytes > MAX_BODY_BYTES) throw new AttachmentError("bad_request", "Decoded message body exceeds 256 KiB");
	const now = new Date().toISOString();
	const msgId = crypto.randomUUID();
	const fromAddr = parsed.from?.address ?? "(unknown)";
	const fromName = parsed.from?.name ?? null;
	const toAddr = parsed.to?.[0]?.address ?? "(unknown)";
	// Mirrors the outbound `toAll ?? [to]` convention: if every parsed To
	// entry turned out to be an unaddressed group (see extractAddresses),
	// fall back to the single `toAddr` so reply-all math always has a `to`.
	const toAllList = extractAddresses(parsed.to);
	const toAll = toAllList.length > 0 ? toAllList : [toAddr];
	const cc = extractAddresses(parsed.cc);
	const messageId = parsed.messageId ?? `<${msgId}@emdash-inbox.local>`;

	// Replay-safe ingestion: do not write a second copy or attachment set.
	const duplicate = await ctx.storage.messages.query({ where: { messageId }, limit: 1 });
	if (duplicate.items?.[0]) {
		await finishMessageAdmission(ctx, duplicate.items[0].id);
		return { msgId: duplicate.items[0].id, from: fromAddr };
	}

	// Derive threadId from headers. postal-mime types `inReplyTo` as a single
	// Message-ID string and `references` as a space-separated string (per
	// RFC 5322). Tolerate array form too in case the parser shape shifts.
	const inReplyToHeader = parsed.inReplyTo ?? null;
	const rawRefs: unknown = parsed.references;
	const references: string[] = Array.isArray(rawRefs)
		? (rawRefs as string[])
		: typeof rawRefs === "string"
			? rawRefs.split(/\s+/).filter(Boolean)
			: [];

	const lookup = async (msgIdToFind: string) => {
		const hit = await (ctx.storage as any).messages.query({
			where: { messageId: msgIdToFind },
			limit: 1,
		});
		const row = hit.items?.[0];
		return row
			? { messageId: row.data.messageId, threadId: row.data.threadId ?? null }
			: null;
	};

	// deriveThreadInfo is sync; run the lookups first and cache a tiny map
	// over just the candidates.
	const candidates = new Set<string>();
	if (inReplyToHeader) candidates.add(inReplyToHeader);
	for (const r of references) candidates.add(r);

	const parents = new Map<string, { messageId: string; threadId: string | null }>();
	for (const c of candidates) {
		const p = await lookup(c);
		if (p) parents.set(c, p);
	}
	const syncLookup = (id: string) => parents.get(id) ?? null;

	const derived = deriveThreadInfo(messageId, inReplyToHeader, references, syncLookup);

	// Without attachments, keep legacy small MIME support on hosts without R2.
	// Files and large originals require private storage before accepting the mail.
	const files = parsed.attachments.length > 0 || rawMime.byteLength > 256 * 1024
		? await storeInboundFiles(ctx, rawMime, parsed) : undefined;
	const msg: MessageDoc = {
		messageId,
		...(files ?? {}),
		references: references.map(normalizeMessageId).filter((id): id is string => id !== null),
		direction: "inbound",
		from: fromAddr,
		to: toAddr,
		toAll,
		cc,
		subject: parsed.subject ?? "(no subject)",
		bodyText: parsed.text ?? "",
		bodyHtml: parsed.html ?? null,
		bodyRaw: files ? null : new TextDecoder().decode(rawMime),
		threadId: derived.threadId,
		receivedAt: now,
		source: "inbound",
		status: "inbox",
		pinned: false,
		read: false,   // inbound: just arrived, user hasn't seen it
		bundleId: null,
		sortAt: now,
		snoozeUntil: null,
		inReplyTo: derived.inReplyTo,
	};
	await putMessage(ctx, msgId, msg, { liveInbound: true });

	const contactId = fromAddr.trim().toLowerCase();
	const existing = (await ctx.storage.contacts.get(contactId)) as
		| ContactDoc
		| null;
	const contact: ContactDoc = existing
		? {
				...existing,
				name: existing.name ?? fromName,
				lastContactAt: now,
				messageCount: existing.messageCount + 1,
				inboundCount: existing.inboundCount + 1,
			}
		: {
				email: fromAddr,
				name: fromName,
				firstSeenAt: now,
				lastContactAt: now,
				messageCount: 1,
				inboundCount: 1,
				outboundCount: 0,
			};
	await ctx.storage.contacts.put(contactId, contact);

	return { msgId, from: fromAddr };
}

/**
 * Deliver one outbound email via the Cloudflare Email Sending native Workers
 * binding (`env.EMAIL.send()`) and persist the outbound row inline. Shared
 * between the `email:deliver` plugin hook (called by emdash for any plugin
 * invoking ctx.email.send) and the `messages/reply` route (called from the
 * admin compose form).
 *
 * Binding access: dynamic `await import('cloudflare:workers')` rather than
 * a static import — keeps the dependency on the Workers runtime lazy so
 * module evaluation works in non-Workers contexts (vitest, etc.); only the
 * handler firing requires the runtime. Mirrors the pattern used by other
 * CF Email Sending plugins (e.g. @coastweb/emdash-plugin-cloudflare-email).
 *
 * Persistence runs inline (not via `email:afterSend`) — emdash doesn't await
 * afterSend on Workers, so DB writes there hang as the request context tears
 * down. The durable journal records acceptance before mailbox projection;
 * recovery never invokes transport.
 *
 * Note: route callers bypass `email:intercept` hooks entirely (no
 * `beforeSend` / `afterSend` fires for route-initiated sends). Acceptable
 * today because our only intercept is a no-op `afterSend`. If a future
 * intercept hook starts doing real work, route callers must replicate it.
 */
async function deliverEmail(
	ctx: any,
	event: Parameters<Deliver>[1],
): Promise<DeliveryResult> {
	if (event.requestId) {
		const previous = await findDeliveryRequest(ctx, event.requestId, event.requestPayload ?? event.message);
		if (previous) return previous;
	}
	const kv = ctx.kv as { get<T>(key: string): Promise<T | null> };
	const senderAddress = await kv.get<string>(SETTINGS.senderAddress);

	if (!senderAddress) {
		throw new DeliverError(
			"emdash-inbox: cannot deliver email — missing settings: senderAddress. Configure in Admin → emdash-inbox → Settings.",
		);
	}

	// Reach the Workers binding via dynamic import. Keeps the dependency on the
	// Workers runtime lazy — module evaluation works in non-Workers contexts
	// (vitest, etc.); only the handler firing requires the runtime.
	let binding: EmailBinding;
	try {
		const { env } = await import("cloudflare:workers");
		const candidate = (env as Record<string, unknown>).EMAIL;
		if (!candidate || typeof (candidate as { send?: unknown }).send !== "function") {
			const bindingMissingErr = new Error("EMAIL binding missing or malformed");
			(bindingMissingErr as Error & { code: string }).code = "EMAIL_BINDING_MISSING";
			throw bindingMissingErr;
		}
		binding = candidate as EmailBinding;
	} catch (err) {
		throw new DeliverError(
			`emdash-inbox: env.EMAIL binding unavailable — check wrangler.jsonc has send_email[{name:"EMAIL"}]. (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	const payload: Parameters<EmailBinding["send"]>[0] = {
		to: event.message.toAll ?? event.message.to,
		from: senderAddress,
		subject: event.message.subject,
		text: event.message.text,
	};
	if (event.message.html) payload.html = event.message.html;
	if (event.message.cc?.length) payload.cc = event.message.cc;
	if (event.message.bcc?.length) payload.bcc = event.message.bcc;
	const attachments = await prepareOutgoingAttachments(ctx, event.message.attachments, event.message.text, event.message.html);
	const inline = await embedInlineImages(event.message.html);
	if (inline.attachments.length) {
		if (attachments.length + inline.attachments.length > 32) throw new AttachmentError("bad_request", "At most 32 attachments and inline images are supported.");
		payload.html = inline.html;
		attachments.push(...inline.attachments);
	}
	if (attachments.length) payload.attachments = attachments;
	let references: string[] = [];
	const parentId = normalizeMessageId(event.message.inReplyTo);
	if (parentId) {
		const parents = await ctx.storage.messages.query({ where: { messageId: parentId }, limit: 1 });
		const parent = parents.items?.[0]?.data as MessageDoc | undefined;
		const ancestors = parent?.references ?? (parent?.bodyRaw ? parseHeader(parent.bodyRaw, "References")?.split(/\s+/) : []) ?? [];
		references = replyReferences(ancestors, parentId);
		payload.headers = {
			"In-Reply-To": parentId,
			"References": references.join(" "),
		};
	}

	const now = new Date().toISOString();
	const parentRows = parentId ? await ctx.storage.messages.query({ where: { messageId: parentId }, limit: 1 }) : null;
	const parent = parentRows?.items?.[0]?.data as MessageDoc | undefined;
	const snapshot: MessageDoc = {
		...(event.draftClaim?.snapshot ?? {}),
		messageId: event.draftClaim?.snapshot.messageId ?? `<outbox-${crypto.randomUUID()}@local>`,
		direction: "outbound", from: senderAddress,
		to: event.message.to, toAll: event.message.toAll ?? [event.message.to],
		cc: event.message.cc ?? [], bcc: event.message.bcc ?? [],
		subject: event.message.subject, bodyText: event.message.text, bodyHtml: event.message.html ?? null,
		bodyRaw: null, attachments: event.message.attachments ?? [], references,
		inReplyTo: parentId, threadId: parentId ? parent?.threadId ?? parentId : null,
		receivedAt: now, sortAt: now, source: event.source, status: "outbox",
		pinned: false, read: true, bundleId: null, snoozeUntil: null,
	};
	let acceptedByTransport = false;
	const delivery = await runDelivery(ctx, {
		snapshot, messageId: event.draftClaim?.id, expectedRevision: event.draftClaim?.revision,
		requestId: event.requestId, requestPayload: event.requestPayload ?? event.message,
	}, {
		transport: async () => {
			try {
				const receipt = await binding.send(payload);
				acceptedByTransport = true;
				return receipt;
			}
			catch (error) { throw wrapBindingError(error); }
		},
		projectSent,
	});
	// Reconciliation/replayed requests do not increment contact counts again.
	if (acceptedByTransport) {
		try { await recordOutboundContact(ctx, event.message.to, now); }
		catch { ctx.log.warn("emdash-inbox: contact statistics update interrupted"); }
	}
	return delivery;
}

/**
 * Maps errors from the shared compose/draft core (`composeOps.ts`) and from
 * `deliverEmail`'s `DeliverError` onto the wire error shape every route in
 * this file uses. `NotFoundError` must be checked before `ComposeError`
 * since the former extends the latter.
 */
function mapComposeError(err: unknown): never {
	if (err instanceof MailboxInputError) throw PluginRouteError.badRequest(err.message);
	if (err instanceof AttachmentError) {
		if (err.code === "not_found") throw PluginRouteError.notFound(err.message);
		throw PluginRouteError.badRequest(err.message);
	}
	if (err instanceof NotFoundError) throw PluginRouteError.notFound(err.message);
	if (err instanceof ComposeError) throw PluginRouteError.badRequest(err.message);
	if (err instanceof DeliveryError) throw PluginRouteError.badRequest(err.message);
	if (err instanceof DeliverError) throw PluginRouteError.badRequest(err.message);
	const msg = err instanceof Error ? err.message : String(err);
	throw PluginRouteError.internal(`send failed: ${msg}`);
}

async function requireMailboxRouteReady(ctx: any): Promise<void> {
	try { await requireMailboxReady(ctx); } catch (err) { mapComposeError(err); }
}

function statusPatch(doc: MessageDoc, status: "inbox" | "done" | "snoozed", snoozeUntil?: string): Partial<MessageDoc> {
	if (doc.status === "draft" || doc.status === "outbox") throw PluginRouteError.badRequest("Drafts cannot change mailbox status");
	if (status === "snoozed" && (typeof snoozeUntil !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(snoozeUntil) || !Number.isFinite(Date.parse(snoozeUntil)))) throw PluginRouteError.badRequest("snoozeUntil must be an ISO date string");
	const check = validateTransition(doc.status, status, snoozeUntil);
	if (!check.ok) throw PluginRouteError.badRequest(check.error);
	return { status, snoozeUntil: status === "snoozed" ? new Date(snoozeUntil!).toISOString() : null, ...(status === "inbox" ? {sortAt: new Date().toISOString()} : {}) };
}

/**
 * Plugin definition — runs on the deployed server at request time.
 *
 * Transport: outbound delivery flows through the native Cloudflare Email
 * Sending Workers binding (`env.EMAIL.send()`), reached via dynamic
 * `await import("cloudflare:workers")` inside `deliverEmail()`. EmDash's
 * `PluginContext` still doesn't expose host env bindings, but the Workers
 * runtime provides the same `env` as a module-level import — the dynamic
 * variant keeps the dependency on the Workers runtime lazy so module
 * evaluation works in non-Workers contexts (vitest, etc.).
 *
 * Pre-M7 we POSTed to the CF Email Service REST API with an operator-
 * minted API token. M7 dropped that path entirely; the binding handles
 * auth implicitly via the Worker's CF account.
 */
export function createPlugin(options: { deliveryEvents?: DeliveryEventScope } = {}) {
	const native = nativeInboxMcp(deliverEmail, ensureMigrations, mapComposeError, projectSent);
	return definePlugin({
		id: "emdash-inbox",
		version: VERSION,

		capabilities: [
			"email:provide",
			"email:intercept",
			// EmDash 0.14+ gates email hook registration behind these explicit
			// capabilities. email:deliver needs hooks.email-transport:register;
			// email:afterSend needs hooks.email-events:register.
			"hooks.email-transport:register",
			"hooks.email-events:register",
		],

		storage: {
			...mailboxCollections,
			...bundleCollections,
			...bundleOperationCollections,
			...threadMutationCollections,
			...attachmentCollections,
			...deliveryCollections,
			providerDeliveries: { indexes: ["messageId"] },
			messages: {
				indexes: [
					...mailboxMessageIndexes,
					...deliveryMessageIndexes,
					"receivedAt",
					"sortAt",
					"snoozeUntil",
					"threadId",
					"status",
					"pinned",
					"from",
					"direction",
				],
				uniqueIndexes: ["messageId"],
			},
			contacts: {
				indexes: ["lastContactAt"],
			},
		},

		hooks: {
			"plugin:install": async (_event, ctx) => {
				ctx.log.info("emdash-inbox installed");
				await ensureMigrations(ctx);
			},

			"plugin:activate": async (_event, ctx) => {
				await ensureMigrations(ctx);
			},

			"cron": async (event, ctx) => {
				if (event.name !== "wake-snoozed-messages") return;

				const now = new Date().toISOString();

				const woken = await wakeSnoozed(ctx, now);
				await ensureMailboxIndex(ctx);
				await retryAttachmentCleanup(ctx);
				await reconcileDeliveries(ctx, projectSent);

				if (woken > 0) {
					ctx.log.info("emdash-inbox: woke snoozed messages", { woken });
				}
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					const delivery = await deliverEmail(ctx, event);
					if (delivery.deliveryStatus !== "sent" && !delivery.providerAccepted) {
						throw new DeliverError(delivery.deliveryStatus === "failed"
							? `Email was rejected; review its saved draft (${delivery.attemptId}).`
							: `Email delivery needs Outbox review before retrying (${delivery.attemptId}).`);
					}
				},
			},

			"email:afterSend": async (event, ctx) => {
				// Intentionally a no-op in v0.5.0: emdash doesn't await afterSend, so
				// any DB work here runs after the request context is torn down and
				// hangs. Persistence happens inline in email:deliver instead.
				ctx.log.debug("email:afterSend", {
					to: event.message.to,
					source: event.source,
				});
			},
		},

		mcp: native.mcp,
		routes: {
			...native.routes,
			"delivery-events/record": {
				permission: "plugins:manage",
				handler: async (ctx) => recordProviderEvent(ctx as any, ctx.input, options.deliveryEvents),
			},
			...bundleRoutes,
			...bundleOperationRoutes,
			"ui/preferences": { permission: "plugins:manage", handler: readInboxPreferences },
			"ui/preferences-save": { permission: "plugins:manage", handler: saveInboxPreferences },
			"signature/get": { permission: "plugins:manage", handler: readSignature },
			"signature/save": { permission: "plugins:manage", handler: saveSignature },
			"messages/search": {
				permission: "plugins:manage",
				handler: async (ctx) => {
					try { return await searchMessagePage(ctx, (ctx.input ?? {}) as any); }
					catch (err) { return mapComposeError(err); }
				},
			},
			"threads/list": {
				permission: "plugins:manage",
				handler: async (ctx) => {
					try { return await listThreadPage(ctx, (ctx.input ?? {}) as any); }
					catch (err) { return mapComposeError(err); }
				},
			},
			"threads/action": {
				permission: "plugins:manage",
				handler: async (ctx) => {
					const input = (ctx.input ?? {}) as any;
					await requireMailboxRouteReady(ctx);
					if (typeof input.threadId !== "string" || !input.threadId) throw PluginRouteError.badRequest("threadId is required");
					if (input.action === "pin" && typeof input.pinned === "boolean") return mutateThread(ctx, input.threadId, () => ({ pinned: input.pinned }));
					if (input.action === "read" && typeof input.read === "boolean") return mutateThread(ctx, input.threadId, () => ({ read: input.read }));
					if (input.action === "status" && ["inbox", "done", "snoozed"].includes(input.status)) {
						return mutateThread(ctx, input.threadId, (doc) => statusPatch(doc, input.status, input.snoozeUntil));
					}
					throw PluginRouteError.badRequest("Invalid thread action");
				},
			},
			"attachments/upload": {
				permission: "plugins:manage",
				handler: async (ctx) => { try { return await uploadDraftAttachment(ctx, ctx.input as any); } catch (err) { return mapComposeError(err); } },
			},
			"attachments/remove": {
				permission: "plugins:manage",
				handler: async (ctx) => { try { return await removeDraftAttachment(ctx, ctx.input as any); } catch (err) { return mapComposeError(err); } },
			},
			"attachments/read": {
				permission: "plugins:manage",
				handler: async (ctx) => { try { return await readAttachment(ctx, ctx.input as any); } catch (err) { return mapComposeError(err); } },
			},
			"messages/list": {
				handler: async (ctx) => {
					await ensureMigrations(ctx);
					const input = (ctx.input ?? {}) as { status?: StatusFilter };
					const sender = await ctx.kv.get<string>(SETTINGS.senderAddress) ?? "";
					const rows = await allRows<MessageDoc>((ctx.storage as any).messages);
					const items = aggregateThreads(rows, input.status ?? "inbox", sender).map((t) => ({...t, latest: publicMessage(t.latest), previous: t.previous ? publicMessage(t.previous) : null}));
					return { items };
				},
			},

			"messages/pin": {
				handler: async (routeCtx) => {
					const input = routeCtx.input as { id?: unknown; pinned?: unknown } | null;
					const id = typeof input?.id === "string" ? input.id : null;
					const pinned = typeof input?.pinned === "boolean" ? input.pinned : null;
					if (!id || pinned === null) {
						throw PluginRouteError.badRequest(
							"body must include id:string and pinned:boolean",
						);
					}
					const updated = await mutateMessage(routeCtx, id, () => ({ pinned }));
					if (!updated) throw PluginRouteError.notFound(`message ${id} not found`);
					return { ok: true };
				},
			},

			"messages/status": {
				handler: async (routeCtx) => {
					const input = routeCtx.input as
						| { id?: unknown; status?: unknown; snoozeUntil?: unknown }
						| null;

					const id = typeof input?.id === "string" ? input.id : null;
					const status = input?.status;
					const snoozeUntil =
						typeof input?.snoozeUntil === "string" ? input.snoozeUntil : undefined;

					if (!id || (status !== "inbox" && status !== "snoozed" && status !== "done")) {
						throw PluginRouteError.badRequest(
							"body must include id:string and status:'inbox'|'snoozed'|'done'",
						);
					}

					const next = await mutateMessage(routeCtx, id, (doc) => statusPatch(doc, status, snoozeUntil));
					if (!next) throw PluginRouteError.notFound(`message ${id} not found`);
					return { ok: true, status: next.status };
				},
			},

			"messages/thread": {
				handler: async (routeCtx) => {
					await requireMailboxRouteReady(routeCtx);

					const input = routeCtx.input as { id?: unknown } | null;
					const id = typeof input?.id === "string" ? input.id : null;
					if (!id) {
						throw PluginRouteError.badRequest("body must include id:string");
					}

					const row = await (routeCtx.storage as any).messages.get(id);
					if (!row) {
						throw PluginRouteError.notFound(`message ${id} not found`);
					}

					const threadId = row.threadId ?? row.messageId;
					const rows = await loadThreadRows(routeCtx, threadId);
					try { await mutateThread(routeCtx, threadId, doc => doc.read ? null : ({ read: true })); }
					catch { routeCtx.log.warn("emdash-inbox: thread loaded but mark-read failed", { threadId }); }
					const items = await Promise.all(rows.map(async (r) => ({ id: r.id, data: { ...publicMessage(r.data), providerDelivery: await readProviderDelivery(routeCtx as any, r.data) } })));

					return { items };
				},
			},

			"messages/reply": {
				handler: async (routeCtx) => {
					await requireMailboxRouteReady(routeCtx);

					const input = routeCtx.input as
						| { requestId?: string; inReplyTo?: unknown; to?: unknown; cc?: unknown; subject?: unknown; text?: unknown; html?: unknown }
						| null;

					const inReplyTo = typeof input?.inReplyTo === "string" ? input.inReplyTo.trim() : "";
					const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
					const text = typeof input?.text === "string" ? input.text : "";
					const html = typeof input?.html === "string" ? input.html : "";

					if (!inReplyTo) {
						throw PluginRouteError.badRequest("inReplyTo: required non-empty string");
					}

					// `to` accepts the same string | string[] shapes as compose/reply-all —
					// split/validate/dedupe via normalizeRecipients, mirroring `cc` below.
					const toInput = input?.to as string | string[] | undefined;
					const toResult = normalizeRecipients(toInput);
					if (!toResult.ok) {
						throw PluginRouteError.badRequest(toResult.error);
					}
					const toList = toResult.value;
					if (toList.length === 0) {
						throw PluginRouteError.badRequest("to: required, must be one or more valid email addresses");
					}

					if (!subject) {
						throw PluginRouteError.badRequest("subject: required non-empty string");
					}
					if (!text) {
						throw PluginRouteError.badRequest("text: required non-empty string");
					}
					if (!html) {
						throw PluginRouteError.badRequest("html: required non-empty string");
					}

					// cc is optional — this is the UI reply-all send path (client derives
					// + user edits recipients; server still validates via the same
					// recipient-parsing rules compose/reply-all use).
					const ccInput = input?.cc as string | string[] | undefined;
					const ccResult = normalizeRecipients(ccInput);
					if (!ccResult.ok) {
						throw PluginRouteError.badRequest(ccResult.error);
					}
					const cc = ccResult.value;

					// Server-side re-sanitization is deferred to a DOM-free sanitizer
					// (linkedom-backed DOMPurify or sanitize-html via parse5) — the
					// browser-only DOMPurify we use client-side throws server-side because
					// Cloudflare Workers has no window. Trust constraint for M5: the route
					// is admin-authenticated, and TipTap StarterKit constrains the wire
					// HTML to a known element set. Tracked in deferred list.

					try {
						return await deliverEmail(routeCtx, {
							requestId: input?.requestId,
							requestPayload: { operation: "reply-message", ...input, requestId: undefined },
							message: {
								to: toList[0],
								toAll: toList,
								subject,
								text,
								html,
								inReplyTo,
								...(cc.length ? { cc } : {}),
							},
							source: "emdash-inbox:reply",
						});
					} catch (err) {
						mapComposeError(err);
					}

					return { ok: true };
				},
			},

			"messages/compose": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);
					const input = (routeCtx.input ?? {}) as ComposeInput;
					try {
						return await composeSend(routeCtx, deliverEmail, input);
					} catch (err) {
						mapComposeError(err);
					}
				},
			},

			"deliveries/list": {
				permission: "plugins:manage", input: listDeliveriesInput,
				handler: async (ctx) => {
					try { await reconcileDeliveries(ctx, projectSent); return await listDeliveries(ctx, listDeliveriesInput.parse(ctx.input)); }
					catch (error) { return mapComposeError(error); }
				},
			},
			"deliveries/reconcile": {
				permission: "plugins:manage",
				handler: async (ctx) => {
					try { return await reconcileDeliveries(ctx, projectSent); }
					catch (error) { return mapComposeError(error); }
				},
			},
			"deliveries/resolve": {
				permission: "plugins:manage", input: resolveDeliveryInput,
				handler: async (ctx) => {
					try { return await resolveDelivery(ctx, projectSent, resolveDeliveryInput.parse(ctx.input)); }
					catch (error) { return mapComposeError(error); }
				},
			},

			"messages/reply-all": {
				handler: async (routeCtx) => {
					await requireMailboxRouteReady(routeCtx);
					const input = (routeCtx.input ?? {}) as Omit<ReplyInput, "replyAll">;
					try {
						return await replySend(routeCtx, deliverEmail, { ...input, replyAll: true });
					} catch (err) {
						mapComposeError(err);
					}
				},
			},

			"messages/draft-save": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);
					try {
						const input = (routeCtx.input ?? {}) as DraftInput;
						if (input.threadId) await requireMailboxRouteReady(routeCtx);
						return await draftSave(routeCtx, input);
					} catch (err) {
						mapComposeError(err);
					}
				},
			},

			"messages/draft-send": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);
					const input = (routeCtx.input ?? {}) as { draftId?: string; edits?: Partial<ComposeInput>; requestId?: string };
					if (typeof input.draftId !== "string" || input.draftId === "") {
						throw PluginRouteError.badRequest("draftId: required non-empty string");
					}
					try {
						return await draftSend(routeCtx, deliverEmail, { draftId: input.draftId, edits: input.edits, requestId: input.requestId });
					} catch (err) {
						mapComposeError(err);
					}
				},
			},

			"messages/draft-discard": {
				handler: async (routeCtx) => {
					const input = (routeCtx.input ?? {}) as { draftId?: string };
					if (typeof input.draftId !== "string" || input.draftId === "") {
						throw PluginRouteError.badRequest("draftId: required non-empty string");
					}
					try {
						return await draftDiscard(routeCtx, { draftId: input.draftId });
					} catch (err) {
						mapComposeError(err);
					}
				},
			},

			"messages/drafts": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);
					const rows = await listDrafts(routeCtx);
					return {
						items: rows.map((r) => ({
							...draftSummaryOf(r),
							bodyHtml: r.data.bodyHtml,
							bodyText: r.data.bodyText,
							cc: r.data.cc ?? [],
							bcc: r.data.bcc ?? [],
							attachments: publicMessage(r.data).attachments ?? [],
						})),
					};
				},
			},

			"messages/mcp": {
				// Admin-auth (default) — EmDash gates the route on session cookie
				// or Bearer API token before this handler fires. The MCP wire
				// dispatcher itself is auth-agnostic; it trusts that anyone who
				// reaches it has full inbox access. See `lib/inboxMcpHandlers.ts`
				// for the choice of manual JSON-RPC dispatch over the SDK runtime.
				handler: async (routeCtx) => {
					if ((routeCtx.input as {method?: string})?.method === "tools/call") await ensureMigrations(routeCtx);
					const { dispatchMcpRequest } = await import("./lib/inboxMcpHandlers");
					return dispatchMcpRequest(routeCtx, routeCtx.input ?? {}, deliverEmail, projectSent);
				},
			},

			// Settings read/write for the plugin's own admin page. EmDash never
			// grew the auto-generated UI its settingsSchema type annotation
			// promises (verified against 0.29: the schema isn't even sent to the
			// admin frontend, and core ships no setter API), so the plugin owns
			// this surface itself. Also curl-able with an admin token for
			// headless setups.
			"settings/get": {
				handler: async (routeCtx) => {
					const senderAddress =
						(await routeCtx.kv.get<string>(SETTINGS.senderAddress)) ?? "";
					const inboundSecret = await routeCtx.kv.get<string>(SETTINGS.inboundSecret);
					// The secret itself is write-only from here — operators paste it
					// into the sidecar at set time; the API only reports presence.
					return { senderAddress, inboundSecretSet: Boolean(inboundSecret) };
				},
			},

			"settings/save": {
				handler: async (routeCtx) => {
					const input = (routeCtx.input ?? {}) as {
						senderAddress?: unknown;
						inboundSecret?: unknown;
					};
					if (input.senderAddress !== undefined) {
						const addr =
							typeof input.senderAddress === "string" ? input.senderAddress.trim() : "";
						if (addr === "" || !/^\S+@\S+\.\S+$/.test(addr)) {
							throw PluginRouteError.badRequest(
								"senderAddress: must be an email address on a domain onboarded for Cloudflare Email Sending",
							);
						}
						await routeCtx.kv.set(SETTINGS.senderAddress, addr);
					}
					if (input.inboundSecret !== undefined) {
						const secret =
							typeof input.inboundSecret === "string" ? input.inboundSecret.trim() : "";
						if (secret.length < 16) {
							throw PluginRouteError.badRequest(
								"inboundSecret: use at least 16 characters — a long random string shared only with the inbound sidecar worker",
							);
						}
						await routeCtx.kv.set(SETTINGS.inboundSecret, secret);
					}
					return { ok: true };
				},
			},

			inbound: {
				public: true,
				handler: async (routeCtx) => {
					const expected = await routeCtx.kv.get<string>(
						SETTINGS.inboundSecret,
					);
					if (!expected) {
						// unauthorized (401), not internal (500): emdash masks internal
						// messages to "Plugin route error" on the wire, which reads as a
						// crash to an operator mid-setup. No secret configured means no
						// caller can authenticate yet — say so plainly.
						throw PluginRouteError.unauthorized(
							"inbound endpoint not configured — set the inboundSecret plugin setting, then retry",
						);
					}
					// X-Inbound-Secret header (not Authorization/Bearer — emdash's auth
					// middleware claims Bearer globally, even for public plugin routes).
					const provided = routeCtx.request.headers.get("x-inbound-secret") ?? "";
					if (provided !== expected) {
						throw PluginRouteError.unauthorized();
					}

					const input = routeCtx.input as { rawMime?: unknown; rawMimeBase64?: unknown } | null;
					let rawMime: Uint8Array;
					try {
						if (typeof input?.rawMimeBase64 === "string") {
							if (input.rawMimeBase64.length > Math.ceil(MAX_INBOUND_BYTES / 3) * 4) throw new Error("Inbound message exceeds 8 MiB");
							rawMime = decodeBase64(input.rawMimeBase64, MAX_INBOUND_BYTES);
						} else if (typeof input?.rawMime === "string") rawMime = new TextEncoder().encode(input.rawMime);
						else throw new Error("rawMimeBase64 or rawMime is required");
						if (!rawMime.byteLength || rawMime.byteLength > MAX_INBOUND_BYTES) throw new Error("Inbound message must be between 1 byte and 8 MiB");
					} catch (err) { throw PluginRouteError.badRequest(err instanceof Error ? err.message : "Invalid MIME envelope"); }

					try {
						const { msgId, from } = await persistInbound(
							routeCtx as any,
							rawMime,
						);
						routeCtx.log.info("emdash-inbox: inbound persisted", {
							msgId,
							from,
						});
						return { ok: true, id: msgId };
					} catch (err) {
						if (err instanceof PluginRouteError) throw err;
						if (err instanceof AttachmentError) mapComposeError(err);
						routeCtx.log.error("emdash-inbox: inbound parse/persist failed", {
							error: err instanceof Error ? err.message : String(err),
						});
						throw PluginRouteError.badRequest(
							"failed to parse or persist MIME",
						);
					}
				},
			},
		},

		admin: {
			pages: [{ path: "/", label: "Inbox", icon: "envelope" }],
			// settingsSchema defaults are not materialized automatically by EmDash;
			// the hook above validates presence at send time and throws if missing.
			settingsSchema: {
				senderAddress: {
					type: "string",
					label: "Verified sender address",
					description:
						"Must be a sender on a domain you have onboarded to Cloudflare Email Sending (e.g. hello@yourdomain.com). Onboard at Dashboard → Compute & AI → Email Service → Email Sending → Onboard Domain.",
				},
				inboundSecret: {
					type: "secret",
					label: "Inbound webhook shared secret",
					description:
						"Arbitrary string. Configured also on your Cloudflare Email Worker (sent as the X-Inbound-Secret header) so only that worker can POST to the inbound endpoint.",
				},
			},
		},
	});
}

export default createPlugin;
