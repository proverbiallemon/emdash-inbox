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
 * Receives full `ctx` access based on declared capabilities.
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

		// TODO M1: claim capabilities
		//   "email:provide"     — become the transport (registers email:deliver)
		//   "email:intercept"   — log outbound sent by any plugin
		//   "read:content"      — link messages to content records
		//   "read:users"        — user lookups
		//   "network:fetch"     — carrier tracking APIs, etc.
		capabilities: [],

		// TODO M1: allowedHosts for tracking-lookup APIs
		allowedHosts: [],

		// TODO M2: declare storage collections
		//   messages, contacts, bundles, reminders, links
		storage: {},

		hooks: {
			"plugin:install": async (_event, ctx) => {
				ctx.log.info("emdash-inbox installed");
				// TODO M2: seed default bundles (Orders, Shipping, Promos, Fans, Shows)
			},
			// TODO M1: "email:deliver" — ship outbound via Cloudflare Email Service
			// TODO M1: "email:afterSend" — record every sent message in inbox storage
		},

		routes: {
			// TODO M2: messages list / send / pin / snooze / done / attachments
		},

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
		// },
	});
}

export default createPlugin;
