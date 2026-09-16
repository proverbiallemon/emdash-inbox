// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "emdash/routes/api/mcp";
import { createNativeHost } from "./helpers/nativeHost";

/**
 * Published EmDash HTTP adapter + MCP SDK + real PluginManager/SQLite.
 * The fixture supplies Astro's resolved auth locals and enabled-tool catalog;
 * token verification and persisted admin consent belong to the host middleware
 * and are deliberately not simulated by these adapter integration tests.
 */
describe("published EmDash MCP HTTP adapter", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	let denied: string[];
	let routed: string[];
	beforeEach(async () => { host = await createNativeHost(); denied = []; routed = []; });
	afterEach(async () => { await host?.close(); });

	async function post(
		method: string,
		params: unknown = {},
		auth: { role?: 40 | 50; scopes?: string[]; anonymous?: boolean } = {},
	) {
		const request = new Request("https://site.example/_emdash/api/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		const user = auth.anonymous ? null : { id: "test-admin", email: "owner@example.com", role: auth.role ?? 50 };
		return POST({ request, locals: {
			user,
			tokenScopes: auth.scopes ?? ["mcp:tools:emdash-inbox"],
			emdash: {
				async getEnabledPluginMcpTools() {
					return Object.entries(host.plugin.mcp!.tools).map(([name, tool]) => ({
						pluginId: host.plugin.id, name, description: tool.description, route: tool.route,
						permission: host.plugin.routes[tool.route].permission,
						destructive: tool.destructive ?? false, inputSchema: tool.input, outputSchema: tool.output,
					}));
				},
				async handlePluginMcpTool(pluginId: string, _name: string, route: string, input: unknown) {
					routed.push(route);
					return host.manager.invokeRoute(pluginId, route, {
						body: input,
						request: new Request(request.url, { method: "POST", body: JSON.stringify(input) }),
						user: user ?? undefined,
					});
				},
				async handlePluginMcpDenied(_pluginId: string, _name: string, _route: string, _actorId: string, _request: Request, reason: string) {
					denied.push(reason);
				},
			},
		} } as Parameters<typeof POST>[0]);
	}

	async function rpc(response: Response) {
		expect(response.status).toBe(200);
		const body = await response.text();
		if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
			const data = body.split("\n").find((line) => line.startsWith("data: "));
			expect(data, body).toBeDefined();
			return JSON.parse(data!.slice(6));
		}
		return JSON.parse(body);
	}

	it("initializes and advertises every namespaced inbox tool with its input schema", async () => {
		const initialized = await rpc(await post("initialize", {
			protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "inbox-integration-test", version: "1.0.0" },
		}));
		expect(initialized.result.serverInfo.name).toBe("emdash");
		expect(initialized.result.capabilities.tools).toBeDefined();
		const listed = await rpc(await post("tools/list"));
		const inboxTools = listed.result.tools.filter((tool: { name: string }) => tool.name.startsWith("emdash-inbox__"));
		expect(inboxTools).toHaveLength(20);
		expect(inboxTools).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "emdash-inbox__save_draft", inputSchema: expect.objectContaining({ type: "object" }), annotations: { destructiveHint: true } }),
			expect.objectContaining({ name: "emdash-inbox__list_threads", annotations: { destructiveHint: false } }),
			expect.objectContaining({ name: "emdash-inbox__read_attachment", annotations: { destructiveHint: false } }),
			expect.objectContaining({ name: "emdash-inbox__list_deliveries", inputSchema: expect.objectContaining({ type: "object" }) }),
			expect.objectContaining({ name: "emdash-inbox__reconcile_deliveries", inputSchema: expect.objectContaining({ type: "object" }) }),
			expect.objectContaining({ name: "emdash-inbox__resolve_delivery", annotations: { destructiveHint: true } }),
		]));
	});

	it("persists a draft and reads it back through namespaced HTTP tool calls", async () => {
		const saved = await rpc(await post("tools/call", {
			name: "emdash-inbox__save_draft", arguments: { to: "recipient@example.com", subject: "MCP HTTP draft", text: "Stored through the real host manager" },
		}));
		expect(saved.result.isError).not.toBe(true);
		const created = JSON.parse(saved.result.content[0].text);
		const row = await host.messages.get(created.draftId);
		expect(row).toMatchObject({ status: "draft", subject: "MCP HTTP draft" });
		const listed = await rpc(await post("tools/call", { name: "emdash-inbox__list_drafts", arguments: {} }));
		expect(listed.result.isError).not.toBe(true);
		expect(listed.result.content[0].text).toContain(created.draftId);
	});

	it.each([["admin"], ["content:read"], ["mcp:tools:another-plugin"]])("rejects scopes %j before writing data", async (...scopes) => {
		const result = await rpc(await post("tools/call", {
			name: "emdash-inbox__save_draft", arguments: { subject: "Must not be stored" },
		}, { scopes }));
		expect(result.result.isError).toBe(true);
		expect(result.result._meta.code).toBe("INSUFFICIENT_SCOPE");
		expect(denied).toEqual(["Missing scope: mcp:tools:emdash-inbox"]);
		expect((await host.messages.query({ where: { status: "draft" } })).items).toHaveLength(0);
	});

	it("requires the plugin permission even when the scope is correct", async () => {
		const result = await rpc(await post("tools/call", {
			name: "emdash-inbox__save_draft", arguments: { subject: "Must not be stored" },
		}, { role: 40 }));
		expect(result.result.isError).toBe(true);
		expect(result.result._meta.code).toBe("INSUFFICIENT_PERMISSIONS");
		expect(denied).toEqual(["Missing permission: plugins:manage"]);
		expect((await host.messages.query({ where: { status: "draft" } })).items).toHaveLength(0);
	});

	it("rejects malformed tool arguments before touching SQLite", async () => {
		const result = await rpc(await post("tools/call", { name: "emdash-inbox__save_draft", arguments: { to: 42 } }));
		expect(result.result.isError).toBe(true);
		expect((await host.messages.query({ where: { status: "draft" } })).items).toHaveLength(0);
	});

	it("returns HTTP 401 when authentication middleware has resolved no user", async () => {
		const response = await post("tools/list", {}, { anonymous: true });
		expect(response.status).toBe(401);
	});

	it("accepts MCP initialization notifications without a response body", async () => {
		// Omit the id entirely, as real Streamable HTTP clients do.
		const request = new Request("https://site.example/_emdash/api/mcp", {
			method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		const response = await POST({ request, locals: {
			user: { id: "test-admin", role: 50 }, tokenScopes: ["mcp:tools:emdash-inbox"],
			emdash: { getEnabledPluginMcpTools: async () => [] },
		} } as Parameters<typeof POST>[0]);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("");
	});

	it.each([
		{ role: 40 as const, scopes: ["mcp:tools:emdash-inbox"], code: "INSUFFICIENT_PERMISSIONS" },
		{ role: 50 as const, scopes: ["content:read"], code: "INSUFFICIENT_SCOPE" },
	])("denies attachment reads before accessing storage ($code)", async ({role,scopes,code}) => {
		const result = await rpc(await post("tools/call", {name: "emdash-inbox__read_attachment", arguments: {messageId:"private-message",attachmentId:"private-file"}}, {role,scopes}));
		expect(result.result.isError).toBe(true);
		expect(result.result._meta.code).toBe(code);
	});

	it("returns 405 for unsupported event-stream GET connections", async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(405);
	});

	it.each(["list_deliveries", "reconcile_deliveries", "resolve_delivery"])("gates %s before route/storage access", async (name) => {
		const args = name === "resolve_delivery" ? { attemptId: "private-attempt", resolution: "restore", confirmDuplicateRisk: true } : {};
		for (const auth of [
			{ role: 40 as const, scopes: ["mcp:tools:emdash-inbox"], code: "INSUFFICIENT_PERMISSIONS" },
			{ role: 50 as const, scopes: ["content:read"], code: "INSUFFICIENT_SCOPE" },
		]) {
			const result = await rpc(await post("tools/call", { name: `emdash-inbox__${name}`, arguments: args }, auth));
			expect(result.result.isError).toBe(true);
			expect(result.result._meta.code).toBe(auth.code);
		}
		expect(routed).toEqual([]);
	});

	it.each(["list_deliveries", "reconcile_deliveries"])("dispatches authorized %s through the native host", async (name) => {
		const result = await rpc(await post("tools/call", { name: `emdash-inbox__${name}`, arguments: {} }));
		expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
		const data = JSON.parse(result.result.content[0].text);
		if (name === "list_deliveries") expect(data).toMatchObject({ items: [], hasMore: false });
		else expect(data).toMatchObject({ recovered: 0, restored: 0, uncertain: 0 });
		expect(routed).toEqual([`mcp/${name}`]);
	});
});
