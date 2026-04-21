import { describe, it, expect } from "vitest";
import { bucketize } from "./bucketize";

// Fixed reference time: Thu 2026-04-23T14:00:00 LOCAL.
// Constructed with new Date(y, m, d, h) so buckets are keyed off the same
// timezone the UI component will use (bucketize runs client-side).
const NOW = new Date(2026, 3, 23, 14, 0, 0);

function row(id: string, d: Date) {
	return { id, data: { sortAt: d.toISOString() } };
}

describe("bucketize (past direction)", () => {
	it("groups today/yesterday/thisWeek/older correctly", () => {
		const rows = [
			row("a", new Date(2026, 3, 23, 10, 0, 0)), // today
			row("b", new Date(2026, 3, 22, 18, 0, 0)), // yesterday
			row("c", new Date(2026, 3, 20, 12, 0, 0)), // this week
			row("d", new Date(2026, 3, 10, 12, 0, 0)), // older
		];
		const result = bucketize(rows, "sortAt", NOW, "past");
		expect(result.today.map((r) => r.id)).toEqual(["a"]);
		expect(result.yesterday.map((r) => r.id)).toEqual(["b"]);
		expect(result.thisWeek.map((r) => r.id)).toEqual(["c"]);
		expect(result.older.map((r) => r.id)).toEqual(["d"]);
	});

	it("keeps the sort order of the input within each bucket", () => {
		const rows = [
			row("today-late", new Date(2026, 3, 23, 13, 0, 0)),
			row("today-early", new Date(2026, 3, 23, 1, 0, 0)),
		];
		const result = bucketize(rows, "sortAt", NOW, "past");
		expect(result.today.map((r) => r.id)).toEqual(["today-late", "today-early"]);
	});

	it("excludes rows far in the future from every bucket (no garbage bucket)", () => {
		const rows = [row("future", new Date(2027, 0, 1, 0, 0, 0))];
		const result = bucketize(rows, "sortAt", NOW, "past");
		expect(result.today).toHaveLength(0);
		expect(result.yesterday).toHaveLength(0);
		expect(result.thisWeek).toHaveLength(0);
		expect(result.older).toHaveLength(0);
	});
});

describe("bucketize (future direction, for Snoozed tab)", () => {
	it("treats 'yesterday' as tomorrow, keeps labels stable", () => {
		const rows = [
			row("tomorrow", new Date(2026, 3, 24, 10, 0, 0)),
			row("today", new Date(2026, 3, 23, 20, 0, 0)),
			row("next-few-days", new Date(2026, 3, 27, 9, 0, 0)),
			row("far-future", new Date(2026, 4, 20, 9, 0, 0)),
		];
		const result = bucketize(rows, "sortAt", NOW, "future");
		expect(result.today.map((r) => r.id)).toEqual(["today"]);
		expect(result.yesterday.map((r) => r.id)).toEqual(["tomorrow"]);
		expect(result.thisWeek.map((r) => r.id)).toEqual(["next-few-days"]);
		expect(result.older.map((r) => r.id)).toEqual(["far-future"]);
	});
});
