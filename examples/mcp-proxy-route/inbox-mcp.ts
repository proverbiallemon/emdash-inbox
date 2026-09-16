// Optional legacy MCP proxy. Prefer EmDash's native /_emdash/api/mcp
// endpoint with the plugin's MCP tools enabled in Admin → Extensions.
// To retain this proxy, copy it to src/pages/api/inbox-mcp.ts in your site.
//
// Plugin routes wrap responses in {"data": ...}. This route unwraps the
// plugin's legacy messages/mcp responses for existing MCP clients.
//
// Every caller must send its own EmDash Bearer token. EmDash validates
// that token's scope and permissions at the private plugin endpoint.
// Remove the obsolete EMDASH_INBOX_MCP_TOKEN host secret.

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
	const bearer = /^Bearer +([A-Za-z0-9._~+\/-]+=*)$/i.exec(request.headers.get("Authorization") ?? "");
	if (!bearer) {
		return proxyError(401, "A Bearer token is required");
	}

	const upstream = new URL("/_emdash/api/plugins/emdash-inbox/messages/mcp", url.origin);
	try {
		const res = await fetch(upstream, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${bearer[1]}`,
			},
			body: await request.text(),
			credentials: "omit",
			cache: "no-store",
			// Keep credentials on this endpoint; redirects must not select a different route.
			redirect: "error",
		});

		if (res.status === 401 || res.status === 403) {
			return proxyError(res.status, res.status === 401 ? "Authentication required" : "Access denied");
		}
		if (!res.ok) {
			return proxyError(502, "EmDash MCP request failed");
		}

		const body = (await res.json()) as { data?: unknown } | null;
		if (!body || body.data === undefined) {
			return proxyError(502, "Invalid EmDash MCP response");
		}

		return Response.json(body.data, { headers: { "Cache-Control": "private, no-store" } });
	} catch {
		// Upstream messages and fetch exceptions can contain sensitive details.
		return proxyError(502, "EmDash MCP request failed");
	}
};

function proxyError(status: number, message: string): Response {
	const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
	if (status === 401) headers["WWW-Authenticate"] = 'Bearer realm="emdash-inbox"';
	return Response.json(
		{ jsonrpc: "2.0", id: null, error: { code: -32000, message } },
		{ status, headers },
	);
}
