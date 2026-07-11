import { describe, expect, it } from "vitest";
import { deriveReplyAll, normalizeRecipients } from "./recipients";

describe("normalizeRecipients", () => {
	it("accepts a single address string", () => {
		expect(normalizeRecipients("a@example.com")).toEqual({ ok: true, value: ["a@example.com"] });
	});

	it("splits comma-separated strings and trims whitespace", () => {
		expect(normalizeRecipients(" a@example.com , b@example.com ")).toEqual({
			ok: true,
			value: ["a@example.com", "b@example.com"],
		});
	});

	it("accepts an array of addresses", () => {
		expect(normalizeRecipients(["a@example.com", "b@example.com"])).toEqual({
			ok: true,
			value: ["a@example.com", "b@example.com"],
		});
	});

	it("dedupes case-insensitively, keeping the first casing seen", () => {
		expect(normalizeRecipients(["A@Example.com", "a@example.com"])).toEqual({
			ok: true,
			value: ["A@Example.com"],
		});
	});

	it("returns ok:true with empty array for undefined", () => {
		expect(normalizeRecipients(undefined)).toEqual({ ok: true, value: [] });
	});

	it("returns ok:true with empty array for an empty string", () => {
		expect(normalizeRecipients("")).toEqual({ ok: true, value: [] });
	});

	it("names the offending address in the error", () => {
		const res = normalizeRecipients(["a@example.com", "not-an-email"]);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("not-an-email");
	});

	it("rejects arrays containing non-strings", () => {
		const res = normalizeRecipients([42] as unknown as string[]);
		expect(res.ok).toBe(false);
	});
});

describe("deriveReplyAll", () => {
	const inbound = {
		direction: "inbound" as const,
		from: "alice@example.com",
		to: "me@mysite.com",
		toAll: ["me@mysite.com", "bob@example.com"],
		cc: ["carol@example.com"],
	};

	it("puts the sender in to and everyone else in cc, minus my address", () => {
		expect(deriveReplyAll(inbound, "me@mysite.com")).toEqual({
			to: ["alice@example.com"],
			cc: ["bob@example.com", "carol@example.com"],
		});
	});

	it("excludes my address case-insensitively", () => {
		expect(deriveReplyAll(inbound, "ME@MySite.com").cc).toEqual([
			"bob@example.com",
			"carol@example.com",
		]);
	});

	it("falls back to legacy to when toAll is absent", () => {
		const legacy = { ...inbound, toAll: undefined };
		expect(deriveReplyAll(legacy, "me@mysite.com")).toEqual({
			to: ["alice@example.com"],
			cc: ["carol@example.com"],
		});
	});

	it("dedupes an address that appears in both to and cc", () => {
		const dup = { ...inbound, cc: ["bob@example.com"] };
		expect(deriveReplyAll(dup, "me@mysite.com")).toEqual({
			to: ["alice@example.com"],
			cc: ["bob@example.com"],
		});
	});

	it("never returns the sender in cc", () => {
		const echo = { ...inbound, cc: ["alice@example.com"] };
		expect(deriveReplyAll(echo, "me@mysite.com")).toEqual({
			to: ["alice@example.com"],
			cc: ["bob@example.com"],
		});
	});

	it("with empty senderAddress, filters nothing", () => {
		expect(deriveReplyAll(inbound, "").cc).toEqual([
			"me@mysite.com",
			"bob@example.com",
			"carol@example.com",
		]);
	});
});
