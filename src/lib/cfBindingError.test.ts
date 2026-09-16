import { describe, it, expect } from "vitest";
import { wrapBindingError, DeliverError } from "./cfBindingError";

describe("wrapBindingError", () => {
	it("restores only documented pre-acceptance failures, never message-text guesses", () => {
		for (const code of ["E_SENDER_NOT_VERIFIED", "E_VALIDATION_ERROR", "E_RATE_LIMIT_EXCEEDED"]) {
			expect(wrapBindingError(Object.assign(new Error("rejected"), { code })).definitive).toBe(true);
		}
		for (const code of [undefined, "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR", "ETIMEDOUT"]) {
			expect(wrapBindingError(Object.assign(new Error("sender not verified after timeout"), { code })).definitive).toBe(false);
		}
		expect(wrapBindingError({ code: "E_CONTENT_TOO_LARGE" }).definitive).toBe(true);
	});
	it("preserves operator-actionable message for sender-not-verified", () => {
		const err = Object.assign(new Error("Sender domain not verified"), { code: "SENDER_NOT_VERIFIED" });
		const wrapped = wrapBindingError(err);
		expect(wrapped).toBeInstanceOf(DeliverError);
		expect(wrapped.message).toMatch(/sender domain/i);
		expect(wrapped.message).toMatch(/verified/i);
	});

	it("preserves operator-actionable message for missing-binding", () => {
		const err = new Error("EMAIL binding missing or malformed");
		const wrapped = wrapBindingError(err);
		expect(wrapped).toBeInstanceOf(DeliverError);
		expect(wrapped.message).toMatch(/wrangler/i);
	});

	it("falls back to generic DeliverError with original message for unknown errors", () => {
		const err = new Error("something exploded");
		const wrapped = wrapBindingError(err);
		expect(wrapped).toBeInstanceOf(DeliverError);
		expect(wrapped.message).toContain("something exploded");
	});

	it("handles non-Error throws (string, undefined)", () => {
		const wrapped = wrapBindingError("plain string error");
		expect(wrapped).toBeInstanceOf(DeliverError);
		expect(wrapped.message).toContain("plain string error");

		const wrappedUndef = wrapBindingError(undefined);
		expect(wrappedUndef).toBeInstanceOf(DeliverError);
	});

	it("passes an existing DeliverError through unchanged", () => {
		const original = new DeliverError("already classified");
		const wrapped = wrapBindingError(original);
		expect(wrapped).toBe(original);
	});
});
