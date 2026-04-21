import { describe, it, expect } from "vitest";
import { validateTransition } from "./statusTransitions";

describe("validateTransition", () => {
	const future = new Date(Date.now() + 60_000).toISOString();
	const past = new Date(Date.now() - 60_000).toISOString();

	it("allows inbox -> done without snoozeUntil", () => {
		expect(validateTransition("inbox", "done")).toEqual({ ok: true });
	});

	it("allows inbox -> snoozed with a future snoozeUntil", () => {
		expect(validateTransition("inbox", "snoozed", future)).toEqual({ ok: true });
	});

	it("rejects snoozed transition with past snoozeUntil", () => {
		const res = validateTransition("inbox", "snoozed", past);
		if (res.ok) throw new Error("expected failure");
		expect(res.error).toMatch(/future/i);
	});

	it("rejects snoozed transition with no snoozeUntil", () => {
		const res = validateTransition("inbox", "snoozed");
		if (res.ok) throw new Error("expected failure");
		expect(res.error).toMatch(/snoozeUntil/i);
	});

	it("rejects snoozed transition with invalid ISO", () => {
		const res = validateTransition("inbox", "snoozed", "not-a-date");
		if (res.ok) throw new Error("expected failure");
		expect(res.error).toMatch(/iso/i);
	});

	it("rejects inbox transition with extraneous snoozeUntil", () => {
		const res = validateTransition("snoozed", "inbox", future);
		if (res.ok) throw new Error("expected failure");
		expect(res.error).toMatch(/snoozeUntil/i);
	});

	it("rejects done transition with extraneous snoozeUntil", () => {
		const res = validateTransition("inbox", "done", future);
		expect(res.ok).toBe(false);
	});

	it("rejects transition to archived (unused in M3)", () => {
		const res = validateTransition("inbox", "archived" as any);
		expect(res.ok).toBe(false);
	});

	it("allows snoozed -> inbox (user wakes early)", () => {
		expect(validateTransition("snoozed", "inbox")).toEqual({ ok: true });
	});

	it("allows done -> inbox (user unmarks)", () => {
		expect(validateTransition("done", "inbox")).toEqual({ ok: true });
	});
});
