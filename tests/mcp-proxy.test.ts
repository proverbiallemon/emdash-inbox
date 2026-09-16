// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../examples/mcp-proxy-route/inbox-mcp";

const rpcRequest = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
const rpcResult = { jsonrpc: "2.0", id: 7, result: { tools: [] } };
const legacyHostToken = "legacy-host-admin-secret";

function post(headers: HeadersInit = {}) {
	const url = new URL("https://inbox.example/api/inbox-mcp");
	return POST({
		url,
		request: new Request(url, { method: "POST", headers, body: rpcRequest }),
	} as Parameters<typeof POST>[0]);
}

describe("legacy MCP proxy authentication", () => {
	const fetchUpstream = vi.fn<typeof fetch>();

	beforeEach(() => {
		// An old deployment secret must never authorize a request or be forwarded.
		vi.stubEnv("EMDASH_INBOX_MCP_TOKEN", legacyHostToken);
		fetchUpstream.mockResolvedValue(Response.json({ data: rpcResult }));
		vi.stubGlobal("fetch", fetchUpstream);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.resetAllMocks();
	});

	it("rejects anonymous requests without contacting EmDash even when a host secret exists", async () => {
		const response = await post({ Cookie: "emdash_session=admin-session" });

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer\b/);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toEqual({
			jsonrpc: "2.0", id: null,
			error: { code: expect.any(Number), message: expect.any(String) },
		});
		expect(fetchUpstream).not.toHaveBeenCalled();
	});

	it.each([
		"Basic dXNlcjpwYXNz",
		"Bearer",
		"Bearer caller token",
		"Bearer caller-token, Bearer second-token",
		"Bearer token:invalid",
	])("rejects malformed authorization %s without an upstream call", async (authorization) => {
		const response = await post({ Authorization: authorization });

		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain(legacyHostToken);
		expect(fetchUpstream).not.toHaveBeenCalled();
	});

	it("forwards only the caller's Bearer credential to the same-origin private route", async () => {
		const response = await post({
			Authorization: "bEaReR caller-token_123",
			Cookie: "emdash_session=admin-session",
			"X-Forwarded-Authorization": "Bearer alternate-secret",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(rpcResult);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(fetchUpstream).toHaveBeenCalledOnce();
		const [url, options] = fetchUpstream.mock.calls[0];
		expect(String(url)).toBe("https://inbox.example/_emdash/api/plugins/emdash-inbox/messages/mcp");
		const headers = new Headers(options?.headers);
		expect(headers.get("Authorization")).toBe("Bearer caller-token_123");
		expect(headers.get("Cookie")).toBeNull();
		expect(headers.get("X-Forwarded-Authorization")).toBeNull();
		expect(options).toMatchObject({
			method: "POST", body: rpcRequest, credentials: "omit", cache: "no-store", redirect: "error",
		});
	});

	it.each([401, 403])("preserves upstream %i instead of unwrapping a successful-looking payload", async (status) => {
		fetchUpstream.mockResolvedValue(Response.json({
			data: rpcResult,
			error: { message: `Rejected credential ${legacyHostToken}` },
		}, { status }));

		const response = await post({ Authorization: "Bearer denied-caller" });

		expect(response.status).toBe(status);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		const body = await response.json();
		expect(body).toEqual({
			jsonrpc: "2.0", id: null,
			error: { code: expect.any(Number), message: expect.any(String) },
		});
		expect(JSON.stringify(body)).not.toContain(legacyHostToken);
	});

	it("returns a sanitized gateway error when the upstream fetch fails", async () => {
		fetchUpstream.mockRejectedValue(new Error(`Request with ${legacyHostToken} failed`));

		const response = await post({ Authorization: "Bearer caller-token" });

		expect(response.status).toBe(502);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toEqual({
			jsonrpc: "2.0", id: null,
			error: { code: expect.any(Number), message: expect.not.stringContaining(legacyHostToken) },
		});
	});

	it("does not expose upstream failure messages", async () => {
		fetchUpstream.mockResolvedValue(Response.json({
			error: { message: `Database error with ${legacyHostToken}` },
		}, { status: 500 }));

		const response = await post({ Authorization: "Bearer caller-token" });

		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain(legacyHostToken);
	});

	it.each(["not json", "null", "{}"])("rejects invalid upstream envelopes (%s)", async (body) => {
		fetchUpstream.mockResolvedValue(new Response(body, { status: 200 }));

		const response = await post({ Authorization: "Bearer caller-token" });

		expect(response.status).toBe(502);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toEqual({
			jsonrpc: "2.0", id: null,
			error: { code: expect.any(Number), message: expect.any(String) },
		});
	});

	it("preserves a JSON-RPC error returned by an authenticated plugin call", async () => {
		const error = { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } };
		fetchUpstream.mockResolvedValue(Response.json({ data: error }));

		const response = await post({ Authorization: "Bearer caller-token" });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(error);
	});
});
