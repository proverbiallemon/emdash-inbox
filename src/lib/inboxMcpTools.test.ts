import { describe, it, expect } from "vitest";
import { listInboxTools, type InboxToolName } from "./inboxMcpTools";

describe("listInboxTools", () => {
	it("exposes the M7 tool catalog by name", () => {
		const tools = listInboxTools();
		const names = tools.map((t) => t.name).sort();
		const expected: InboxToolName[] = [
			"list_threads",
			"get_thread",
			"search_messages",
			"mark_read",
			"pin_thread",
			"snooze_thread",
			"mark_done",
		];
		expect(names).toEqual(expected.sort());
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
