import { PluginRouteError, type RouteContext } from "emdash";

export interface InboxPreferences { navigation: "top" | "left"; fullWindow: boolean }
export const defaultInboxPreferences: InboxPreferences = { navigation: "top", fullWindow: false };

export async function readInboxPreferences(ctx: Pick<RouteContext, "user" | "kv">) {
	const stored = ctx.user ? await ctx.kv.get<InboxPreferences>(`ui:${encodeURIComponent(ctx.user.id)}`) : null;
	return {
		preferences: { navigation: stored?.navigation === "left" ? "left" as const : "top" as const, fullWindow: stored?.fullWindow === true },
		name: ctx.user?.name ?? null, canSave: Boolean(ctx.user),
		senderAddress: (await ctx.kv.get<string>("settings:senderAddress")) ?? "",
	};
}

export async function saveInboxPreferences(ctx: Pick<RouteContext, "user" | "kv" | "input">) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in as a user to save your Inbox layout.");
	const value = ctx.input as Partial<InboxPreferences> | null;
	if (!value || !["top", "left"].includes(value.navigation ?? "") || typeof value.fullWindow !== "boolean") {
		throw PluginRouteError.badRequest("Choose top or left navigation and a full-window preference.");
	}
	const preferences: InboxPreferences = { navigation: value.navigation!, fullWindow: value.fullWindow };
	await ctx.kv.set(`ui:${encodeURIComponent(ctx.user.id)}`, preferences);
	return { preferences };
}
