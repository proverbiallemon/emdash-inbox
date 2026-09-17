// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OptionsRepository, PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";
import type { MessageDoc } from "../src/index";
import { ensureMailboxIndex, putMessage, mutateMessage, MAILBOX_MIGRATION_KEY } from "../src/lib/mailboxStore";
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: { send: vi.fn() } } }));
let host: Awaited<ReturnType<typeof createNativeHost>>;
let ctx: any;
function message(i: number, extra: Partial<MessageDoc> = {}): MessageDoc {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    return { messageId: `<m${i}@example.com>`, threadId: `t${i}`, direction: "inbound", from: "Shop <receipts@shop.example>", to: "owner@example.com", subject: "Your order confirmation", bodyText: "Thank you for your purchase", bodyHtml: null, bodyRaw: null, receivedAt: date, source: "inbound", status: "inbox", pinned: false, read: false, bundleId: null, sortAt: date, snoozeUntil: null, inReplyTo: null, ...extra };
}
beforeEach(async () => {
    host = await createNativeHost();
    const options = new OptionsRepository(host.db);
    ctx = { storage: Object.fromEntries(Object.entries(host.plugin.storage).map(([name, config]: any) => [name, new PluginStorageRepository(host.db, host.plugin.id, name, config.indexes)])), kv: options, user: { id: "owner" }, log: { warn() { }, error() { } } };
});
afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });
async function ready() { for (let i = 0; i < 30; i++)
    if ((await ensureMailboxIndex(ctx)).complete)
        return; throw Error("indexing did not finish"); }
async function route(name: string, input: any = {}) { return (host.plugin.routes as any)[name].handler({ ...ctx, input }); }
it("counts all 120 conversations, excludes pins and other folders, pages disabled categories once", async () => {
    for (let i = 0; i < 120; i++)
        await putMessage(ctx, `m${i}`, message(i, { pinned: i === 1, read: i % 2 === 0, subject: i % 3 === 0 ? "Hello" : "Your order confirmation" }));
    for (const status of ["done", "snoozed", "draft", "outbox"] as const)
        await host.messages.put(status, message(130, { threadId: status, status }));
    await ready();
    const overview = await route("bundles/overview");
    expect(overview).toMatchObject({ totalCount: 120, unreadCount: 60 });
    expect(overview.bundles.find((b: any) => b.id === "orders")).toMatchObject({ count: 79, unreadCount: 39 });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await route("bundles/list", { section: "conversations", enabled: [], limit: 17, cursor });
        ids.push(...page.items.map((r: any) => r.id));
        cursor = page.cursor;
    } while (cursor);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
    expect(ids[0]).toBe("t1");
    const first = await route("bundles/list", { section: "orders", limit: 17 });
    await expect(route("bundles/list", { section: "conversations", cursor: first.cursor })).rejects.toThrow("cursor");
    const query = vi.spyOn(ctx.storage.messages, "query");
    await route("bundles/overview");
    await route("bundles/list", { section: "orders" });
    expect(query.mock.calls.every(([arg]: any) => arg?.where?.indexDirty === true)).toBe(true);
}, 15000);
it("manual no-bundle survives replies without changing read flags or status", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    expect(await route("bundles/move", { threadId: "t1", bundle: null })).toMatchObject({ moved: true, assignment: { bundle: null, source: "manual" } });
    await putMessage(ctx, "m2", message(2, { threadId: "t1", subject: "Your order has shipped" }));
    await ready();
    const page = await route("bundles/list", { section: "conversations" });
    expect(page.items[0]).toMatchObject({ bundle: { bundle: null, source: "manual" }, unreadCount: 2, latest: { status: "inbox", read: false } });
});
it("sender rules use newest incoming address, apply future only, and require explicit replacement", async () => {
    await putMessage(ctx, "m1", message(1));
    await putMessage(ctx, "m2", message(2));
    await putMessage(ctx, "reply", message(3, { threadId: "t1", direction: "outbound", from: "owner@example.com" }));
    await ready();
    expect(await route("bundles/move", { threadId: "t1", bundle: "fans", saveSenderRule: true })).toMatchObject({ ruleSaved: true });
    await putMessage(ctx, "m4", message(4));
    await mutateMessage(ctx, "m2", () => ({ read: true }));
    await ready();
    expect((await route("bundles/list", { section: "fans" })).items.map((r: any) => r.id).sort()).toEqual(["t1", "t4"]);
    expect((await route("bundles/list", { section: "orders" })).items.map((r: any) => r.id)).toEqual(["t2"]);
    await expect(route("bundles/move", { threadId: "t2", bundle: "commissions", saveSenderRule: true })).rejects.toMatchObject({ status: 409 });
    expect((await route("bundles/list", { section: "orders" })).items[0].id).toBe("t2");
    await route("bundles/move", { threadId: "t2", bundle: "commissions", saveSenderRule: true, replaceRule: true });
    await putMessage(ctx, "m5", message(5));
    await mutateMessage(ctx, "m4", () => ({ read: true }));
    await ready();
    expect((await route("bundles/list", { section: "fans" })).items.map((r: any) => r.id).sort()).toEqual(["t1", "t4"]);
    expect((await route("bundles/rules")).rules).toMatchObject([{ sender: "receipts@shop.example", bundle: "commissions" }]);
});
it("resumes a completed older mailbox migration and excludes private evidence from payloads", async () => {
    for (let i = 0; i < 105; i++)
        await host.messages.put(`m${i}`, { ...message(i), indexSchemaVersion: 1, indexDirty: false });
    await ctx.kv.set(MAILBOX_MIGRATION_KEY, { version: 1, complete: true });
    const first = await route("bundles/list", { section: "orders" });
    expect(first.indexing).toBe(true);
    await ready();
    expect((await route("bundles/overview")).totalCount).toBe(105);
    expect((await route("bundles/list", { section: "orders" })).items[0].latest.bundleEvidence).toBeUndefined();
}, 15000);
it("rejects malformed corrections and declares private-route permissions", async () => {
    for (const name of ["bundles/overview", "bundles/list", "bundles/move", "bundles/rules"])
        expect((host.plugin.routes as any)[name].permission).toBe("plugins:manage");
    for (const input of [{ threadId: "t1", bundle: "unknown" }, { threadId: "t1", bundle: null, sender: "evil@example.com" }, { threadId: "t1", bundle: null, saveSenderRule: "yes" }])
        await expect(route("bundles/move", input)).rejects.toMatchObject({ status: 400 });
    await expect(route("bundles/list", { section: "orders", enabled: ["orders", "orders"] })).rejects.toMatchObject({ status: 400 });
});
it("separates a successful move from sender-rule storage failure and never claims failed move success", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    vi.spyOn(ctx.storage.bundleRules, "compareAndSet").mockRejectedValueOnce(Error("rule write unavailable"));
    expect(await route("bundles/move", { threadId: "t1", bundle: "shipping", saveSenderRule: true })).toMatchObject({ moved: true, ruleSaved: false, ruleError: expect.any(String) });
    expect((await route("bundles/list", { section: "shipping" })).items[0].id).toBe("t1");
    vi.spyOn(ctx.storage.bundleOverrides, "compareAndSet").mockRejectedValueOnce(Error("override write unavailable"));
    await expect(route("bundles/move", { threadId: "t1", bundle: "fans" })).rejects.toThrow("override write unavailable");
    expect((await route("bundles/list", { section: "shipping" })).items[0].id).toBe("t1");
});
it("preserves incoming mail on rule-read failure and ignores spoofed display-name senders", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    await route("bundles/move", { threadId: "t1", bundle: "fans", saveSenderRule: true });
    await putMessage(ctx, "m2", message(2, { from: '"receipts@shop.example" <stranger@elsewhere.example>' }));
    vi.spyOn(ctx.storage.bundleRules, "get").mockRejectedValueOnce(Error("rules unavailable"));
    await putMessage(ctx, "m3", message(3));
    await ready();
    expect(await host.messages.get("m3")).toMatchObject({ status: "inbox", read: false });
    expect((await route("bundles/list", { section: "conversations" })).items.map((r: any) => r.id)).toEqual(["t3"]);
    expect((await route("bundles/list", { section: "orders" })).items.map((r: any) => r.id)).toEqual(["t2"]);
});
it("repairs a durably saved correction after projection publication fails", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    vi.spyOn(ctx.storage.threads, "compareAndSet").mockRejectedValueOnce(Error("projection unavailable"));
    expect(await route("bundles/move", { threadId: "t1", bundle: "shipping" })).toMatchObject({ moved: true });
    expect((await route("bundles/list", { section: "shipping" })).items[0].bundle).toMatchObject({ bundle: "shipping", source: "manual" });
});
it("keeps corrupt persisted assignments visible and correctable", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    await ctx.storage.bundleOverrides.put("t1", { version: 1, threadId: "t1", bundle: "unrecognized", dirty: true });
    expect((await route("bundles/list", { section: "conversations" })).items.map((r: any) => r.id)).toEqual(["t1"]);
    await route("bundles/move", { threadId: "t1", bundle: "shipping" });
    expect((await route("bundles/list", { section: "shipping" })).items[0].id).toBe("t1");
});
it.each(["rule-read failure", "corrupt evidence"])("returns an already bundled thread to Conversations after newer %s, preserving manual overrides", async (failure) => {
    await putMessage(ctx, "m1", message(1));
    await putMessage(ctx, "m2", message(2, { threadId: "t1", subject: "Acknowledged" }));
    await ready();
    expect((await route("bundles/list", { section: "orders" })).items[0]).toMatchObject({ id: "t1", unreadCount: 2 });
    async function incomingWithFailure(id: string, time: number) {
        if (failure === "rule-read failure") vi.spyOn(ctx.storage.bundleRules, "get").mockRejectedValueOnce(Error("rules unavailable"));
        await putMessage(ctx, id, message(time, { threadId: "t1", subject: "Following up" }));
        if (failure === "corrupt evidence") {
            const stored = await host.messages.get(id);
            await host.messages.put(id, { ...stored!, bundleEvidence: { version: 1, assignment: { bundle: "corrupt-category", source: "sender" } } as any });
        }
    }
    await incomingWithFailure("m3", 3);
    await ready();
    expect((await route("bundles/list", { section: "conversations" })).items[0]).toMatchObject({ id: "t1", unreadCount: 3, bundle: { bundle: null, source: "none" } });
    expect((await route("bundles/list", { section: "orders" })).items).toEqual([]);
    expect((await route("bundles/overview")).bundles.find((bundle: any) => bundle.id === "orders").count).toBe(0);
    await route("bundles/move", { threadId: "t1", bundle: "shipping" });
    await incomingWithFailure("m4", 4);
    await ready();
    expect((await route("bundles/list", { section: "shipping" })).items[0]).toMatchObject({ id: "t1", unreadCount: 4, bundle: { bundle: "shipping", source: "manual" } });
});
