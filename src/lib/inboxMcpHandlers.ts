import { z } from "zod";
import { listInboxTools, type InboxToolName } from "./inboxMcpTools";
import { aggregateThreads, type StatusFilter } from "./threadSummary";

/**
 * MCP wire layer for the inbox plugin.
 *
 * Design choice: manual JSON-RPC dispatch (no `@modelcontextprotocol/sdk`
 * runtime). The SDK's `McpServer` only exposes `connect(transport)` —
 * there's no public method to feed it a raw JSON-RPC request and get a
 * response object back. Its `StreamableHTTPServerTransport` owns a
 * fetch-handler, which doesn't fit EmDash's plugin-route interface (we
 * receive a parsed JSON body in `routeCtx.input` and return a JSON-
 * serializable value — emdash owns the HTTP layer). The previous plan
 * sketch reached into `_server.handleMessage`, but that's a private
 * method that can move between SDK versions.
 *
 * Trade-off: ~70 LOC of dispatcher we own, vs no risk of SDK-internal
 * drift. The SDK is still useful as the zod-schema source-of-truth in
 * `inboxMcpTools.ts` (and for `zod-to-json-schema` via zod v4's built-in
 * `z.toJSONSchema()`), but we don't drive its server runtime here.
 *
 * Handles three methods:
 *   - initialize  — handshake; advertise tools capability
 *   - tools/list  — enumerate tools (with JSON Schema input shapes)
 *   - tools/call  — invoke a named tool with arguments
 *
 * Errors follow the JSON-RPC 2.0 shape: `{ jsonrpc, id, error: { code,
 * message } }`. Tool-level errors (invalid args, handler throw) ride
 * inside the `result.content` envelope with `isError: true` per MCP spec.
 */

/**
 * Execute one MCP tool against the plugin context. Each handler is a
 * thin wrapper around `ctx.storage.messages` queries we already use for
 * the admin UI — no business logic should live here that doesn't also
 * live in the corresponding admin path. If the admin handler changes,
 * mirror the change here.
 *
 * No new vitest coverage: each branch is structurally equivalent to an
 * existing admin route handler, exercised indirectly by the admin tests.
 */
export async function runInboxToolHandler(
	ctx: any,
	name: InboxToolName,
	args: unknown,
): Promise<unknown> {
	const messages = ctx.storage.messages;

	switch (name) {
		case "list_threads": {
			const { status = "inbox", limit = 25 } =
				(args as { status?: "inbox" | "snoozed" | "done"; limit?: number }) ?? {};
			// status is pre-validated by zod in dispatchMcpRequest's safeParse,
			// so it's already a subset of StatusFilter — no cast needed.
			const filter: StatusFilter = status;
			const senderAddress =
				((await ctx.kv.get("settings:senderAddress")) as string | null) ?? "";
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const summaries = aggregateThreads(rows, filter, senderAddress);
			return summaries.slice(0, limit);
		}

		case "get_thread": {
			const { threadId } = args as { threadId: string };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			return rows
				.map((r) => r.data)
				.filter((m: any) => (m.threadId ?? m.messageId) === threadId)
				.sort((a: any, b: any) =>
					a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
				);
		}

		case "search_messages": {
			const { query, limit = 20 } = args as { query: string; limit?: number };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const q = query.toLowerCase();
			return rows
				.map((r) => r.data)
				.filter(
					(m: any) =>
						(m.subject ?? "").toLowerCase().includes(q) ||
						(m.bodyText ?? "").toLowerCase().includes(q),
				)
				.slice(0, limit);
		}

		case "mark_read": {
			const { threadId, read } = args as { threadId: string; read: boolean };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const targets = rows.filter(
				(r) => (r.data.threadId ?? r.data.messageId) === threadId,
			);
			for (const row of targets) {
				await messages.put(row.id, { ...row.data, read });
			}
			return { updated: targets.length };
		}

		case "pin_thread": {
			const { threadId, pinned } = args as { threadId: string; pinned: boolean };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const targets = rows.filter(
				(r) => (r.data.threadId ?? r.data.messageId) === threadId,
			);
			for (const row of targets) {
				await messages.put(row.id, { ...row.data, pinned });
			}
			return { updated: targets.length };
		}

		case "snooze_thread": {
			const { threadId, until } = args as { threadId: string; until: string };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const targets = rows.filter(
				(r) => (r.data.threadId ?? r.data.messageId) === threadId,
			);
			for (const row of targets) {
				await messages.put(row.id, {
					...row.data,
					status: "snoozed",
					snoozeUntil: until,
					sortAt: until,
				});
			}
			return { updated: targets.length, until };
		}

		case "mark_done": {
			const { threadId } = args as { threadId: string };
			const all = await messages.query({ limit: 10000 });
			const rows = (all.items ?? []) as { id: string; data: any }[];
			const targets = rows.filter(
				(r) => (r.data.threadId ?? r.data.messageId) === threadId,
			);
			for (const row of targets) {
				await messages.put(row.id, {
					...row.data,
					status: "done",
					snoozeUntil: null,
				});
			}
			return { updated: targets.length };
		}

		default: {
			const exhaustive: never = name;
			throw new Error(`Unhandled MCP tool: ${exhaustive as string}`);
		}
	}
}

/**
 * Minimal JSON-RPC 2.0 dispatcher for the MCP protocol.
 *
 * Returns a JSON-RPC response object (never throws — protocol-level
 * errors are returned in the error envelope so emdash doesn't 500).
 */
export async function dispatchMcpRequest(
	ctx: any,
	request: unknown,
): Promise<unknown> {
	const req = request as {
		jsonrpc?: string;
		id?: number | string | null;
		method?: string;
		params?: unknown;
	};
	const id = req?.id ?? null;

	if (req?.jsonrpc !== "2.0" || typeof req?.method !== "string") {
		return jsonRpcError(id, -32600, "Invalid Request");
	}

	try {
		switch (req.method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id,
					result: {
						// MCP spec revision. Bump when the SDK we pair against bumps.
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "emdash-inbox", version: "0.7.0" },
					},
				};

			case "tools/list": {
				const tools = listInboxTools().map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: stripJsonSchemaMetadata(z.toJSONSchema(tool.inputSchema)),
				}));
				return { jsonrpc: "2.0", id, result: { tools } };
			}

			case "tools/call": {
				const params = req.params as
					| { name?: string; arguments?: unknown }
					| undefined;
				const toolName = params?.name;
				const toolArgs = params?.arguments ?? {};
				const tool = listInboxTools().find((t) => t.name === toolName);
				if (!tool) {
					return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
				}
				const parsed = tool.inputSchema.safeParse(toolArgs);
				if (!parsed.success) {
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{ error: "Invalid arguments", details: parsed.error.flatten() },
										null,
										2,
									),
								},
							],
							isError: true,
						},
					};
				}
				try {
					const result = await runInboxToolHandler(
						ctx,
						tool.name,
						parsed.data,
					);
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{ type: "text", text: JSON.stringify(result, null, 2) },
							],
						},
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ error: message }, null, 2),
								},
							],
							isError: true,
						},
					};
				}
			}

			default:
				return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return jsonRpcError(id, -32603, `Internal error: ${message}`);
	}
}

function jsonRpcError(
	id: number | string | null,
	code: number,
	message: string,
): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Strip zod v4's `$schema` field — MCP clients expect a bare JSON Schema
 * object as `inputSchema`, not a Draft 2020-12 document with metadata.
 * Everything else passes through (properties, required, enum, etc).
 */
function stripJsonSchemaMetadata(schema: unknown): unknown {
	if (schema && typeof schema === "object" && "$schema" in schema) {
		const { $schema: _, ...rest } = schema as Record<string, unknown>;
		return rest;
	}
	return schema;
}
