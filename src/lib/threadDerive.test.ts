import { describe, it, expect } from "vitest";
import { deriveThreadInfo } from "./threadDerive";

type ParentRow = { messageId: string; threadId: string | null };

function makeLookup(parents: ParentRow[]): (msgId: string) => ParentRow | null {
	const map = new Map(parents.map((p) => [p.messageId, p]));
	return (msgId) => map.get(msgId) ?? null;
}

describe("deriveThreadInfo", () => {
	const SELF = "<self@example.com>";

	it("treats a message with no inReplyTo and no references as a thread root", () => {
		const r = deriveThreadInfo(SELF, null, [], makeLookup([]));
		expect(r).toEqual({ threadId: SELF, inReplyTo: null });
	});

	it("inherits threadId when inReplyTo resolves", () => {
		const parent = { messageId: "<p@x>", threadId: "<t@x>" };
		const r = deriveThreadInfo(SELF, "<p@x>", [], makeLookup([parent]));
		expect(r).toEqual({ threadId: "<t@x>", inReplyTo: "<p@x>" });
	});

	it("falls back to parent.messageId when parent.threadId is null (backfill-race safety)", () => {
		const parent = { messageId: "<p@x>", threadId: null };
		const r = deriveThreadInfo(SELF, "<p@x>", [], makeLookup([parent]));
		expect(r).toEqual({ threadId: "<p@x>", inReplyTo: "<p@x>" });
	});

	it("walks references right-to-left when inReplyTo misses", () => {
		const oldest = { messageId: "<a@x>", threadId: "<t@x>" };
		const middle = { messageId: "<b@x>", threadId: "<t@x>" };
		const r = deriveThreadInfo(
			SELF,
			"<nonexistent@x>",
			["<a@x>", "<b@x>"],
			makeLookup([oldest, middle]),
		);
		// Walks right-to-left; finds <b@x> first. threadId inherited; stored inReplyTo stays as the original header claim.
		expect(r).toEqual({ threadId: "<t@x>", inReplyTo: "<nonexistent@x>" });
	});

	it("walks references even when inReplyTo is null", () => {
		const parent = { messageId: "<a@x>", threadId: "<t@x>" };
		const r = deriveThreadInfo(SELF, null, ["<a@x>"], makeLookup([parent]));
		expect(r).toEqual({ threadId: "<t@x>", inReplyTo: "<a@x>" });
	});

	it("preserves inReplyTo even when nothing resolves (for orphan retry)", () => {
		const r = deriveThreadInfo(SELF, "<p@x>", [], makeLookup([]));
		expect(r).toEqual({ threadId: SELF, inReplyTo: "<p@x>" });
	});

	it("returns self as thread root with null inReplyTo when no headers and no references", () => {
		const r = deriveThreadInfo(SELF, null, [], makeLookup([]));
		expect(r.threadId).toBe(SELF);
		expect(r.inReplyTo).toBeNull();
	});
});
