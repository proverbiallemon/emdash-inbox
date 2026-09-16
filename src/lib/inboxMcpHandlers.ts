import { listDeliveries, reconcileDeliveries, resolveDelivery, type DeliveryAttempt } from "./deliveryJournal";
import { z } from "zod";
import { uploadDraftAttachment, removeDraftAttachment, readAttachment } from "./attachments";
import { listInboxTools, type InboxToolName } from "./inboxMcpTools";
import { composeSend, replySend, draftSave, draftSend, draftDiscard, listDrafts, type Deliver } from "./composeOps";
import { draftSummaryOf } from "./draftSummary";
import { VERSION } from "../version";
import { listThreadPage, searchMessagePage, loadThreadRows, mutateThread, mailboxPublicMessage, requireMailboxReady, type ThreadPageInput, type SearchPageInput } from "./mailboxStore";

/**
 * Shared inbox operations plus the legacy JSON-RPC dispatcher.
 * EmDash 0.38's native MCP endpoint is the preferred transport: nativeMcp.ts
 * registers this catalog and these handlers with the host. The old plugin
 * route remains for existing proxy clients; it implements initialize,
 * tools/list and tools/call, not the host's full HTTP/OAuth lifecycle.
 */

/**
 * Execute one MCP tool against the plugin context. Each handler is a
 * thin wrapper around `ctx.storage.messages` queries we already use for
 * the admin UI — no business logic should live here that doesn't also
 * live in the corresponding admin path. If the admin handler changes,
 * mirror the change here.
 *
 * Native host integration tests exercise these handlers through EmDash.
 */
export async function runInboxToolHandler(
	ctx: any,
	name: InboxToolName,
	args: unknown,
	deliver: Deliver,
	projectSent?: (ctx: any, attempt: DeliveryAttempt) => Promise<{ id: string; threadId: string }>,
): Promise<unknown> {
	if (
		["get_thread", "mark_read", "pin_thread", "snooze_thread", "mark_done", "reply_to_thread", "reply_all_to_thread"].includes(name)
		|| (name === "save_draft" && args !== null && typeof args === "object" && "threadId" in args)
	) await requireMailboxReady(ctx);
	switch (name) {
		case "list_deliveries": return listDeliveries(ctx, args as never);
		case "reconcile_deliveries": {
			if (!projectSent) throw new Error("Delivery recovery unavailable");
			return reconcileDeliveries(ctx, projectSent);
		}
		case "resolve_delivery": {
			if (!projectSent) throw new Error("Delivery recovery unavailable");
			return resolveDelivery(ctx, projectSent, args as never);
		}
		case "add_draft_attachment": return uploadDraftAttachment(ctx, args as never);
		case "remove_draft_attachment": return removeDraftAttachment(ctx, args as never);
		case "read_attachment": return readAttachment(ctx, args as never);
		case "list_threads":
			return listThreadPage(ctx, (args ?? {}) as ThreadPageInput);

		case "get_thread": {
			const { threadId } = args as { threadId: string };
			return (await loadThreadRows(ctx, threadId)).map((row) => ({ ...mailboxPublicMessage(row.data), id: row.id }));
		}

		case "search_messages":
			return searchMessagePage(ctx, args as SearchPageInput);

		case "mark_read": {
			const { threadId, read } = args as { threadId: string; read: boolean };
			return mutateThread(ctx, threadId, () => ({ read }));
		}

		case "pin_thread": {
			const { threadId, pinned } = args as { threadId: string; pinned: boolean };
			return mutateThread(ctx, threadId, () => ({ pinned }));
		}

		case "snooze_thread": {
			const { threadId, until } = args as { threadId: string; until: string };
			return { ...(await mutateThread(ctx, threadId, () => ({ status: "snoozed", snoozeUntil: until, sortAt: until }))), until };
		}

		case "mark_done": {
			const { threadId } = args as { threadId: string };
			return mutateThread(ctx, threadId, () => ({ status: "done", snoozeUntil: null }));
		}

		case "compose_email":
			return composeSend(ctx, deliver, args as never);

		case "reply_to_thread":
			return replySend(ctx, deliver, { ...(args as object), replyAll: false } as never);

		case "reply_all_to_thread":
			return replySend(ctx, deliver, { ...(args as object), replyAll: true } as never);

		case "save_draft":
			return draftSave(ctx, args as never);

		case "list_drafts":
			return (await listDrafts(ctx)).map(draftSummaryOf);

		case "send_draft":
			return draftSend(ctx, deliver, args as never);

		case "discard_draft":
			return draftDiscard(ctx, args as never);

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
	deliver: Deliver,
	projectSent?: (ctx: any, attempt: DeliveryAttempt) => Promise<{ id: string; threadId: string }>,
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
						serverInfo: { name: "emdash-inbox", version: VERSION },
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
						deliver, projectSent,
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
