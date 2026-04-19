/**
 * Minimal Cloudflare Email Worker that forwards inbound mail to an emdash-inbox
 * plugin route.
 *
 * Cloudflare Email Routing calls `email(message, env, ctx)` when mail arrives
 * for a configured address. We stream the raw RFC822 MIME to the host's
 * plugin endpoint, which parses and persists it.
 *
 * Deploy this as a separate Worker (see wrangler.jsonc.example alongside).
 * No MIME parsing here — we keep the Worker dumb on purpose so parsing can
 * evolve in one place (the plugin).
 *
 * Required env bindings:
 *   INBOUND_URL    — e.g. https://yoursite.example.com/_emdash/api/plugins/emdash-inbox/inbound
 *   INBOUND_SECRET — same value configured in the plugin's admin settings
 *
 * Configure in Cloudflare Dashboard → Email → Email Routing → Routes, and
 * point your domain's MX to Cloudflare Email.
 */

export interface Env {
	INBOUND_URL: string;
	INBOUND_SECRET: string;
}

interface ForwardableEmailMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	setReject(reason: string): void;
	forward(rcptTo: string, headers?: Headers): Promise<void>;
	reply(message: unknown): Promise<void>;
}

export default {
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: { waitUntil(p: Promise<unknown>): void },
	): Promise<void> {
		if (!env.INBOUND_URL || !env.INBOUND_SECRET) {
			console.error("[emdash-inbox-worker] INBOUND_URL/INBOUND_SECRET not set");
			message.setReject("Receiver not configured");
			return;
		}

		const rawMime = await new Response(message.raw).text();

		const response = await fetch(env.INBOUND_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Inbound-Secret": env.INBOUND_SECRET,
			},
			body: JSON.stringify({ rawMime }),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "<no body>");
			console.error(
				`[emdash-inbox-worker] forward failed: ${response.status} ${body}`,
			);
			// Tell Cloudflare to surface a bounce so senders know delivery didn't
			// land, rather than silently dropping.
			message.setReject(`Downstream ingest failed: ${response.status}`);
		}
	},
};
