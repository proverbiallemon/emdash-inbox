import { definePlugin, PluginRouteError } from "emdash";
import type { PluginDescriptor } from "emdash";
import PostalMime from "postal-mime";
import { validateTransition } from "./lib/statusTransitions";

/**
 * Plugin descriptor — imported in the host site's `astro.config.mjs`.
 * Runs at build time in Vite; must be side-effect-free (no runtime APIs).
 */
export function emdashInboxPlugin(): PluginDescriptor {
	return {
		id: "emdash-inbox",
		version: "0.2.0",
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
	/** M4. Null until the bundle classifier runs. */
	bundleId: string | null;
	/** ISO8601. Drives inbox sort order. Equals receivedAt on create;
	 *  updated to wake-time when a snoozed message resurfaces. */
	sortAt: string;
	/** ISO8601. Only meaningful when status === "snoozed". Null otherwise. */
	snoozeUntil: string | null;
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
	event: { message: { to: string; subject: string; text: string; html?: string }; source: string },
	senderAddress: string,
): Promise<void> {
	const now = new Date().toISOString();
	const msgId = crypto.randomUUID();
	const senderDomain = senderAddress.split("@")[1] ?? "emdash-inbox.local";

	const msg: MessageDoc = {
		messageId: `<${msgId}@${senderDomain}>`,
		direction: "outbound",
		from: senderAddress,
		to: event.message.to,
		subject: event.message.subject,
		bodyText: event.message.text,
		bodyHtml: event.message.html ?? null,
		bodyRaw: null,
		threadId: null,
		receivedAt: now,
		source: event.source,
		status: "done",
		pinned: false,
		bundleId: null,
		sortAt: now,
		snoozeUntil: null,
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

	const msg: MessageDoc = {
		messageId: parsed.messageId ?? `<${msgId}@emdash-inbox.local>`,
		direction: "inbound",
		from: fromAddr,
		to: toAddr,
		subject: parsed.subject ?? "(no subject)",
		bodyText: parsed.text ?? "",
		bodyHtml: parsed.html ?? null,
		bodyRaw: rawMime,
		threadId: null,
		receivedAt: now,
		source: "inbound",
		status: "inbox",
		pinned: false,
		bundleId: null,
		sortAt: now,
		snoozeUntil: null,
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
		version: "0.2.0",

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
			},

			"plugin:activate": async (_event, ctx) => {
				// Backfill sortAt/snoozeUntil on any M2 rows. Pre-alpha data volumes are
				// tiny; a full scan is fine here. Idempotent — skips rows already migrated.
				// Lives in plugin:activate (not plugin:install) because install only fires
				// on first-ever install; activate re-fires on upgrade, which is what we need
				// for M2→M3 sites.
				const all = await (ctx.storage as any).messages.query({ limit: 10000 });
				let migrated = 0;
				for (const row of all.items as { id: string; data: any }[]) {
					if (row.data.sortAt && row.data.snoozeUntil !== undefined) continue;
					await (ctx.storage as any).messages.put(row.id, {
						...row.data,
						sortAt: row.data.sortAt ?? row.data.receivedAt,
						snoozeUntil: row.data.snoozeUntil ?? null,
					});
					migrated++;
				}
				if (migrated > 0) {
					ctx.log.info("emdash-inbox: backfilled sortAt/snoozeUntil", { migrated });
				}
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					if (!ctx.http) {
						throw new Error(
							"emdash-inbox: ctx.http unavailable — network:fetch capability not granted",
						);
					}

					const [accountId, apiToken, senderAddress] = await Promise.all([
						ctx.kv.get<string>(SETTINGS.accountId),
						ctx.kv.get<string>(SETTINGS.apiToken),
						ctx.kv.get<string>(SETTINGS.senderAddress),
					]);

					const missing: string[] = [];
					if (!accountId) missing.push("accountId");
					if (!apiToken) missing.push("apiToken");
					if (!senderAddress) missing.push("senderAddress");
					if (missing.length > 0) {
						throw new Error(
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
						throw new Error(
							`emdash-inbox: CF Email Service returned ${response.status}`,
						);
					}

					ctx.log.info("emdash-inbox: delivered", {
						to: event.message.to,
						subject: event.message.subject,
						source: event.source,
					});

					// Persist inline (not in email:afterSend) — emdash calls afterSend
					// fire-and-forget, so in the Cloudflare Workers runtime the request
					// context tears down before our DB writes land. Done here while the
					// request scope is still live. Wrapped so persistence never masks a
					// successful delivery.
					try {
						await persistOutbound(ctx, event, senderAddress!);
					} catch (err) {
						ctx.log.error("emdash-inbox: failed to persist outbound", {
							to: event.message.to,
							error: err instanceof Error ? err.message : String(err),
						});
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

		routes: {
			"messages/list": {
				handler: async (routeCtx) => {
					const input = routeCtx.input as
						| { status?: unknown; limit?: unknown; cursor?: unknown }
						| null;

					const filter =
						input?.status === "snoozed" || input?.status === "done" || input?.status === "all"
							? input.status
							: "inbox";
					const limit = typeof input?.limit === "number" ? input.limit : 100;
					const cursor = typeof input?.cursor === "string" ? input.cursor : undefined;

					const sortField = filter === "snoozed" ? "snoozeUntil" : "sortAt";
					const sortDir: "asc" | "desc" = filter === "snoozed" ? "asc" : "desc";

					const query: any = {
						orderBy: { [sortField]: sortDir },
						limit,
						cursor,
					};
					if (filter !== "all") {
						query.where = { status: filter };
					}

					const result = await (routeCtx.storage as any).messages.query(query);

					// Post-sort: pinned rows first within the already-sorted list. EmDash
					// storage doesn't currently support composite orderBy, so we do this
					// client-side against the limit-sized window — fine for pre-alpha
					// volumes; revisit if inbox grows beyond a few thousand rows.
					const items = [...result.items].sort((a: any, b: any) => {
						if (a.data.pinned && !b.data.pinned) return -1;
						if (!a.data.pinned && b.data.pinned) return 1;
						return 0;
					});

					return { items, cursor: result.cursor };
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
