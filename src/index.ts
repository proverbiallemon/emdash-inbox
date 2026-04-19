import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

/**
 * Plugin descriptor — imported in the host site's `astro.config.mjs`.
 * Runs at build time in Vite; must be side-effect-free (no runtime APIs).
 */
export function emdashInboxPlugin(): PluginDescriptor {
	return {
		id: "emdash-inbox",
		version: "0.1.0",
		format: "native",
		entrypoint: "emdash-inbox",
		options: {},
	};
}

const SETTINGS = {
	accountId: "settings:accountId",
	apiToken: "settings:apiToken",
	senderAddress: "settings:senderAddress",
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
		version: "0.1.0",

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

		admin: {
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
			},
		},
	});
}

export default createPlugin;
