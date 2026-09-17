import { PluginRouteError, type RouteContext } from "emdash";

import { BUNDLE_IDS, validEnabledBundles, type BundleId } from "./bundles";

export interface InboxPreferences { navigation: "top" | "left"; fullWindow: boolean; enabledBundles: BundleId[]; bundledInbox: boolean }
export const defaultInboxPreferences: InboxPreferences = { navigation: "top", fullWindow: false, enabledBundles: [...BUNDLE_IDS], bundledInbox: true };

export async function readInboxPreferences(ctx: Pick<RouteContext, "user" | "kv">) {
	const stored = ctx.user ? await ctx.kv.get<InboxPreferences>(`ui:${encodeURIComponent(ctx.user.id)}`) : null;
	return {
		preferences: { navigation: stored?.navigation === "left" ? "left" as const : "top" as const, fullWindow: stored?.fullWindow === true, enabledBundles: validEnabledBundles(stored?.enabledBundles) ? stored.enabledBundles : [...BUNDLE_IDS], bundledInbox: stored?.bundledInbox !== false },
		userId: ctx.user?.id ?? null, name: ctx.user?.name ?? null, canSave: Boolean(ctx.user),
		senderAddress: (await ctx.kv.get<string>("settings:senderAddress")) ?? "",
	};
}

export async function saveInboxPreferences(ctx: Pick<RouteContext, "user" | "kv" | "input">) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in as a user to save your Inbox layout.");
	const value = ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input) ? ctx.input as Partial<InboxPreferences> : null;
	const layout = value && ("navigation" in value || "fullWindow" in value);
	const bundles = value && ("enabledBundles" in value || "bundledInbox" in value);
	if (!value || typeof value !== "object" || (!layout && !bundles) ||
		(layout && (!["top", "left"].includes(value.navigation ?? "") || typeof value.fullWindow !== "boolean"))) {
		throw PluginRouteError.badRequest("Choose top or left navigation and a full-window preference.");
	}
	if (("enabledBundles" in value && !validEnabledBundles(value.enabledBundles)) ||
		("bundledInbox" in value && typeof value.bundledInbox !== "boolean")) throw PluginRouteError.badRequest("Choose valid, unique bundles and a grouping preference.");
	const previous = (await readInboxPreferences(ctx)).preferences;
	const preferences: InboxPreferences = { ...previous,
		...(layout ? {navigation:value.navigation!,fullWindow:value.fullWindow!} : {}),
		...("enabledBundles" in value ? {enabledBundles:value.enabledBundles!} : {}),
		...("bundledInbox" in value ? {bundledInbox:value.bundledInbox!} : {}),
	};
	await ctx.kv.set(`ui:${encodeURIComponent(ctx.user.id)}`, preferences);
	return { preferences };
}
