// Host-side MCP proxy for emdash-inbox. Copy to src/pages/api/inbox-mcp.ts
// in your EmDash site.
//
// Why this exists: EmDash wraps every plugin-route response in a
// {"data": ...} envelope, which MCP clients can't parse. This route
// forwards JSON-RPC requests to the plugin's messages/mcp route and
// returns the unwrapped body. Remove it once EmDash supports raw
// responses on plugin routes.
//
// Auth: set EMDASH_INBOX_MCP_TOKEN to an EmDash API token with admin
// scope (Admin → Settings → API Tokens). Anyone who can reach this
// route with the token has full inbox access.

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
	const token = import.meta.env.EMDASH_INBOX_MCP_TOKEN;
	if (!token) {
		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32000, message: "EMDASH_INBOX_MCP_TOKEN not configured on the host" } },
			{ status: 500 },
		);
	}

	const upstream = new URL("/_emdash/api/plugins/emdash-inbox/messages/mcp", url.origin);
	const res = await fetch(upstream, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${token}`,
			"X-EmDash-Request": "1",
		},
		body: await request.text(),
	});

	const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
	if (!res.ok || !body || body.data === undefined) {
		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32000, message: body?.error?.message ?? `upstream error (${res.status})` } },
			{ status: 502 },
		);
	}

	return Response.json(body.data);
};
