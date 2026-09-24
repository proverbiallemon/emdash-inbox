// @vitest-environment node
import { expect, it } from "vitest";
import { createPlugin } from "../src/index";

function context(id?: string) {
	const store = new Map<string, unknown>();
	return { store, ctx: { user: id ? { id } : undefined, kv: {
		get: async (key: string) => store.get(key),
		set: async (key: string, value: unknown) => { store.set(key, value); },
	} } };
}
async function request(route: "signature/get" | "signature/save", ctx: any, input: unknown = {}) {
	const definition = createPlugin().routes[route];
	expect(definition.permission).toBe("plugins:manage");
	return definition.handler({ ...ctx, input });
}

it("saves, normalizes and clears only the authenticated user's signature", async () => {
	const { ctx, store } = context("owner/a");
	store.set("settings:senderAddress", "owner@example.com");
	store.set("ui:owner%2Fa", { navigation: "left" });
	await request("signature/save", ctx, { text: "  Alex & Co\r\nDesigner\rStudio  ", newMessages: true, replies: false, userId: "someone-else" });
	expect(await request("signature/get", ctx)).toEqual({ signature: { text: "Alex & Co\nDesigner\nStudio", newMessages: true, replies: false }, canSave: true });
	expect(await request("signature/get", { ...ctx, user: { id: "someone-else" } })).toEqual({ signature: { text: "", newMessages: true, replies: true }, canSave: true });
	expect(store.get("settings:senderAddress")).toBe("owner@example.com");
	expect(store.get("ui:owner%2Fa")).toEqual({ navigation: "left" });
	await request("signature/save", ctx, { text: "\n  ", newMessages: false, replies: true });
	expect(await request("signature/get", ctx)).toMatchObject({ signature: { text: "", newMessages: false, replies: true } });
});

it("rejects token-only saves and malformed or oversized signatures without changing saved mail preferences", async () => {
	const { ctx, store } = context();
	expect(await request("signature/get", ctx)).toMatchObject({ canSave: false, signature: { text: "" } });
	await expect(request("signature/save", ctx, { text: "Alex", newMessages: true, replies: true })).rejects.toMatchObject({ status: 403 });
	const owner = { ...ctx, user: { id: "owner" } };
	for (const input of [null, [], "bad", {}, { text: 7, newMessages: true, replies: true }, { text: "Alex", newMessages: "true", replies: true }, { text: "Alex", newMessages: true }, { text: "a".repeat(10001), newMessages: true, replies: true }, { text: "Alex\0", newMessages: true, replies: true }]) {
		await expect(request("signature/save", owner, input)).rejects.toMatchObject({ status: 400 });
	}
	expect(store.size).toBe(0);
});
