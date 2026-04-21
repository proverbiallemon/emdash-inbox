import { describe, it, expect } from "vitest";
import { resolveSnoozePreset, SNOOZE_PRESETS } from "./snoozePresets";

describe("resolveSnoozePreset", () => {
	// Mon 2026-04-20T14:00:00 local
	const NOW = new Date(2026, 3, 20, 14, 0, 0);

	it("laterToday = now + 3h", () => {
		const iso = resolveSnoozePreset("laterToday", NOW);
		expect(new Date(iso).getTime()).toBe(NOW.getTime() + 3 * 60 * 60 * 1000);
	});

	it("tomorrow9am = next local 9:00", () => {
		const iso = resolveSnoozePreset("tomorrow9am", NOW);
		const d = new Date(iso);
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(3);
		expect(d.getDate()).toBe(21); // Tue
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
	});

	it("nextWeekMon9am = next Monday 9am, skipping current Monday", () => {
		// NOW is already Monday, so nextMon is 7 days later (2026-04-27)
		const iso = resolveSnoozePreset("nextWeekMon9am", NOW);
		const d = new Date(iso);
		expect(d.getDay()).toBe(1); // Monday
		expect(d.getHours()).toBe(9);
		expect(d.getDate()).toBe(27);
	});

	it("debug1min = now + 60s (only reachable when caller opts in)", () => {
		const iso = resolveSnoozePreset("debug1min", NOW);
		expect(new Date(iso).getTime()).toBe(NOW.getTime() + 60_000);
	});

	it("exposes preset list in display order", () => {
		expect(SNOOZE_PRESETS.map((p) => p.id)).toEqual([
			"laterToday",
			"tomorrow9am",
			"nextWeekMon9am",
		]);
	});
});
