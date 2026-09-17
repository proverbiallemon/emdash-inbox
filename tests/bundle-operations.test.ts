// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OptionsRepository, PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";
import { projectDeliveryMessage } from "../src/lib/deliveryJournal";
import type { MessageDoc } from "../src/index";
import { ensureMailboxIndex, putMessage, mutateMessage, mutateThread, makeThreadIndex } from "../src/lib/mailboxStore";
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: { send: vi.fn() } } }));
let host: Awaited<ReturnType<typeof createNativeHost>>;
let ctx: any;
function message(i: number, extra: Partial<MessageDoc> = {}): MessageDoc {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    return { messageId: `<m${i}@example.com>`, threadId: `t${i}`, direction: "inbound", from: "shop@example.com", to: "owner@example.com", subject: "Your order confirmation", bodyText: "Private body", bodyHtml: null, bodyRaw: null, receivedAt: date, source: "inbound", status: "inbox", pinned: false, read: false, bundleId: null, sortAt: date, snoozeUntil: null, inReplyTo: null, ...extra };
}
beforeEach(async () => { host = await createNativeHost(); ctx = { storage: Object.fromEntries(Object.entries(host.plugin.storage).map(([name, config]: any) => [name, new PluginStorageRepository(host.db, host.plugin.id, name, config.indexes)])), kv: new OptionsRepository(host.db), user: { id: "owner" }, log: { warn() { }, error() { } } }; });
afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });
async function ready() { for (let i = 0; i < 40; i++)
    if ((await ensureMailboxIndex(ctx)).complete)
        return; throw Error("index incomplete"); }
async function route(name: string, input: any = {}, context = ctx) { return (host.plugin.routes as any)[`bundles/${name}`].handler({ ...context, input }); }
async function prepare(requestId = "one") { let view: any; for (let i = 0; i < 50; i++) {
    view = await route("done-prepare", { bundle: "orders", requestId });
    if (view.phase === "ready")
        return view;
} throw Error("prepare incomplete"); }
async function finish(id: string, retry = false) { let view: any; for (let i = 0; i < 50; i++) {
    view = await route("done-run", { operationId: id, retry });
    if (view.phase === "complete")
        return view;
} throw Error("run incomplete"); }
it("snapshots all native pages, excludes pins/folders, requires confirmation and scopes requests", async () => {
    for (let i = 0; i < 112; i++)
        await putMessage(ctx, `m${i}`, message(i, { pinned: i === 1, status: i === 2 ? "done" : "inbox" }));
    await ready();
    const first = await route("done-prepare", { bundle: "orders", requestId: "one" });
    expect(first.phase).toBe("preparing");
    await expect(route("done-run", { operationId: first.id })).rejects.toMatchObject({ status: 409 });
    const op = await prepare();
    expect(op).toMatchObject({ total: 110, unreadCount: 110, phase: "ready" });
    expect(await prepare()).toMatchObject({ id: op.id, total: 110 });
    await expect(route("done-prepare", { bundle: "shipping", requestId: "one" })).rejects.toMatchObject({ status: 409 });
    for (const action of ["done-run", "done-status", "done-threads"])
        await expect(route(action, { operationId: op.id }, { ...ctx, user: { id: "other" } })).rejects.toMatchObject({ status: 404 });
    const [done] = await Promise.all([finish(op.id), finish(op.id)]);
    expect(done.counts).toMatchObject({ done: 110, pending: 0, failed: 0, skipped: 0 });
    expect(await makeThreadIndex(ctx, "t1")).toMatchObject({ status: "inbox", pinned: true });
    expect(await host.messages.get("m0")).toMatchObject({ status: "done", read: false });
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
        const page = await route("done-threads", { operationId: op.id, limit: 17, cursor });
        ids.push(...page.items.map((x: any) => x.threadId));
        cursor = page.cursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(110);
    await mutateMessage(ctx, "m0", () => ({ status: "inbox" }));
    await Promise.all([finish(op.id, true), finish(op.id, true)]);
    expect(await host.messages.get("m0")).toMatchObject({ status: "inbox", read: false });
}, 20000);
it.each(["pin", "override", "arrival"])("fences %s between final source check and bulk CAS", async (kind) => {
    await putMessage(ctx, "old", message(1, { threadId: "t" }));
    await putMessage(ctx, "head", message(2, { threadId: "t" }));
    await ready();
    const op = await prepare();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let injected = false;
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => {
        if (next.bulkReceipt && !injected) {
            injected = true;
            if (kind === "pin")
                await mutateMessage(ctx, "old", () => ({ pinned: true }));
            if (kind === "override")
                await route("move", { threadId: "t", bundle: "shipping" });
            if (kind === "arrival")
                await (putMessage as any)(ctx, "arrival", message(0, { threadId: "t" }), { liveInbound: true });
        }
        return original(id, revision, next);
    });
    const done = await finish(op.id);
    expect(done.counts.skipped).toBe(1);
    expect(await makeThreadIndex(ctx, "t")).toMatchObject({ status: "inbox", unreadCount: kind === "arrival" ? 3 : 2 });
    expect(await host.messages.get("head")).toMatchObject({ status: "inbox", read: false });
});
it("live late and same-time low-ID arrivals reopen completed mail while historical chronology stays unchanged", async () => {
    await putMessage(ctx, "z", message(1, { threadId: "t", receivedAt: "2099-01-01T00:00:00.000Z" }));
    await ready();
    const op = await prepare();
    await finish(op.id);
    await (putMessage as any)(ctx, "a", message(0, { threadId: "t" }), { liveInbound: true });
    expect(await makeThreadIndex(ctx, "t")).toMatchObject({ status: "inbox", latestId: "a", unreadCount: 2 });
    await mutateMessage(ctx, "a", () => ({ status: "done" }));
    await putMessage(ctx, "history", message(0, { threadId: "t" }));
    expect(await makeThreadIndex(ctx, "t")).toMatchObject({ status: "done", latestId: "a" });
});
it("reconciles lost source acknowledgement after manual reopen, before a later bulk replaces its receipt", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    const op = await prepare();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let lost = false;
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { const result = await original(id, revision, next); if (next.bulkReceipt && !lost) {
        lost = true;
        await mutateMessage(ctx, "m1", () => ({ status: "inbox" }));
        throw Error("response lost");
    } return result; });
    expect((await finish(op.id)).counts.done).toBe(1);
    expect(await host.messages.get("m1")).toMatchObject({ status: "inbox" });
    const second = await prepare("two");
    expect((await finish(second.id)).counts.done).toBe(1);
    expect((await route("done-status", { operationId: op.id })).counts.done).toBe(1);
});
it("retains unresolved whole-thread mutation intents and never admits a partially pinned thread", async () => {
    await putMessage(ctx, "old", message(1, { threadId: "t" }));
    await putMessage(ctx, "head", message(2, { threadId: "t" }));
    await ready();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let failed = false;
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (id === "old" && next.pinned && !failed) {
        failed = true;
        throw Error("unknown writer");
    } return original(id, revision, next); });
    await expect(mutateThread(ctx, "t", () => ({ pinned: true }))).rejects.toThrow("unknown writer");
    await mutateMessage(ctx, "head", () => ({ read: true }));
    const op = await prepare();
    expect((await finish(op.id)).counts.skipped).toBe(1);
    expect(await makeThreadIndex(ctx, "t")).toMatchObject({ status: "inbox" });
});
it("retries only transient failed candidates against original snapshot, and preserves terminal outcomes", async () => {
    await putMessage(ctx, "m1", message(1));
    await putMessage(ctx, "m2", message(2));
    await ready();
    const op = await prepare();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let fail = true;
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (id === "m1" && next.bulkReceipt && fail) {
        fail = false;
        throw Error("temporary write failure");
    } return original(id, revision, next); });
    expect((await finish(op.id)).counts).toMatchObject({ done: 1, failed: 1 });
    expect(await host.messages.get("m1")).toMatchObject({ status: "inbox", read: false });
    await mutateMessage(ctx, "m2", () => ({ status: "inbox" }));
    expect((await finish(op.id, true)).counts).toMatchObject({ done: 2, failed: 0 });
    expect(await host.messages.get("m2")).toMatchObject({ status: "inbox" });
});
it("settles a durable receipt before replacement when all first-operation journal publications failed", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    const first = await prepare();
    const original = ctx.storage.bundleCandidates.compareAndSet.bind(ctx.storage.bundleCandidates);
    const spy = vi.spyOn(ctx.storage.bundleCandidates, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (next.outcome === "done")
        throw Error("journal unavailable"); return original(id, revision, next); });
    await expect(route("done-run", { operationId: first.id })).rejects.toThrow("journal unavailable");
    expect(await host.messages.get("m1")).toMatchObject({ status: "done", bulkReceipt: { operationId: first.id } });
    await mutateMessage(ctx, "m1", () => ({ status: "inbox" }));
    spy.mockRestore();
    const second = await prepare("second");
    expect((await finish(second.id)).counts.done).toBe(1);
    expect((await route("done-status", { operationId: first.id })).counts.done).toBe(1);
    expect(await host.messages.get("m1")).toMatchObject({ bulkReceipt: { operationId: second.id } });
});
it("excludes a creation paused across cutoff and an exactly equal admission timestamp, with finite preparation", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    await prepare("warmup");
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let resume!: () => void;
    let published!: () => void;
    const paused = new Promise<void>(resolve => { published = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { const result = await original(id, revision, next); if (id === "late" && revision === null) {
        published();
        await release;
    } return result; });
    const ingestion = (putMessage as any)(ctx, "late", message(2), { liveInbound: true });
    await paused;
    const op = await prepare("cutoff");
    const stored = await ctx.storage.bundleOperations.get(op.id);
    resume();
    await ingestion;
    expect(op.total).toBe(1);
    expect((await finish(op.id)).counts.done).toBe(1);
    expect(await host.messages.get("late")).toMatchObject({ status: "inbox", read: false });
    // Explicit equality exercises the strict boundary even on clocks with coarse resolution.
    await host.messages.put("equal", { ...message(3), admittedAt: stored.cutoff });
    expect((await route("done-prepare", { bundle: "orders", requestId: "cutoff" })).total).toBe(1);
});
it("holds one intent across an entire multi-row pin action while prepare is concurrent", async () => {
    await putMessage(ctx, "old", message(1, { threadId: "t" }));
    await putMessage(ctx, "head", message(2, { threadId: "t" }));
    await ready();
    await prepare("warmup");
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(r => { reached = r; });
    const release = new Promise<void>(r => { resume = r; });
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (id === "old" && next.pinned) {
        reached();
        await release;
    } return original(id, revision, next); });
    const pinning = mutateThread(ctx, "t", () => ({ pinned: true }));
    await paused;
    await mutateMessage(ctx, "head", () => ({ read: true }));
    const op = await prepare("during");
    expect((await finish(op.id)).counts.skipped).toBe(1);
    resume();
    await pinning;
    expect(await makeThreadIndex(ctx, "t")).toMatchObject({ status: "inbox", pinned: true });
});
it("shows canonical incoming sender for latest-outgoing threads and rejects stale sender consent", async () => {
    await putMessage(ctx, "m1", message(1, { from: "Shop <Receipts@Shop.Example>" }));
    await putMessage(ctx, "reply", message(2, { threadId: "t1", direction: "outbound", from: "owner@example.com" }));
    await ready();
    const page = await route("list", { section: "orders" });
    expect(page.items[0]).toMatchObject({ bundleSender: "receipts@shop.example", latest: { direction: "outbound" } });
    await putMessage(ctx, "m3", message(3, { threadId: "t1", from: "other@example.com" }));
    await expect(route("move", { threadId: "t1", bundle: "fans", saveSenderRule: true, expectedSender: "receipts@shop.example" })).rejects.toMatchObject({ status: 409 });
    expect(await ctx.storage.bundleOverrides.get("t1")).toBeNull();
    expect(await ctx.storage.bundleRules.count()).toBe(0);
});
it("keeps the confirmation snapshot immutable under concurrent preparation, arrivals and display reordering", async () => {
    for (let i = 0; i < 105; i++)
        await putMessage(ctx, `m${i}`, message(i));
    await ready();
    const first = await route("done-prepare", { bundle: "orders", requestId: "many" });
    // Finish legacy admission indexing first, without allowing arrival to enter a pre-cutoff snapshot.
    let op = first;
    while (!(await ctx.storage.bundleOperations.get(op.id)).cutoff)
        op = await route("done-prepare", { bundle: "orders", requestId: "many" });
    await (putMessage as any)(ctx, "new-thread", message(200), { liveInbound: true });
    await mutateMessage(ctx, "m100", () => ({ sortAt: "2099-01-01T00:00:00.000Z" }));
    await Promise.all([prepare("many"), prepare("many")]);
    op = await route("done-status", { operationId: op.id });
    expect(op.total).toBe(105);
    expect((await finish(op.id)).counts.done).toBe(105);
    expect(await host.messages.get("new-thread")).toMatchObject({ status: "inbox", read: false });
}, 20000);
it("retries every failed candidate across bounded pages, without repeatedly retrying a persistent failure", async () => {
    for (let i = 0; i < 53; i++)
        await putMessage(ctx, `m${i}`, message(i));
    await ready();
    const op = await prepare();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let failAll = true;
    const attempts = new Map<string, number>();
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (next.bulkReceipt) {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (failAll || id === "m0")
            throw Error("transient");
    } return original(id, revision, next); });
    expect((await finish(op.id)).counts.failed).toBe(53);
    failAll = false;
    expect((await finish(op.id, true)).counts).toMatchObject({ done: 52, failed: 1 });
    expect(attempts.get("m0")).toBe(2);
}, 20000);
it("returns current public thread summaries on operation pages after newer mail reopens a completed thread", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    const op = await prepare();
    await finish(op.id);
    await (putMessage as any)(ctx, "m2", message(2, { threadId: "t1", subject: "A later reply" }), { liveInbound: true });
    const page = await route("done-threads", { operationId: op.id });
    expect(page.items[0]).toMatchObject({ outcome: "done", summary: { id: "t1", unreadCount: 2, latest: { subject: "A later reply", status: "inbox", read: false } } });
    expect(page.items[0].summary.latest.bulkReceipt).toBeUndefined();
    expect(page.items[0].summary.latest.admittedAt).toBeUndefined();
});
it("uses bounded opaque operation IDs for valid request IDs that expand under URI encoding", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    const requestId = "é /".repeat(100);
    const op = await prepare(requestId);
    expect(op.id.length).toBeLessThan(100);
    expect((await finish(op.id)).counts.done).toBe(1);
    expect((await route("done-status", { operationId: op.id })).counts.done).toBe(1);
});
it.each(["first projection", "receipt rethread"])("fences %s publication on every affected conversation", async (mode) => {
    const oldThread = "<old@provider.example>", newThread = "<new@provider.example>";
    await putMessage(ctx, "head-old", message(2, { threadId: oldThread }));
    await putMessage(ctx, "head-new", message(3, { threadId: newThread }));
    const draft = message(0, { messageId: oldThread, threadId: oldThread, direction: "outbound", status: mode === "first projection" ? "outbox" : "done", deliveryAttemptId: "delivery", deliveryProjected: mode !== "first projection" });
    if (mode === "first projection")
        await host.messages.put("outgoing", draft);
    else
        await putMessage(ctx, "outgoing", draft);
    const attempt: any = { attemptId: "delivery", messageId: "outgoing", fingerprint: "fingerprint", snapshot: draft, state: "accepted", createdAt: draft.receivedAt, updatedAt: draft.receivedAt, receipt: { messageId: newThread } };
    await ctx.storage.deliveries.put("delivery", attempt);
    await ready();
    const op = await prepare();
    const original = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
    let published = false;
    vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { if (next.bulkReceipt && !published) {
        published = true;
        await projectDeliveryMessage(ctx, attempt, { ...draft, messageId: newThread, threadId: mode === "first projection" ? oldThread : newThread, status: "done", bodyRaw: "sent" });
    } return original(id, revision, next); });
    const done = await finish(op.id);
    expect(done.counts.skipped).toBe(mode === "first projection" ? 1 : 2);
    expect(await makeThreadIndex(ctx, oldThread)).toMatchObject({ status: "inbox", unreadCount: mode === "first projection" ? 2 : 1 });
    if (mode === "receipt rethread")
        expect(await makeThreadIndex(ctx, newThread)).toMatchObject({ status: "inbox", unreadCount: 2 });
    expect(await host.messages.get("outgoing")).toMatchObject({ admittedAt: expect.any(String), deliveryProjected: true });
});
it.each(["intent", "creation", "admission"])("recovers a lost %s acknowledgement without leaving an unsafe publication", async (stage) => {
    const collection = stage === "intent" ? ctx.storage.threadMutationIntents : ctx.storage.messages;
    const original = collection.compareAndSet.bind(collection);
    let lost = false;
    vi.spyOn(collection, "compareAndSet").mockImplementation(async (id: any, revision: any, next: any) => { const result = await original(id, revision, next); if (!lost && (stage === "intent" || stage === "creation" && revision === null || stage === "admission" && next.admittedAt)) {
        lost = true;
        throw Error("acknowledgement lost");
    } return result; });
    await (putMessage as any)(ctx, "m1", message(1), { liveInbound: true });
    expect(await host.messages.get("m1")).toMatchObject({ status: "inbox", read: false, admittedAt: expect.any(String) });
    expect(await ctx.storage.threadMutationIntents.count()).toBe(0);
    await ready();
    const op = await prepare();
    expect((await finish(op.id)).counts.done).toBe(1);
});
it("strictly excludes equality at the admission cutoff while source preparation is still paging", async () => {
    for (let i = 0; i < 27; i++)
        await putMessage(ctx, `m${i}`, message(i));
    await ready();
    await prepare("warmup");
    let op = await route("done-prepare", { bundle: "orders", requestId: "equal" });
    expect(op.phase).toBe("preparing");
    const saved = await ctx.storage.bundleOperations.get(op.id);
    await host.messages.put("equal", { ...message(100), admittedAt: saved.cutoff });
    op = await prepare("equal");
    expect(op.total).toBe(27);
    expect((await finish(op.id)).counts.done).toBe(27);
    expect(await host.messages.get("equal")).toMatchObject({ status: "inbox", read: false });
});
it("reports a committed correction and saves the chosen sender rule despite intent-cleanup failure", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    vi.spyOn(ctx.storage.threadMutationIntents, "compareAndDelete").mockRejectedValueOnce(Error("cleanup response lost"));
    expect(await route("move", { threadId: "t1", bundle: "fans", saveSenderRule: true, expectedSender: "shop@example.com" })).toMatchObject({ moved: true, ruleSaved: true });
    expect(await ctx.storage.bundleOverrides.get("t1")).toMatchObject({ bundle: "fans" });
    expect(await ctx.storage.bundleRules.get("shop@example.com")).toMatchObject({ bundle: "fans" });
    expect(await ctx.storage.threadMutationIntents.count()).toBe(1);
});
it("retires its own intent on known no-write rejections while preserving normal mail", async () => {
    await putMessage(ctx, "m1", message(1));
    await ready();
    await expect(mutateMessage(ctx, "m1", () => ({ status: "draft" }))).rejects.toThrow("cannot turn");
    expect(await ctx.storage.threadMutationIntents.count()).toBe(0);
    expect(await host.messages.get("m1")).toMatchObject({ status: "inbox" });
    vi.spyOn(ctx.storage.bundleOverrides, "compareAndSet").mockResolvedValueOnce({ applied: false });
    await expect(route("move", { threadId: "t1", bundle: "fans" })).rejects.toMatchObject({ status: 409 });
    expect(await ctx.storage.threadMutationIntents.count()).toBe(0);
});
