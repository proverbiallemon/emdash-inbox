import type { DeliveryAttempt } from "./deliveryJournal";
import type { PluginDefinition, PluginRoute } from "emdash";
import type { Deliver } from "./composeOps";
import { listInboxTools } from "./inboxMcpTools";
import { runInboxToolHandler } from "./inboxMcpHandlers";

/** Let the host own MCP transport, authentication, scopes and plugin consent. */
export function nativeInboxMcp(
	deliver: Deliver,
	prepare: (ctx: any) => Promise<void>,
	mapError: (error: unknown) => never,
	projectSent?: (ctx: any, attempt: DeliveryAttempt) => Promise<{ id: string; threadId: string }>,
): { mcp: NonNullable<PluginDefinition["mcp"]>; routes: Record<string, PluginRoute> } {
	const mcp: NonNullable<PluginDefinition["mcp"]> = { tools: {} };
	const routes: Record<string, PluginRoute> = {};
	const reads = new Set(["list_threads", "get_thread", "search_messages", "list_drafts", "read_attachment", "list_deliveries"]);
	for (const tool of listInboxTools()) {
		const route = `mcp/${tool.name}`;
		mcp.tools[tool.name] = {
			description: tool.description, route, input: tool.inputSchema,
			destructive: !reads.has(tool.name),
		};
		routes[route] = {
			permission: "plugins:manage",
			input: tool.inputSchema,
			async handler(ctx) {
				await prepare(ctx);
				try { return await runInboxToolHandler(ctx, tool.name, ctx.input, deliver, projectSent); }
				catch (error) { return mapError(error); }
			},
		};
	}
	return { mcp, routes };
}
