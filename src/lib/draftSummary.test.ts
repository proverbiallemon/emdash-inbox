import { describe, expect, it } from "vitest";
import { draftSummaryOf } from "./draftSummary";
import type { MessageDoc } from "../index";

function draftDoc(overrides: Partial<MessageDoc>): MessageDoc {
	return {
		messageId: "<draft-x@local>",
		direction: "outbound",
		from: "me@mysite.com",
		to: "a@example.com",
		subject: "Hi",
		bodyText: "hello world",
		bodyHtml: null,
		bodyRaw: null,
		threadId: null,
		receivedAt: "2026-07-11T00:00:00Z",
		source: "emdash-inbox:draft",
		status: "draft",
		pinned: false,
		read: true,
		bundleId: null,
		sortAt: "2026-07-11T00:00:00Z",
		snoozeUntil: null,
		inReplyTo: null,
		...overrides,
	};
}

describe("draftSummaryOf", () => {
	it("maps id, recipients, subject, snippet, updatedAt", () => {
		const s = draftSummaryOf({ id: "d1", data: draftDoc({ toAll: ["a@example.com", "b@example.com"] }) });
		expect(s).toEqual({
			id: "d1",
			to: ["a@example.com", "b@example.com"],
			subject: "Hi",
			snippet: "hello world",
			updatedAt: "2026-07-11T00:00:00Z",
			threadId: null,
		});
	});

	it("labels empty subjects", () => {
		expect(draftSummaryOf({ id: "d", data: draftDoc({ subject: "  " }) }).subject).toBe("(no subject)");
	});

	it("falls back to legacy to and tolerates empty", () => {
		expect(draftSummaryOf({ id: "d", data: draftDoc({ to: "" }) }).to).toEqual([]);
	});

	it("collapses whitespace and truncates the snippet to 120 chars", () => {
		const long = "x".repeat(300);
		const s = draftSummaryOf({ id: "d", data: draftDoc({ bodyText: `a\n\n b ${long}` }) });
		expect(s.snippet.startsWith("a b x")).toBe(true);
		expect(s.snippet.length).toBe(120);
	});
});
