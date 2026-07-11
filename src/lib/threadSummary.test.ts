import { describe, it, expect } from "vitest";
import { aggregateThreads, isDraftRow } from "./threadSummary";
import type { MessageDoc } from "../index";

const SENDER = "PocketBear@harildkyler.com";

function row(id: string, data: Partial<MessageDoc>) {
	return {
		id,
		data: {
			messageId: `<${id}@example.com>`,
			direction: "inbound" as const,
			from: "alice@example.com",
			to: SENDER,
			subject: "Hi",
			bodyText: "body",
			bodyHtml: null,
			bodyRaw: null,
			threadId: `<${id}@example.com>`,
			receivedAt: "2026-04-22T10:00:00.000Z",
			source: "inbound",
			status: "inbox" as const,
			pinned: false,
			bundleId: null,
			sortAt: "2026-04-22T10:00:00.000Z",
			snoozeUntil: null,
			inReplyTo: null,
			read: false,
			...data,
		} as MessageDoc,
	};
}

describe("aggregateThreads", () => {
	it("single-message thread: messageCount 1, previous null, messageIds=[id]", () => {
		const result = aggregateThreads([row("a", {})], "inbox", SENDER);
		expect(result).toHaveLength(1);
		expect(result[0].messageCount).toBe(1);
		expect(result[0].previous).toBeNull();
		expect(result[0].messageIds).toEqual(["a"]);
	});

	it("3-message thread: previous set to second-latest", () => {
		const tid = "<root@example.com>";
		const result = aggregateThreads(
			[
				row("a", { threadId: tid, receivedAt: "2026-04-22T10:00:00.000Z", subject: "first" }),
				row("b", { threadId: tid, receivedAt: "2026-04-22T11:00:00.000Z", subject: "second" }),
				row("c", { threadId: tid, receivedAt: "2026-04-22T12:00:00.000Z", subject: "third" }),
			],
			"inbox",
			SENDER,
		);
		expect(result).toHaveLength(1);
		expect(result[0].messageCount).toBe(3);
		expect(result[0].latest.subject).toBe("third");
		expect(result[0].previous?.subject).toBe("second");
	});

	it("unreadCount counts messages with read: false", () => {
		const tid = "<u@example.com>";
		const result = aggregateThreads(
			[
				row("a", { threadId: tid, read: true } as Partial<MessageDoc>),
				row("b", { threadId: tid, read: false } as Partial<MessageDoc>),
				row("c", { threadId: tid, read: false } as Partial<MessageDoc>),
			],
			"inbox",
			SENDER,
		);
		expect(result[0].unreadCount).toBe(2);
	});

	it("mixed-status thread (latest=inbox) appears in inbox tab, absent from done", () => {
		const tid = "<m@example.com>";
		const messages = [
			row("a", { threadId: tid, status: "done", receivedAt: "2026-04-22T10:00:00.000Z" }),
			row("b", { threadId: tid, status: "inbox", receivedAt: "2026-04-22T11:00:00.000Z" }),
		];
		expect(aggregateThreads(messages, "inbox", SENDER)).toHaveLength(1);
		expect(aggregateThreads(messages, "done", SENDER)).toHaveLength(0);
	});

	it("mixed-status thread (latest=done) appears in done tab, absent from inbox", () => {
		const tid = "<m@example.com>";
		const messages = [
			row("a", { threadId: tid, status: "inbox", receivedAt: "2026-04-22T10:00:00.000Z" }),
			row("b", { threadId: tid, status: "done", receivedAt: "2026-04-22T11:00:00.000Z" }),
		];
		expect(aggregateThreads(messages, "done", SENDER)).toHaveLength(1);
		expect(aggregateThreads(messages, "inbox", SENDER)).toHaveLength(0);
	});

	it("3 threads sort by latest sortAt descending", () => {
		const result = aggregateThreads(
			[
				row("a", { threadId: "<a@x>", sortAt: "2026-04-22T08:00:00.000Z" }),
				row("b", { threadId: "<b@x>", sortAt: "2026-04-22T12:00:00.000Z" }),
				row("c", { threadId: "<c@x>", sortAt: "2026-04-22T10:00:00.000Z" }),
			],
			"inbox",
			SENDER,
		);
		expect(result.map((s) => s.id)).toEqual(["<b@x>", "<c@x>", "<a@x>"]);
	});

	it("pinned thread floats to top within filter window", () => {
		const result = aggregateThreads(
			[
				row("a", { threadId: "<a@x>", sortAt: "2026-04-22T12:00:00.000Z", pinned: false }),
				row("b", { threadId: "<b@x>", sortAt: "2026-04-22T08:00:00.000Z", pinned: true }),
			],
			"inbox",
			SENDER,
		);
		expect(result[0].id).toBe("<b@x>");
	});

	it("snoozed tab sorts by snoozeUntil ascending", () => {
		const result = aggregateThreads(
			[
				row("a", { threadId: "<a@x>", status: "snoozed", snoozeUntil: "2026-04-25T00:00:00.000Z" }),
				row("b", { threadId: "<b@x>", status: "snoozed", snoozeUntil: "2026-04-23T00:00:00.000Z" }),
				row("c", { threadId: "<c@x>", status: "snoozed", snoozeUntil: "2026-04-24T00:00:00.000Z" }),
			],
			"snoozed",
			SENDER,
		);
		expect(result.map((s) => s.id)).toEqual(["<b@x>", "<c@x>", "<a@x>"]);
	});

	it("filter 'all' returns every thread regardless of status", () => {
		const result = aggregateThreads(
			[
				row("a", { threadId: "<a@x>", status: "inbox" }),
				row("b", { threadId: "<b@x>", status: "done" }),
				row("c", { threadId: "<c@x>", status: "snoozed", snoozeUntil: "2026-04-23T00:00:00.000Z" }),
			],
			"all",
			SENDER,
		);
		expect(result).toHaveLength(3);
	});

	it("empty messages → empty result", () => {
		expect(aggregateThreads([], "inbox", SENDER)).toEqual([]);
	});
});

describe("draft exclusion (M8)", () => {
	it("drafts never appear in thread summaries, any filter", () => {
		const rows = [
			row("m1", { status: "inbox", threadId: "t1", receivedAt: "2026-07-01T00:00:00Z" }),
			row("d1", { status: "draft", threadId: "t1", receivedAt: "2026-07-02T00:00:00Z", direction: "outbound" }),
		];
		for (const filter of ["inbox", "snoozed", "done", "all"] as const) {
			const out = aggregateThreads(rows, filter, SENDER);
			for (const summary of out) {
				expect(summary.messageIds).not.toContain("d1");
			}
		}
	});

	it("a draft does not become the thread's latest message", () => {
		const rows = [
			row("m1", { status: "inbox", threadId: "t1", receivedAt: "2026-07-01T00:00:00Z", subject: "real" }),
			row("d1", { status: "draft", threadId: "t1", receivedAt: "2026-07-09T00:00:00Z", subject: "draft", direction: "outbound" }),
		];
		const out = aggregateThreads(rows, "inbox", SENDER);
		expect(out).toHaveLength(1);
		expect(out[0].latest.subject).toBe("real");
	});

	it("a thread consisting only of drafts produces no summary", () => {
		const rows = [
			row("d1", { status: "draft", threadId: "t9", receivedAt: "2026-07-09T00:00:00Z", direction: "outbound" }),
		];
		expect(aggregateThreads(rows, "all", SENDER)).toHaveLength(0);
	});
});

describe("isDraftRow", () => {
	it("is true for a row with status draft", () => {
		expect(isDraftRow(row("d1", { status: "draft" }))).toBe(true);
	});

	it("is false for non-draft statuses", () => {
		for (const status of ["inbox", "snoozed", "done", "archived"] as const) {
			expect(isDraftRow(row("m1", { status }))).toBe(false);
		}
	});

	it("accepts any row shape with a data.status field, not just full MessageDoc rows", () => {
		expect(isDraftRow({ data: { status: "draft" } })).toBe(true);
		expect(isDraftRow({ data: { status: "inbox" } })).toBe(false);
	});
});
