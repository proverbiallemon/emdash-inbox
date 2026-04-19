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

/**
 * Plugin definition — runs on the deployed server at request time.
 *
 * Roadmap:
 *   M1 — claim `email:provide`; register `email:deliver` hook that ships via
 *        the Cloudflare Email Service binding. Prove outbound works end-to-end.
 *   M2 — inbound handler (Cloudflare Email Worker → ctx.storage.messages);
 *        basic list-view admin page.
 *   M3 — Inbox-by-Google UX (pin / snooze / done, card-based list).
 *   M4 — bundle classification (Orders, Shipping, Commissions, Fans, Promos).
 *   M5 — highlights (structured fields surfaced as inline cards).
 *   M6 — reminders + content linking + MCP extension.
 */
export function createPlugin() {
	return definePlugin({
		id: "emdash-inbox",
		version: "0.1.0",

		capabilities: [
			// We deliver email for the whole EmDash instance — anything that calls
			// ctx.email.send() routes through our email:deliver hook below.
			"email:provide",
			// We also log every outbound message so it shows up in the inbox UI.
			"email:intercept",
		],

		hooks: {
			"plugin:install": async (_event, ctx) => {
				ctx.log.info("emdash-inbox installed");
				// TODO M2: seed default bundles (Orders, Shipping, Promos, Fans, Shows)
			},

			/**
			 * Exclusive provider hook — runs exactly once per outbound email,
			 * regardless of which plugin called ctx.email.send().
			 *
			 * TODO M1: actually deliver via the Cloudflare Email Service binding.
			 *   Pseudocode:
			 *     const sendEmail = (ctx as any).env?.SEND_EMAIL;  // resolve binding
			 *     await sendEmail.send(new EmailMessage(from, event.message.to, raw));
			 *
			 *   Blockers to resolve:
			 *     1. How a plugin accesses the host's Cloudflare env bindings —
			 *        not yet exposed on ctx in EmDash v0.5.0.
			 *     2. The raw MIME-formatted RFC822 body that Cloudflare's
			 *        SendEmail expects (need to build from event.message).
			 *     3. The verified sender address — comes from plugin settings,
			 *        configured via admin.settingsSchema.
			 */
			"email:deliver": async (event, ctx) => {
				ctx.log.info("email:deliver (stub)", {
					to: event.message.to,
					subject: event.message.subject,
					source: event.source,
				});
				// Until the binding is wired, this is a no-op.
				// Host-side unit tests will skip send assertions until M1 lands fully.
			},

			/**
			 * Observer hook — runs after every outbound send succeeds.
			 * TODO M2: persist to ctx.storage.messages as outbound record.
			 */
			"email:afterSend": async (event, ctx) => {
				ctx.log.debug("email:afterSend", {
					to: event.message.to,
					subject: event.message.subject,
					source: event.source,
				});
			},
		},

		// TODO M2: declare storage collections
		//   messages, contacts, bundles, reminders, links

		// TODO M1–M2:
		// admin: {
		//   entry: "emdash-inbox/admin",
		//   pages: [
		//     { path: "/", label: "Inbox", icon: "inbox" },
		//     { path: "/reminders", label: "Reminders", icon: "bell" },
		//     { path: "/settings", label: "Settings", icon: "settings" },
		//   ],
		//   widgets: [
		//     { id: "inbox-unread", title: "Inbox", size: "half" },
		//   ],
		//   settingsSchema: {
		//     senderAddress: { type: "string", label: "Sender address (verified in CF Email)" },
		//   },
		// },
	});
}

export default createPlugin;
