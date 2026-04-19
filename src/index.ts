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
				},
			},

			"email:afterSend": async (event, ctx) => {
				// M2: persist to ctx.storage.messages as outbound record for inbox UI.
				ctx.log.debug("email:afterSend", {
					to: event.message.to,
					subject: event.message.subject,
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
