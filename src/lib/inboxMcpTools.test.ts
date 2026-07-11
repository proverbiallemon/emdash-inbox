import { describe, it, expect } from "vitest";
import { listInboxTools, type InboxToolName } from "./inboxMcpTools";

describe("listInboxTools", () => {
	it("exposes the M7 tool catalog by name", () => {
		const tools = listInboxTools();
		const names = tools.map((t) => t.name);
		const expected: InboxToolName[] = [
			"list_threads",
			"get_thread",
			"search_messages",
			"mark_read",
			"pin_thread",
			"snooze_thread",
			"mark_done",
		];
		for (const name of expected) {
			expect(names).toContain(name);
		}
	});

	it("every tool has a non-empty description", () => {
		for (const tool of listInboxTools()) {
			expect(tool.description.length).toBeGreaterThan(20);
		}
	});

	it("every tool has a zod schema for inputs", () => {
		for (const tool of listInboxTools()) {
			expect(tool.inputSchema).toBeDefined();
			// zod schemas have a `parse` method
			expect(typeof (tool.inputSchema as { parse?: unknown }).parse).toBe("function");
		}
	});

	it("list_threads accepts optional status filter", () => {
		const tool = listInboxTools().find((t) => t.name === "list_threads")!;
		expect(() => tool.inputSchema.parse({})).not.toThrow();
		expect(() => tool.inputSchema.parse({ status: "inbox" })).not.toThrow();
		expect(() => tool.inputSchema.parse({ status: "invalid" })).toThrow();
		expect(() => tool.inputSchema.parse({ status: "archived" })).toThrow();
	});

	it("snooze_thread requires both threadId and until", () => {
		const tool = listInboxTools().find((t) => t.name === "snooze_thread")!;
		expect(() => tool.inputSchema.parse({})).toThrow();
		expect(() => tool.inputSchema.parse({ threadId: "abc" })).toThrow();
		expect(() => tool.inputSchema.parse({ threadId: "abc", until: "2026-05-20T09:00:00Z" })).not.toThrow();
	});
});

describe("M8 compose/draft tools", () => {
	const tool = (name: string) => listInboxTools().find((t) => t.name === name)!;

	it("catalog has 14 tools", () => {
		expect(listInboxTools()).toHaveLength(14);
	});

	it("compose_email accepts string or array recipients", () => {
		const s = tool("compose_email").inputSchema;
		expect(s.safeParse({ to: "a@example.com", subject: "s", text: "t" }).success).toBe(true);
		expect(s.safeParse({ to: ["a@example.com"], cc: "b@example.com", subject: "s", text: "t" }).success).toBe(true);
		expect(s.safeParse({ subject: "s", text: "t" }).success).toBe(false);
	});

	it("reply_to_thread defaults quoteOriginal to true", () => {
		const parsed = tool("reply_to_thread").inputSchema.safeParse({ threadId: "t", text: "hi" });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect((parsed.data as { quoteOriginal: boolean }).quoteOriginal).toBe(true);
	});

	it("reply_all_to_thread requires threadId and text", () => {
		expect(tool("reply_all_to_thread").inputSchema.safeParse({ threadId: "t" }).success).toBe(false);
	});

	it("save_draft allows a fully empty body besides optional fields", () => {
		expect(tool("save_draft").inputSchema.safeParse({}).success).toBe(true);
	});

	it("send_draft requires draftId, edits optional", () => {
		const s = tool("send_draft").inputSchema;
		expect(s.safeParse({ draftId: "d" }).success).toBe(true);
		expect(s.safeParse({ draftId: "d", edits: { subject: "new" } }).success).toBe(true);
		expect(s.safeParse({}).success).toBe(false);
	});

	it("discard_draft requires draftId", () => {
		expect(tool("discard_draft").inputSchema.safeParse({}).success).toBe(false);
	});

	it("list_drafts accepts an empty object", () => {
		expect(tool("list_drafts").inputSchema.safeParse({}).success).toBe(true);
	});
});
