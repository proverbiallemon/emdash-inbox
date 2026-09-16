import { describe, expect, it } from "vitest";
import { normalizeMessageId, replyReferences } from "./messageIdentity";

describe("delivered identity and reply headers", () => {
	it("normalizes full provider IDs without inventing a domain for opaque IDs", () => {
		expect(normalizeMessageId("delivery@example.com")).toBe("<delivery@example.com>");
		expect(normalizeMessageId("<delivery@example.com>")).toBe("<delivery@example.com>");
		expect(normalizeMessageId("opaque-id")).toBeNull();
		expect(normalizeMessageId(undefined)).toBeNull();
	});
	it("rejects injected headers and preserves the valid ancestor order", () => {
		expect(normalizeMessageId("<id@example.com>\r\nBcc: hidden@example.com")).toBeNull();
		expect(replyReferences(["<root@example.com>", "<root@example.com>", "invalid"], "<parent@example.com>"))
			.toEqual(["<root@example.com>", "<parent@example.com>"]);
	});
	it("bounds the References header while retaining the direct parent", () => {
		const refs = replyReferences(["<parent@example.com>", ...Array.from({ length: 200 }, (_, i) => `<ancestor-${i}@example.com>`)], "<parent@example.com>");
		expect(refs.join(" ").length).toBeLessThanOrEqual(2048);
		expect(refs.at(-1)).toBe("<parent@example.com>");
	});
});
