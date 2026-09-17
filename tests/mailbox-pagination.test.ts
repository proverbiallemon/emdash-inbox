// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionsRepository, PluginStorageRepository } from "emdash";
import type { MessageDoc } from "../src/index";
import { runInboxToolHandler } from "../src/lib/inboxMcpHandlers";
import { createNativeHost } from "./helpers/nativeHost";
import { allRows, ensureMailboxIndex, listThreadPage, mutateMessage, putMessage, wakeSnoozed } from "../src/lib/mailboxStore";

vi.mock("cloudflare:workers", () => ({ env: { EMAIL: { send: vi.fn() } } }));

function message(i: number, overrides: Partial<MessageDoc> = {}): MessageDoc {
	const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
	return {
		messageId: `<m${i}@example.com>`, threadId: "<conversation@example.com>",
		direction: "inbound", from: "reader@example.com", to: "owner@example.com",
		subject: `Message ${i}`, bodyText: `Text ${i}`, bodyHtml: null, bodyRaw: "private MIME",
		receivedAt, source: "inbound", status: "inbox", pinned: false, read: false,
		bundleId: null, sortAt: receivedAt, snoozeUntil: null, inReplyTo: null, ...overrides,
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("complete mailbox operations against EmDash SQLite", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	let ctx: any;
	beforeEach(async () => {
		host = await createNativeHost();
		const options = new OptionsRepository(host.db);
		ctx = {
			storage: { messages: new PluginStorageRepository<MessageDoc>(host.db, "emdash-inbox", "messages", [
				...host.plugin.storage.messages.indexes, "messageId", "indexDirty", "messageKey",
			]),
			threads: new PluginStorageRepository(host.db, "emdash-inbox", "threads", host.plugin.storage.threads.indexes),
			bundleOverrides: new PluginStorageRepository(host.db, "emdash-inbox", "bundleOverrides", host.plugin.storage.bundleOverrides.indexes),
			bundleRules: new PluginStorageRepository(host.db, "emdash-inbox", "bundleRules", host.plugin.storage.bundleRules.indexes),
			searchDocuments: new PluginStorageRepository(host.db, "emdash-inbox", "searchDocuments", ["messageKey"]),
			},
			kv: { get: options.get.bind(options), set: options.set.bind(options), delete: options.delete.bind(options), getVersioned: options.getVersioned.bind(options), compareAndSet: options.compareAndSet.bind(options) },
			log: { info() {}, warn() {}, error() {} },
		};
		await ctx.kv.delete("state:mailbox-index:v1");
	});
	afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });

	it("gets every real message beyond the storage page cap and excludes a reply draft", async () => {
		for (let i = 0; i < 120; i++) await host.messages.put(`m${i}`, message(i));
		await host.messages.put("draft", message(121, { status: "draft" }));
		await expect(runInboxToolHandler(ctx, "get_thread", { threadId: "<conversation@example.com>" }, async () => null)).rejects.toThrow("indexing is still in progress");
		await readyPage();
		const result = await runInboxToolHandler(ctx, "get_thread", { threadId: "<conversation@example.com>" }, async () => null) as MessageDoc[];
		expect(result).toHaveLength(120);
		expect(result.at(-1)?.subject).toBe("Message 119");
	});

	async function tool(name: Parameters<typeof runInboxToolHandler>[1], args: unknown) {
		return runInboxToolHandler(ctx, name, args, async () => null) as Promise<any>;
	}

	async function readyPage(args: Record<string, unknown> = {}) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const page = await tool("list_threads", args);
			if (!page.indexing) return page;
		}
		throw new Error("Index did not finish");
	}

	it("pages complete threads beyond 100 rows with a global pinned ordering", async () => {
		for (let i = 0; i < 120; i++) await host.messages.put(`m${i}`, message(i, { threadId: `<t${i}@example.com>`, pinned: i === 0 }));
		await host.messages.put("old-reply", message(-1, { threadId: "<t119@example.com>", status: "done" }));
		const first = await readyPage({ limit: 25 });
		expect(first.items).toHaveLength(25);
		expect(first.items[0].threadId).toBe("<t0@example.com>");
		expect(first.items[1]).toMatchObject({ threadId: "<t119@example.com>", messageCount: 2 });
		expect(first.items[0].latest.bodyRaw).toBeUndefined();
		const all = [...first.items];
		let page = first;
		while (page.hasMore) { page = await readyPage({ limit: 25, cursor: page.cursor }); all.push(...page.items); }
		expect(all).toHaveLength(120);
		expect(new Set(all.map((item: any) => item.id)).size).toBe(120);
	});

	it("pages only pinned threads through the existing sort index and rejects another view’s cursor", async () => {
		for (let i = 0; i < 115; i++) await host.messages.put(`pin${i}`, message(i, { threadId: `<pin${i}@example.com>`, pinned: i % 2 === 0 }));
		await readyPage();
		const input = {status: "all" as const, pinnedOnly: true, limit: 17};
		let page = await listThreadPage(ctx, input);
		await expect(listThreadPage(ctx, { status: "all", cursor: page.cursor })).rejects.toThrow("Invalid pagination cursor");
		const items = [...page.items];
		while (page.hasMore) { page = await listThreadPage(ctx, {...input, cursor: page.cursor}); items.push(...page.items); }
		expect(items).toHaveLength(58);
		expect(items.every(item => item.pinned)).toBe(true);
		expect(new Set(items.map(item => item.threadId)).size).toBe(58);
	});

	it("applies thread mutations to every message and leaves reply drafts unchanged", async () => {
		for (let i = 0; i < 120; i++) await host.messages.put(`m${i}`, message(i));
		await host.messages.put("draft", message(121, { status: "draft", read: false }));
		await expect(tool("mark_read", { threadId: "<conversation@example.com>", read: true })).rejects.toThrow("indexing is still in progress");
		expect(await host.messages.get("m0")).toMatchObject({ read: false });
		await readyPage();
		await tool("mark_read", { threadId: "<conversation@example.com>", read: true });
		expect(await host.messages.get("m119")).toMatchObject({ read: true });
		expect(await host.messages.get("draft")).toMatchObject({ status: "draft", read: false });
		await readyPage();
		await tool("pin_thread", { threadId: "<conversation@example.com>", pinned: true });
		await readyPage();
		await tool("mark_done", { threadId: "<conversation@example.com>" });
		const page = await readyPage({ status: "done" });
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ messageCount: 120, unreadCount: 0, pinned: true });
		// Hundreds of real SQLite writes can exceed the default 5s on CI disks.
	}, 15_000);

	it("resumes substring search exactly after a partially inspected page", async () => {
		for (let i = 0; i < 120; i++) await host.messages.put(`m${i}`, message(i, { bodyText: i % 2 ? "Needle in a body" : "Other text" }));
		await readyPage();
		const found: MessageDoc[] = [];
		let cursor: string | undefined;
		do {
			const page = await tool("search_messages", { query: "eEdLe", limit: 7, cursor });
			expect(Array.isArray(page.items)).toBe(true);
			found.push(...page.items);
			cursor = page.cursor;
			if (!page.hasMore) break;
		} while (cursor);
		expect(found).toHaveLength(60);
		expect(new Set(found.map((item) => item.messageId)).size).toBe(60);
		expect(found.at(-1)?.subject).toBe("Message 1");
	});

	it("keeps keyset continuation stable when the previous boundary thread moves", async () => {
		for (let i = 0; i < 6; i++) await putMessage(ctx, `m${i}`, message(i, { threadId: `<t${i}@example.com>` }));
		const first = await readyPage({ limit: 2 });
		expect(first.items.map((item: any) => item.threadId)).toEqual(["<t5@example.com>", "<t4@example.com>"]);
		await mutateMessage(ctx, "m4", () => ({ pinned: true }));
		const second = await readyPage({ limit: 2, cursor: first.cursor });
		expect(second.items.map((item: any) => item.threadId)).toEqual(["<t3@example.com>", "<t2@example.com>"]);
		await expect(readyPage({ status: "done", cursor: first.cursor })).rejects.toMatchObject({ name: "MailboxInputError" });
		await expect(readyPage({ cursor: "invalid!" })).rejects.toMatchObject({ name: "MailboxInputError" });
	});

	it("continues past a zero-match search scan window", async () => {
		for (let i = 0; i < 220; i++) await putMessage(ctx, `m${i}`, message(i, { bodyText: i === 0 ? "Only needle" : "No match" }));
		await readyPage();
		const first = await tool("search_messages", { query: "needle" });
		expect(first).toMatchObject({ items: [], hasMore: true });
		expect(typeof first.cursor).toBe("string");
		const last = await tool("search_messages", { query: "needle", cursor: first.cursor });
		expect(last.items.map((item: any) => item.subject)).toEqual(["Message 0"]);
		expect(last.hasMore).toBe(false);
	});

	it("iterates more than 100 drafts and wakes every due message without touching future snoozes", async () => {
		for (let i = 0; i < 120; i++) {
			await host.messages.put(`d${i}`, message(i, { status: "draft" }));
			await putMessage(ctx, `m${i}`, message(i, { status: "snoozed", snoozeUntil: "2026-01-02T00:00:00.000Z" }));
		}
		await putMessage(ctx, "future", message(500, { status: "snoozed", snoozeUntil: "2030-01-01T00:00:00.000Z" }));
		expect(await allRows(ctx.storage.messages, { where: { status: "draft" } })).toHaveLength(120);
		expect(await wakeSnoozed(ctx, "2026-02-01T00:00:00.000Z")).toBe(120);
		expect(await host.messages.get("m119")).toMatchObject({ status: "inbox", sortAt: "2026-02-01T00:00:00.000Z", snoozeUntil: null });
		expect(await host.messages.get("future")).toMatchObject({ status: "snoozed" });
		expect(await host.messages.get("d119")).toMatchObject({ status: "draft" });
	});

	it("retains dirty work when projection publication fails and repairs on the next request", async () => {
		await putMessage(ctx, "m0", message(0));
		vi.spyOn(ctx.storage.threads, "compareAndSet").mockRejectedValueOnce(new Error("D1 unavailable"));
		await expect(ensureMailboxIndex(ctx)).rejects.toThrow("D1 unavailable");
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ indexDirty: true });
		const page = await readyPage();
		expect(page.items[0]).toMatchObject({ messageCount: 1 });
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ indexDirty: false });
	});

	it("repairs both projections after reparenting fails between publication and dirty clearing", async () => {
		await putMessage(ctx, "m0", message(0));
		await readyPage();
		await mutateMessage(ctx, "m0", () => ({ threadId: "<new@example.com>" }));
		vi.spyOn(ctx.storage.searchDocuments, "compareAndSet").mockRejectedValueOnce(new Error("Interrupted"));
		await expect(ensureMailboxIndex(ctx)).rejects.toThrow("Interrupted");
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ indexDirty: true, indexPreviousThreadIds: ["<conversation@example.com>"] });
		const page = await readyPage();
		expect(page.items.map((item: any) => item.threadId)).toEqual(["<new@example.com>"]);
		expect(await ctx.storage.threads.get("<conversation@example.com>")).toBeNull();
	});

	it("backfills cross-page historical ancestry and defaults without migrating drafts", async () => {
		const child = message(1, { threadId: null, messageId: "<child@example.com>", bodyRaw: "In-Reply-To: <parent@example.com>\r\n\r\nChild" });
		delete (child as any).read; delete (child as any).sortAt; delete (child as any).snoozeUntil;
		await host.messages.put("child", child);
		for (let i = 2; i < 80; i++) await host.messages.put(`d${i}`, message(i, { status: "draft", threadId: null }));
		await host.messages.put("parent", message(0, { threadId: null, messageId: "<parent@example.com>" }));
		const initial = await tool("list_threads", {});
		expect(initial).toMatchObject({ items: [], hasMore: true, indexing: true });
		const page = await readyPage();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ threadId: "<parent@example.com>", messageCount: 2, unreadCount: 1 });
		expect(await host.messages.get("child")).toMatchObject({ read: true, sortAt: child.receivedAt, snoozeUntil: null });
		expect(await host.messages.get("d79")).toMatchObject({ status: "draft", threadId: null });
	});

	it.each(["wake", "pin"])("preserves historical reply ancestry when %s runs before backfill reaches the row", async (operation) => {
		await host.messages.put("parent", message(0, { threadId: null, messageId: "<parent@example.com>" }));
		for (let i = 1; i <= 60; i++) await host.messages.put(`d${i}`, message(i, { status: "draft", threadId: null }));
		await host.messages.put("child", message(61, {
			threadId: null, messageId: "<child@example.com>",
			bodyRaw: "In-Reply-To: <parent@example.com>\r\n\r\nReply",
			status: operation === "wake" ? "snoozed" : "inbox", snoozeUntil: operation === "wake" ? "2026-01-02T00:00:00.000Z" : null,
		}));
		expect(await ensureMailboxIndex(ctx)).toEqual({ complete: false });
		expect(await host.messages.get("child")).toMatchObject({ threadId: null });
		if (operation === "wake") expect(await wakeSnoozed(ctx, "2026-02-01T00:00:00.000Z")).toBe(1);
		else await mutateMessage(ctx, "child", () => ({ pinned: true }));
		const page = await readyPage();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ threadId: "<parent@example.com>", messageCount: 2, pinned: operation === "pin" });
		expect(await host.messages.get("child")).toMatchObject({ threadId: "<parent@example.com>", inReplyTo: "<parent@example.com>", status: "inbox" });
	});

	it("retries a stale projection scan after another worker publishes a newer source revision", async () => {
		await putMessage(ctx, "m0", message(0));
		await readyPage();
		await mutateMessage(ctx, "m0", () => ({ read: true }));
		const captured = deferred(); const release = deferred();
		const publish = ctx.storage.threads.compareAndSet.bind(ctx.storage.threads);
		let held = false;
		vi.spyOn(ctx.storage.threads, "compareAndSet").mockImplementation(async (...args: any[]) => {
			if (!held) { held = true; captured.resolve(); await release.promise; }
			return publish(...args);
		});
		const oldRepair = ensureMailboxIndex(ctx);
		await captured.promise;
		try {
			await mutateMessage(ctx, "m0", () => ({ read: false, subject: "Concurrent new subject", bodyText: "New searchable phrase" }));
			expect(await ensureMailboxIndex(ctx)).toEqual({ complete: true });
		} finally { release.resolve(); }
		await oldRepair;
		const page = await readyPage();
		expect(page.items[0]).toMatchObject({ unreadCount: 1, latest: { subject: "Concurrent new subject" } });
		expect((await tool("search_messages", { query: "new searchable" })).items).toHaveLength(1);
		expect((await tool("search_messages", { query: "Text 0" })).items).toHaveLength(0);
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ indexDirty: false });
	});

	it("a delayed dirty clear cannot overwrite a newer mutation or erase its repair work", async () => {
		await putMessage(ctx, "m0", message(0));
		const captured = deferred(); const release = deferred();
		const cas = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
		let held = false;
		vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (id: string, revision: string | null, value: any) => {
			if (!held && value.indexDirty === false) { held = true; captured.resolve(); await release.promise; }
			return cas(id, revision, value);
		});
		const older = ensureMailboxIndex(ctx);
		await captured.promise;
		try { await mutateMessage(ctx, "m0", () => ({ pinned: true, status: "done" })); }
		finally { release.resolve(); }
		expect(await older).toEqual({ complete: false });
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ pinned: true, status: "done", indexDirty: true });
		const done = await readyPage({ status: "done" });
		expect(done.items[0]).toMatchObject({ pinned: true });
		expect((await readyPage()).items).toHaveLength(0);
	});

	it("concurrent pin and read patches preserve both changes after a CAS conflict", async () => {
		await putMessage(ctx, "m0", message(0));
		const captured = deferred(); const release = deferred();
		const read = ctx.storage.messages.getVersioned.bind(ctx.storage.messages);
		let count = 0;
		vi.spyOn(ctx.storage.messages, "getVersioned").mockImplementation(async (id: string) => {
			const result = await read(id);
			if (id === "m0" && count++ < 2) { if (count === 2) captured.resolve(); await release.promise; }
			return result;
		});
		const writes = Promise.all([
			mutateMessage(ctx, "m0", () => ({ read: true })),
			mutateMessage(ctx, "m0", () => ({ pinned: true })),
		]);
		await captured.promise; release.resolve(); await writes;
		expect(await ctx.storage.messages.get("m0")).toMatchObject({ read: true, pinned: true, indexDirty: true });
	});

	it("replays a partially written migration page instead of advancing past a failed row", async () => {
		for (let i = 0; i < 30; i++) await host.messages.put(`m${i}`, message(i));
		const cas = ctx.storage.messages.compareAndSet.bind(ctx.storage.messages);
		let calls = 0;
		vi.spyOn(ctx.storage.messages, "compareAndSet").mockImplementation(async (...args: any[]) => {
			if (++calls === 3) throw new Error("Interrupted migration");
			return cas(...args);
		});
		await expect(ensureMailboxIndex(ctx)).rejects.toThrow("Interrupted migration");
		expect(await ctx.kv.get("state:mailbox-index:v1")).toBeNull();
		const page = await readyPage();
		expect(page.items[0]).toMatchObject({ messageCount: 30 });
		expect(await ctx.storage.messages.count({ indexDirty: true })).toBe(0);
	});

	it("pages equal timestamps, uses latest status, and orders pinned snoozes before wake time", async () => {
		const time = "2026-01-01T00:00:00.000Z";
		await putMessage(ctx, "a", message(0, { threadId: "a", receivedAt: time, sortAt: time, status: "snoozed", snoozeUntil: "2026-04-01T00:00:00.000Z", pinned: true }));
		await putMessage(ctx, "b", message(0, { threadId: "b", receivedAt: time, sortAt: time, status: "snoozed", snoozeUntil: "2026-03-01T00:00:00.000Z" }));
		await putMessage(ctx, "c", message(0, { threadId: "c", receivedAt: time, sortAt: time, status: "snoozed", snoozeUntil: "2026-02-01T00:00:00.000Z" }));
		await putMessage(ctx, "old", message(0, { threadId: "done", status: "inbox" }));
		await putMessage(ctx, "new", message(1, { threadId: "done", status: "done" }));
		const snoozed = await readyPage({ status: "snoozed" });
		expect(snoozed.items.map((item: any) => item.id)).toEqual(["a", "c", "b"]);
		expect((await readyPage()).items).toHaveLength(0);
		expect((await readyPage({ status: "done" })).items[0]).toMatchObject({ messageCount: 2 });
		const seen: string[] = []; let cursor: string | undefined;
		do { const page = await readyPage({ status: "all", limit: 1, cursor }); seen.push(...page.items.map((item: any) => item.id)); cursor = page.cursor; } while (cursor);
		expect(new Set(seen)).toEqual(new Set(["a", "b", "c", "done"]));
		expect(seen).toHaveLength(4);
	});

	it("exposes attachment message IDs while removing object keys, MIME, and index internals", async () => {
		await putMessage(ctx, "attachment-message", message(0, {
			rawObjectKey: "private/raw.eml",
			attachments: [{ id: "file-1", filename: "document.txt", mimeType: "text/plain", size: 3, sha256: "abc", disposition: "attachment", objectKey: "private/file-1" }],
		} as any));
		await readyPage();
		const thread = await tool("get_thread", { threadId: "<conversation@example.com>" });
		expect(thread[0]).toMatchObject({ id: "attachment-message", attachments: [{ id: "file-1", filename: "document.txt" }] });
		const search = await tool("search_messages", { query: "Text 0" });
		expect(search.items[0].id).toBe("attachment-message");
		for (const result of [thread, search, await readyPage()]) {
			const json = JSON.stringify(result);
			expect(json).not.toContain("private/");
			expect(json).not.toContain("private MIME");
			expect(json).not.toContain("indexDirty");
		}
	});

	it("removes obsolete transport credentials before completing the mailbox migration", async () => {
		await ctx.kv.set("settings:accountId", "old-account");
		await ctx.kv.set("settings:apiToken", "obsolete-secret");
		await readyPage();
		expect(await ctx.kv.get("settings:accountId")).toBeNull();
		expect(await ctx.kv.get("settings:apiToken")).toBeNull();
	});

	it("serves a prepared page without scanning mailbox message bodies", async () => {
		for (let i = 0; i < 60; i++) await putMessage(ctx, `m${i}`, message(i, { threadId: `<t${i}@example.com>` }));
		await readyPage();
		const query = ctx.storage.messages.query.bind(ctx.storage.messages);
		vi.spyOn(ctx.storage.messages, "query").mockImplementation(async (options: any) => {
			if (options?.where?.indexDirty !== true) throw new Error("Prepared listing scanned source messages");
			return query(options);
		});
		const page = await readyPage({ limit: 10 });
		expect(page.items).toHaveLength(10);
		expect(page.items[0].threadId).toBe("<t59@example.com>");
	});

	it("carries a pagination cursor through native MCP input validation and route dispatch", async () => {
		for (let i = 0; i < 120; i++) await putMessage(ctx, `m${i}`, message(i, { threadId: `<t${i}@example.com>` }));
		let result: any;
		for (let i = 0; i < 10; i++) {
			result = await host.request("mcp/list_threads", { limit: 2 });
			expect(result.success, JSON.stringify(result)).toBe(true);
			if (!result.data.indexing) break;
		}
		expect(result.data.items.map((item: any) => item.threadId)).toEqual(["<t119@example.com>", "<t118@example.com>"]);
		const next = await host.request("mcp/list_threads", { limit: 2, cursor: result.data.cursor });
		expect(next.success, JSON.stringify(next)).toBe(true);
		expect((next.data as any).items.map((item: any) => item.threadId)).toEqual(["<t117@example.com>", "<t116@example.com>"]);
		const invalid = await host.request("mcp/list_threads", { status: "done", cursor: result.data.cursor });
		expect(invalid.success).toBe(false);
		expect(invalid.status).toBe(400);
	});

	it("reads an authoritative complete thread while more than 100 projection repairs remain", async () => {
		for (let i = 0; i < 120; i++) await host.messages.put(`m${i}`, message(i));
		await readyPage();
		await tool("mark_read", { threadId: "<conversation@example.com>", read: true });
		expect(await ctx.storage.messages.count({ indexDirty: true })).toBe(120);
		const thread = await tool("get_thread", { threadId: "<conversation@example.com>" });
		expect(thread).toHaveLength(120);
		expect(thread.every((item: MessageDoc) => item.read)).toBe(true);
		expect(await ctx.storage.messages.count({ indexDirty: true })).toBe(120);
		await tool("pin_thread", { threadId: "<conversation@example.com>", pinned: true });
		expect(await host.messages.get("m119")).toMatchObject({ pinned: true });
		const page = await tool("list_threads", {});
		expect(page).toMatchObject({ items: [], hasMore: true, indexing: true });
	});

	it("folds complete thread projections in bounded pages and orders participants by message time", async () => {
		// Storage creation order deliberately opposes chronological message order.
		for (let i = 119; i >= 0; i--) await putMessage(ctx, `m${i}`, message(i, {
			from: i === 0 ? "oldest@example.com" : i === 1 ? "second@example.com" : "reader@example.com",
			read: i % 2 === 1, pinned: i === 0, status: i === 119 ? "done" : "inbox",
		}));
		const query = ctx.storage.messages.query.bind(ctx.storage.messages);
		vi.spyOn(ctx.storage.messages, "query").mockImplementation(async (options: any) => {
			if (options?.where?.threadId && (!options.limit || options.limit > 50 || options.orderBy)) {
				throw new Error("Projection read exceeded a 50-row source page");
			}
			return query(options);
		});
		const page = await readyPage({ status: "done" });
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({
			messageCount: 120, unreadCount: 60, pinned: true,
			openMessageId: "m119", latest: { subject: "Message 119" }, previous: { subject: "Message 118" },
		});
		expect(page.items[0].participants.map((person: any) => person.label)).toEqual(["oldest", "second", "reader"]);
	});
});
