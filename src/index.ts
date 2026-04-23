import { definePlugin, PluginRouteError } from "emdash";
import type { PluginDescriptor } from "emdash";
import PostalMime from "postal-mime";
import { validateTransition } from "./lib/statusTransitions";
import { deriveThreadInfo } from "./lib/threadDerive";
import { aggregateThreads, type StatusFilter } from "./lib/threadSummary";

/**
 * Plugin descriptor — imported in the host site's `astro.config.mjs`.
 * Runs at build time in Vite; must be side-effect-free (no runtime APIs).
 */
export function emdashInboxPlugin(): PluginDescriptor {
	return {
		id: "emdash-inbox",
		version: "0.6.1",
		format: "native",
		entrypoint: "emdash-inbox",
		adminEntry: "emdash-inbox/admin",
		adminPages: [{ path: "/", label: "Inbox", icon: "envelope" }],
		options: {},
	};
}

const SETTINGS = {
	accountId: "settings:accountId",
	apiToken: "settings:apiToken",
	senderAddress: "settings:senderAddress",
	inboundSecret: "settings:inboundSecret",
} as const;

const CF_SEND_ENDPOINT = (accountId: string) =>
	`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;

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
export type MessageStatus = "inbox" | "snoozed" | "done" | "archived";

export interface MessageDoc {
	/** RFC 5322 Message-ID (angle-bracketed). Unique per document. */
	messageId: string;
	direction: MessageDirection;
	from: string;
	to: string;
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

async function persistOutbound(
	ctx: any,
	event: {
		message: {
			to: string;
			subject: string;
			text: string;
			html?: string;
			inReplyTo?: string;
		};
		source: string;
	},
	senderAddress: string,
): Promise<void> {
	const now = new Date().toISOString();
	const msgId = crypto.randomUUID();
	const senderDomain = senderAddress.split("@")[1] ?? "emdash-inbox.local";
	const messageId = `<${msgId}@${senderDomain}>`;

	// Derive threadId from inReplyTo (if caller provided).
	const inReplyToHeader = event.message.inReplyTo ?? null;
	let derivedThreadId = messageId;
	let derivedInReplyTo: string | null = null;
	if (inReplyToHeader) {
		const hit = await (ctx.storage as any).messages.query({
			where: { messageId: inReplyToHeader },
			limit: 1,
		});
		const parent = hit.items?.[0];
		const lookup = (id: string) =>
			parent && parent.data.messageId === id
				? { messageId: parent.data.messageId, threadId: parent.data.threadId ?? null }
				: null;
		const derived = deriveThreadInfo(messageId, inReplyToHeader, [], lookup);
		derivedThreadId = derived.threadId;
		derivedInReplyTo = derived.inReplyTo;
	}

	const msg: MessageDoc = {
		messageId,
		direction: "outbound",
		from: senderAddress,
		to: event.message.to,
		subject: event.message.subject,
		bodyText: event.message.text,
		bodyHtml: event.message.html ?? null,
		bodyRaw: null,
		threadId: derivedThreadId,
		receivedAt: now,
		source: event.source,
		status: "done",
		pinned: false,
		read: true,   // outbound: we sent it, nothing to read
		bundleId: null,
		sortAt: now,
		snoozeUntil: null,
		inReplyTo: derivedInReplyTo,
	};
	await ctx.storage.messages.put(msgId, msg);

	const contactId = event.message.to.trim().toLowerCase();
	const existing = (await ctx.storage.contacts.get(contactId)) as
		| ContactDoc
		| null;
	const contact: ContactDoc = existing
		? {
				...existing,
				lastContactAt: now,
				messageCount: existing.messageCount + 1,
				outboundCount: existing.outboundCount + 1,
			}
		: {
				email: event.message.to,
				name: null,
				firstSeenAt: now,
				lastContactAt: now,
				messageCount: 1,
				inboundCount: 0,
				outboundCount: 1,
			};
	await ctx.storage.contacts.put(contactId, contact);
}

/**
 * Idempotent M3 setup — backfills sortAt/snoozeUntil on any pre-M3 message
 * rows, and (when `ctx.cron` is available) ensures the wake-snoozed cron is
 * scheduled.
 *
 * Called from three places, each with slightly different ctx shape:
 *   - plugin:install  (fresh installs)         — ctx.cron is populated
 *   - plugin:activate (admin-UI activations)    — ctx.cron is populated
 *   - messages/list route (lazy, every request) — ctx.cron is UNDEFINED
 *
 * The route context skip is a quirk of EmDash v0.5.0: PluginRouteHandler
 * constructs its own PluginContextFactory at boot, before the cron scheduler
 * wires `cronReschedule` into the hook-pipeline factory — so route contexts
 * never get `ctx.cron`. We tolerate this by skipping the schedule call when
 * ctx.cron is missing.
 *
 * For config-registered plugins (astro.config.mjs) the admin-UI activate path
 * is the ONLY way to fire plugin:activate. To schedule the cron on such
 * sites, navigate to the admin plugins page and enable the plugin explicitly.
 *
 * All operations are idempotent:
 *   - Row backfill is guarded by `if (sortAt && snoozeUntil !== undefined) continue`.
 *   - `ctx.cron.schedule` upserts by name (backed by _emdash_cron_tasks unique
 *     index on (plugin_id, task_name)).
 *
 * Pre-alpha data volumes make the full-scan backfill cheap. If message counts
 * grow into the tens of thousands, gate with a kv "m3:migrated" flag so the
 * scan runs once per worker instead of per-request.
 */
async function ensureMigrations(ctx: any): Promise<void> {
	const all = await ctx.storage.messages.query({ limit: 10000 });
	const rows = all.items as { id: string; data: any }[];

	// --- Pass 1: sortAt / snoozeUntil (M3) ---
	let pass1 = 0;
	for (const row of rows) {
		if (row.data.sortAt && row.data.snoozeUntil !== undefined) continue;
		await ctx.storage.messages.put(row.id, {
			...row.data,
			sortAt: row.data.sortAt ?? row.data.receivedAt,
			snoozeUntil: row.data.snoozeUntil ?? null,
		});
		pass1++;
	}
	if (pass1 > 0) ctx.log.info("emdash-inbox: backfilled sortAt/snoozeUntil", { migrated: pass1 });

	// Re-query so pass 2 sees the pass-1 writes.
	const afterPass1 = await ctx.storage.messages.query({ limit: 10000 });
	const freshRows = afterPass1.items as { id: string; data: any }[];

	// Build a lookup by messageId for pass 2 + pass 3.
	const byMessageId = new Map<string, { messageId: string; threadId: string | null }>();
	for (const r of freshRows) {
		byMessageId.set(r.data.messageId, {
			messageId: r.data.messageId,
			threadId: r.data.threadId ?? null,
		});
	}
	const lookup = (msgId: string) => byMessageId.get(msgId) ?? null;

	// --- Pass 2: threadId derivation (M4) ---
	let pass2 = 0;
	for (const row of freshRows) {
		if (row.data.threadId) continue;

		// Parse In-Reply-To + References from bodyRaw if we have it.
		let inReplyToHeader: string | null = null;
		let references: string[] = [];
		if (row.data.bodyRaw) {
			// Simple header scan. Full MIME re-parse via postal-mime is overkill for
			// a header grep; bodyRaw has the original raw text.
			inReplyToHeader = parseHeader(row.data.bodyRaw, "In-Reply-To");
			const refsRaw = parseHeader(row.data.bodyRaw, "References");
			if (refsRaw) references = refsRaw.split(/\s+/).filter(Boolean);
		}
		// Outbound rows don't have bodyRaw but might have data.inReplyTo already
		// if they were written by a future persistOutbound that we haven't shipped
		// yet. Prefer the explicit field when present.
		if (!inReplyToHeader && row.data.inReplyTo) {
			inReplyToHeader = row.data.inReplyTo;
		}

		const derived = deriveThreadInfo(
			row.data.messageId,
			inReplyToHeader,
			references,
			lookup,
		);

		await ctx.storage.messages.put(row.id, {
			...row.data,
			threadId: derived.threadId,
			inReplyTo: derived.inReplyTo,
		});

		// Update our in-memory lookup so later rows in the same pass can resolve
		// ancestors that were just processed.
		byMessageId.set(row.data.messageId, {
			messageId: row.data.messageId,
			threadId: derived.threadId,
		});
		pass2++;
	}
	if (pass2 > 0) ctx.log.info("emdash-inbox: backfilled threadId", { migrated: pass2 });

	// --- Pass 3: orphan retry (handles reply-before-parent in pass 2) ---
	if (pass2 > 0) {
		const afterPass2 = await ctx.storage.messages.query({ limit: 10000 });
		let pass3 = 0;
		for (const row of afterPass2.items as { id: string; data: any }[]) {
			if (row.data.threadId !== row.data.messageId) continue;
			if (!row.data.inReplyTo) continue;

			const parent = byMessageId.get(row.data.inReplyTo);
			if (!parent) continue;
			const inheritedThreadId = parent.threadId ?? parent.messageId;
			if (inheritedThreadId === row.data.threadId) continue;

			await ctx.storage.messages.put(row.id, {
				...row.data,
				threadId: inheritedThreadId,
			});
			byMessageId.set(row.data.messageId, {
				messageId: row.data.messageId,
				threadId: inheritedThreadId,
			});
			pass3++;
		}
		if (pass3 > 0) ctx.log.info("emdash-inbox: orphan-retry linked threads", { migrated: pass3 });
	}

	// --- Pass 4: read backfill (M6) ---
	let pass4 = 0;
	const allForRead = await ctx.storage.messages.query({ limit: 10000 });
	for (const row of allForRead.items as { id: string; data: any }[]) {
		if (typeof row.data.read === "boolean") continue;
		await ctx.storage.messages.put(row.id, {
			...row.data,
			read: true,   // pre-M6 rows treated as already-seen
		});
		pass4++;
	}
	if (pass4 > 0) ctx.log.info("emdash-inbox: backfilled read", { migrated: pass4 });

	// --- Cron schedule (M3; unchanged) ---
	if (ctx.cron) {
		await ctx.cron.schedule("wake-snoozed-messages", {
			schedule: "*/5 * * * *",
		});
	}
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
	rawMime: string,
): Promise<{ msgId: string; from: string }> {
	const parsed = await PostalMime.parse(rawMime);
	const now = new Date().toISOString();
	const msgId = crypto.randomUUID();
	const fromAddr = parsed.from?.address ?? "(unknown)";
	const fromName = parsed.from?.name ?? null;
	const toAddr = parsed.to?.[0]?.address ?? "(unknown)";
	const messageId = parsed.messageId ?? `<${msgId}@emdash-inbox.local>`;

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

	const msg: MessageDoc = {
		messageId,
		direction: "inbound",
		from: fromAddr,
		to: toAddr,
		subject: parsed.subject ?? "(no subject)",
		bodyText: parsed.text ?? "",
		bodyHtml: parsed.html ?? null,
		bodyRaw: rawMime,
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
	await ctx.storage.messages.put(msgId, msg);

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
 * Errors thrown by `deliverEmail` for known classified failure modes (missing
 * settings, transport rejection, configuration gap). Distinguishable by the
 * route caller from generic JS errors so it can surface the message verbatim
 * via `PluginRouteError.badRequest` — emdash strips messages from
 * `PluginRouteError.internal` on the wire, so unknown errors get a generic
 * code while these get the operator-actionable text.
 */
class DeliverError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeliverError";
	}
}

/**
 * Deliver one outbound email via the Cloudflare Email Service REST API and
 * persist the outbound row inline. Shared between the `email:deliver` plugin
 * hook (called by emdash for any plugin invoking ctx.email.send) and the
 * `messages/reply` route (called from the admin compose form — `ctx.email` is
 * undefined on plugin route contexts in emdash v0.5.0, same gap as ctx.cron).
 *
 * Persistence runs inline (not via `email:afterSend`) — emdash doesn't await
 * afterSend on Workers, so DB writes there hang as the request context tears
 * down. Wrapped so persistence never masks a successful delivery.
 *
 * Note: route callers bypass `email:intercept` hooks entirely (no
 * `beforeSend` / `afterSend` fires for route-initiated sends). Acceptable
 * today because our only intercept is a no-op `afterSend`. If a future
 * intercept hook starts doing real work, route callers must replicate it.
 */
async function deliverEmail(
	ctx: any,
	event: {
		message: { to: string; subject: string; text: string; html?: string; inReplyTo?: string };
		source: string;
	},
): Promise<void> {
	if (!ctx.http) {
		throw new DeliverError(
			"emdash-inbox: ctx.http unavailable — network:fetch capability not granted",
		);
	}

	const kv = ctx.kv as { get<T>(key: string): Promise<T | null> };
	const [accountId, apiToken, senderAddress] = await Promise.all([
		kv.get<string>(SETTINGS.accountId),
		kv.get<string>(SETTINGS.apiToken),
		kv.get<string>(SETTINGS.senderAddress),
	]);

	const missing: string[] = [];
	if (!accountId) missing.push("accountId");
	if (!apiToken) missing.push("apiToken");
	if (!senderAddress) missing.push("senderAddress");
	if (missing.length > 0) {
		throw new DeliverError(
			`emdash-inbox: cannot deliver email — missing settings: ${missing.join(", ")}. Configure in Admin → emdash-inbox → Settings.`,
		);
	}

	const payload: Record<string, unknown> = {
		to: event.message.to,
		from: senderAddress,
		subject: event.message.subject,
		text: event.message.text,
	};
	if (event.message.html) payload.html = event.message.html;
	if (event.message.inReplyTo) {
		payload.headers = {
			"In-Reply-To": event.message.inReplyTo,
		};
	}

	const response = await ctx.http.fetch(CF_SEND_ENDPOINT(accountId!), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const body = await response.text();
		ctx.log.error("emdash-inbox: CF Email Service rejected send", {
			status: response.status,
			body,
			to: event.message.to,
			source: event.source,
		});
		throw new DeliverError(
			`emdash-inbox: CF Email Service returned ${response.status}`,
		);
	}

	ctx.log.info("emdash-inbox: delivered", {
		to: event.message.to,
		subject: event.message.subject,
		source: event.source,
	});

	try {
		await persistOutbound(ctx, event, senderAddress!);
	} catch (err) {
		ctx.log.error("emdash-inbox: failed to persist outbound", {
			to: event.message.to,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Plugin definition — runs on the deployed server at request time.
 *
 * Transport choice: we POST to the Cloudflare Email Service REST API rather
 * than binding `env.SEND_EMAIL`. EmDash v0.5.0's plugin context does not
 * expose host Cloudflare env bindings to hooks, so the REST path (token in
 * `ctx.kv` + `ctx.http.fetch`) is the only way for a plugin to deliver via
 * CF Email Service today. Swapping to the binding later is a single-site
 * change in the `email:deliver` handler.
 */
export function createPlugin() {
	return definePlugin({
		id: "emdash-inbox",
		version: "0.6.1",

		capabilities: [
			"email:provide",
			"email:intercept",
			"network:fetch",
		],

		allowedHosts: ["api.cloudflare.com"],

		storage: {
			messages: {
				indexes: [
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

				const due = await (ctx.storage as any).messages.query({
					where: { status: "snoozed" },
					limit: 500,
				});

				let woken = 0;
				for (const row of due.items as { id: string; data: any }[]) {
					if (!row.data.snoozeUntil) continue;
					if (row.data.snoozeUntil > now) continue;

					await (ctx.storage as any).messages.put(row.id, {
						...row.data,
						status: "inbox",
						sortAt: now,
						snoozeUntil: null,
					});
					woken++;
				}

				if (woken > 0) {
					ctx.log.info("emdash-inbox: woke snoozed messages", { woken });
				}
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					await deliverEmail(ctx, event);
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

		routes: {
			"messages/list": {
				handler: async (routeCtx) => {
					// Lazy setup: same idempotent migration pass as the other admin routes.
					await ensureMigrations(routeCtx);

					const input = routeCtx.input as
						| { status?: unknown; limit?: unknown; cursor?: unknown }
						| null;

					const filter: StatusFilter =
						input?.status === "snoozed" || input?.status === "done" || input?.status === "all"
							? input.status
							: "inbox";

					// limit / cursor accepted for API compatibility; M6 ignores them and
					// returns all threads. Pagination is a documented pre-1.0 limitation.
					void input?.limit;
					void input?.cursor;

					const senderAddress =
						(await routeCtx.kv.get<string>(SETTINGS.senderAddress)) ?? "";

					const all = await (routeCtx.storage as any).messages.query({ limit: 10000 });
					const messages = all.items as Array<{ id: string; data: any }>;

					const items = aggregateThreads(messages, filter, senderAddress);

					return { items, cursor: undefined };
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
					const row = await (routeCtx.storage as any).messages.get(id);
					if (!row) {
						throw PluginRouteError.notFound(`message ${id} not found`);
					}
					await (routeCtx.storage as any).messages.put(id, {
						...row,
						pinned,
					});
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

					const row = await (routeCtx.storage as any).messages.get(id);
					if (!row) {
						throw PluginRouteError.notFound(`message ${id} not found`);
					}

					const check = validateTransition(row.status, status, snoozeUntil);
					if (!check.ok) {
						throw PluginRouteError.badRequest(check.error);
					}

					const now = new Date().toISOString();
					const next = { ...row };

					if (status === "inbox") {
						next.status = "inbox";
						next.sortAt = now;
						next.snoozeUntil = null;
					} else if (status === "snoozed") {
						next.status = "snoozed";
						next.snoozeUntil = snoozeUntil!;
					} else if (status === "done") {
						next.status = "done";
						next.snoozeUntil = null;
					}

					await (routeCtx.storage as any).messages.put(id, next);
					return { ok: true, status: next.status };
				},
			},

			"messages/thread": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);

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
					const result = await (routeCtx.storage as any).messages.query({
						where: { threadId },
						orderBy: { receivedAt: "asc" },
						limit: 500,
					});

					// Side-effect: mark every unread message in this thread read. Wrapped so a
					// write failure doesn't fail the fetch — same defensive pattern as
					// persistOutbound inside deliverEmail. Returned items are the pre-write
					// snapshot; the inbox list re-fetches on back-navigation and sees the
					// updated state.
					try {
						for (const r of result.items as { id: string; data: any }[]) {
							if (r.data.read === false) {
								await (routeCtx.storage as any).messages.put(r.id, {
									...r.data,
									read: true,
								});
							}
						}
					} catch (err) {
						routeCtx.log.error("emdash-inbox: failed to mark thread read", {
							threadId,
							error: err instanceof Error ? err.message : String(err),
						});
					}

					return { items: result.items };
				},
			},

			"messages/reply": {
				handler: async (routeCtx) => {
					await ensureMigrations(routeCtx);

					const input = routeCtx.input as
						| { inReplyTo?: unknown; to?: unknown; subject?: unknown; text?: unknown; html?: unknown }
						| null;

					const inReplyTo = typeof input?.inReplyTo === "string" ? input.inReplyTo.trim() : "";
					const to = typeof input?.to === "string" ? input.to.trim() : "";
					const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
					const text = typeof input?.text === "string" ? input.text : "";
					const html = typeof input?.html === "string" ? input.html : "";

					if (!inReplyTo) {
						throw PluginRouteError.badRequest("inReplyTo: required non-empty string");
					}
					if (!to || !/^\S+@\S+\.\S+$/.test(to)) {
						throw PluginRouteError.badRequest("to: required, must look like an email address");
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

					// Server-side re-sanitization is deferred to a DOM-free sanitizer
					// (linkedom-backed DOMPurify or sanitize-html via parse5) — the
					// browser-only DOMPurify we use client-side throws server-side because
					// Cloudflare Workers has no window. Trust constraint for M5: the route
					// is admin-authenticated, and TipTap StarterKit constrains the wire
					// HTML to a known element set. Tracked in deferred list.

					try {
						await deliverEmail(routeCtx, {
							message: { to, subject, text, html, inReplyTo },
							source: "emdash-inbox:reply",
						});
					} catch (err) {
						if (err instanceof DeliverError) {
							// Surface operator-actionable failure text (missing settings, CF
							// rejection) through badRequest — emdash masks internal-error
							// messages on the wire.
							throw PluginRouteError.badRequest(err.message);
						}
						const msg = err instanceof Error ? err.message : String(err);
						throw PluginRouteError.internal(`send failed: ${msg}`);
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
						throw PluginRouteError.internal(
							"inbound endpoint not configured — set settings:inboundSecret",
						);
					}
					// X-Inbound-Secret header (not Authorization/Bearer — emdash's auth
					// middleware claims Bearer globally, even for public plugin routes).
					const provided = routeCtx.request.headers.get("x-inbound-secret") ?? "";
					if (provided !== expected) {
						throw PluginRouteError.unauthorized();
					}

					// emdash's dispatcher pre-parses the body as JSON (even for empty/
					// non-JSON content). We can't re-read request.text() because the
					// body stream is already consumed. So the protocol is: POST JSON
					// `{ "rawMime": "<RFC822>" }`. The email Worker that forwards
					// inbound mail is responsible for wrapping the raw MIME in that
					// envelope.
					const input = routeCtx.input as { rawMime?: unknown } | null;
					const rawMime = input?.rawMime;
					if (typeof rawMime !== "string" || rawMime.length === 0) {
						throw PluginRouteError.badRequest(
							"body must be JSON with a non-empty `rawMime` string field",
						);
					}

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
				accountId: {
					type: "string",
					label: "Cloudflare account ID",
					description:
						"Find this in your Cloudflare dashboard URL or on the account home page.",
				},
				apiToken: {
					type: "secret",
					label: "Cloudflare API token (Email Sending scope)",
					description:
						"Create at dash.cloudflare.com → My Profile → API Tokens → Create Token, with permission: Account → Email Sending → Send.",
				},
				senderAddress: {
					type: "string",
					label: "Verified sender address",
					description:
						"Must be a sender you have verified in Cloudflare Email Service (e.g. hello@yourdomain.com).",
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
